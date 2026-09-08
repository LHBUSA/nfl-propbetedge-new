/* nfl-odds — the single NFL odds provider authority for PropBetEdge.
 *
 *   THE ODDS API  →  scheduled ingest (3×/day ET)  →  normalize  →  KV snapshot
 *                                                                     ↓
 *                       /api/odds · /api/odds/board · /api/odds/events · /api/odds/props
 *
 * The provider is contacted ONLY by `ingest()`, which runs from the cron
 * trigger (08:00 / 13:00 / 18:00 America/New_York, timezone-safe) or from the
 * protected manual route. Every GET a user can cause reads the persisted
 * snapshot in KV and never reaches the provider. One user and ten thousand
 * users spend the same credits: zero.
 *
 * Reads expose honest freshness: semantics LAST_VERIFIED_MARKET, captured_at,
 * age_seconds, batch_id, and the status of the most recent ingest attempt so
 * a surface can say "LATEST INGEST UNAVAILABLE" when a scheduled run failed.
 *
 * Secrets: ODDS_API_KEY (provider), ODDS_ADMIN_TOKEN (manual ingest). Neither
 * is ever echoed in a response or a log line.
 */

const VERSION = 'v3.0.0-snapshot';
const PROVIDER = 'https://api.the-odds-api.com/v4';
const SPORT_KEYS = { regular: 'americanfootball_nfl', preseason: 'americanfootball_nfl_preseason' };
const FEATURED_MARKETS = new Set(['h2h', 'spreads', 'totals']);
const PLAYER_MARKETS = new Set([
  'player_pass_yds', 'player_pass_completions', 'player_pass_attempts', 'player_pass_tds', 'player_pass_interceptions',
  'player_pass_longest_completion', 'player_receptions', 'player_reception_yds', 'player_reception_tds',
  'player_reception_longest', 'player_rush_yds', 'player_rush_attempts', 'player_rush_tds', 'player_rush_longest',
  'player_anytime_td', 'player_1st_td', 'player_sacks', 'player_defensive_interceptions',
]);
/* Ingest policy defaults; each can be overridden with a wrangler [vars] entry. */
const DEFAULT_INGEST_HOURS_ET = [8, 13, 18];
const DEFAULT_PROP_WINDOW_DAYS = 7;
const DEFAULT_PROP_MARKETS = Array.from(PLAYER_MARKETS);
const READ_CACHE_SECONDS = 60;               // our HTTP cache; expiry never spends credits
const KV = {
  meta: 'odds:v1:meta',
  featured: 'odds:v1:featured:regular',
  eventPrefix: 'odds:v1:event:',
  index: 'odds:v1:board-index',
  attempt: 'odds:v1:ingest:last-attempt',
  batches: 'odds:v1:batches',
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

/* ------------------------------------------------------------------ utils */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extraHeaders } });
}
function readJson(data, status = 200) {
  return json(data, status, { 'Cache-Control': status === 200 ? `public, max-age=${READ_CACHE_SECONDS}` : 'no-store' });
}
function splitMarkets(value) { return String(value || '').split(',').map((x) => x.trim()).filter(Boolean); }
function validateMarkets(requested, allowed) { const invalid = requested.filter((x) => !allowed.has(x)); return { ok: invalid.length === 0, invalid }; }
function leagueFrom(url) { return (url.searchParams.get('league') || 'regular').toLowerCase() === 'preseason' ? 'preseason' : 'regular'; }
function safeUsage(headers) {
  return { remaining: headers.get('x-requests-remaining'), used: headers.get('x-requests-used'), last_cost: headers.get('x-requests-last') };
}
function listVar(value, fallback) { const v = splitMarkets(value); return v.length ? v : fallback; }
function intVar(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function hoursVar(value, fallback) { const v = splitMarkets(value).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 24); return v.length ? v : fallback; }
function policy(env) {
  return {
    hours_et: hoursVar(env?.INGEST_HOURS_ET, DEFAULT_INGEST_HOURS_ET),
    prop_window_days: intVar(env?.INGEST_PROP_WINDOW_DAYS, DEFAULT_PROP_WINDOW_DAYS),
    prop_markets: listVar(env?.INGEST_PLAYER_MARKETS, DEFAULT_PROP_MARKETS).filter((m) => PLAYER_MARKETS.has(m)),
    timezone: 'America/New_York',
  };
}
/* The hour in New York for an instant, whatever DST is doing. Cloudflare crons
   are UTC, so the trigger fires at every UTC hour that can be 08/13/18 ET and
   this decides which firing is real. */
export function etHour(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  return h === 24 ? 0 : h;
}
export function etLabel(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date) + ' ET';
}
function latestBookUpdate(events) {
  let latest = null;
  for (const event of events || []) for (const book of event.bookmakers || []) {
    if (book.last_update && (!latest || book.last_update > latest)) latest = book.last_update;
    for (const market of book.markets || []) if (market.last_update && (!latest || market.last_update > latest)) latest = market.last_update;
  }
  return latest;
}
function normalizeEvents(events) {
  return (events || []).map((event) => ({
    id: event.id, sport_key: event.sport_key, commence_time: event.commence_time, home_team: event.home_team, away_team: event.away_team,
    bookmakers: (event.bookmakers || []).map((book) => ({
      key: book.key, title: book.title, last_update: book.last_update,
      markets: (book.markets || []).map((market) => ({
        key: market.key, last_update: market.last_update,
        outcomes: (market.outcomes || []).map((o) => ({ name: o.name, description: o.description || null, price: o.price, point: o.point === undefined ? null : o.point })),
      })),
    })),
  }));
}
function filterEventMarkets(event, markets) {
  const want = new Set(markets);
  return {
    ...event,
    bookmakers: (event.bookmakers || []).map((b) => ({ ...b, markets: (b.markets || []).filter((m) => want.has(m.key)) })).filter((b) => b.markets.length),
  };
}
function americanToImplied(price) {
  const n = Number(price); if (!Number.isFinite(n) || n === 0) return null;
  return Number((n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100)).toFixed(6));
}
function median(values) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null; const m = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[m] : Number(((nums[m - 1] + nums[m]) / 2).toFixed(2));
}
export function flattenPropQuotes(event) {
  const quotes = [];
  for (const book of event?.bookmakers || []) for (const market of book.markets || []) for (const outcome of market.outcomes || []) {
    const player = outcome.description || null, direction = outcome.name || null;
    if (!player || !direction) continue;
    quotes.push({
      event_id: event.id, commence_time: event.commence_time, away_team: event.away_team, home_team: event.home_team,
      player, market: market.key, direction: String(direction).toUpperCase(), point: outcome.point === undefined ? null : outcome.point,
      price: outcome.price, implied_probability: americanToImplied(outcome.price), book_key: book.key, book: book.title,
      last_update: market.last_update || book.last_update || null,
    });
  }
  return quotes;
}
function summarizePropMarkets(quotes) {
  const groups = new Map();
  for (const q of quotes) { const k = `${q.player}|${q.market}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(q); }
  const out = [];
  for (const [key, rows] of groups) {
    const [player, market] = key.split('|');
    const points = rows.map((r) => r.point).filter((v) => v !== null);
    const overs = rows.filter((r) => r.direction === 'OVER' && r.point !== null), unders = rows.filter((r) => r.direction === 'UNDER' && r.point !== null);
    const books = Array.from(new Set(rows.map((r) => r.book)));
    out.push({ player, market, consensus_line: median(points),
      lowest_over_line: overs.length ? Math.min(...overs.map((r) => Number(r.point))) : null,
      highest_under_line: unders.length ? Math.max(...unders.map((r) => Number(r.point))) : null,
      line_low: points.length ? Math.min(...points.map(Number)) : null, line_high: points.length ? Math.max(...points.map(Number)) : null,
      book_count: books.length, books });
  }
  return out.sort((a, b) => a.player.localeCompare(b.player) || a.market.localeCompare(b.market));
}
function bestPricesAtSameLine(quotes) {
  const groups = new Map();
  for (const q of quotes) { const k = [q.player, q.market, q.direction, q.point].join('|'); const e = groups.get(k); if (!e || Number(q.price) > Number(e.price)) groups.set(k, q); }
  return Array.from(groups.values()).sort((a, b) => a.player.localeCompare(b.player) || a.market.localeCompare(b.market) || String(a.direction).localeCompare(String(b.direction)) || Number(a.point || 0) - Number(b.point || 0));
}

/* --------------------------------------------------------------- provider */
async function providerFetch(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'PropBetEdge-NFL/3.0' } });
  let body; try { body = await response.json(); } catch { body = null; }
  return { response, body };
}
/* What a failed provider call may tell a caller: the provider's own error
   class and usage counters. Never the request URL, never the key. */
function providerFailure(response, body) {
  const code = body && typeof body === 'object' && typeof body.error_code === 'string' ? body.error_code : null;
  return {
    provider_status: response.status, provider_error_code: code,
    provider_error_class: code === 'OUT_OF_USAGE_CREDITS' ? 'QUOTA' : code === 'INVALID_KEY' ? 'SECRET' : response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER',
    usage: safeUsage(response.headers),
  };
}
function providerUrl(env, path, params) {
  const u = new URL(`${PROVIDER}${path}`);
  u.searchParams.set('apiKey', env.ODDS_API_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/* ----------------------------------------------------------------- ingest */
/** Snapshot metadata everyone reads: what was captured, when, by what, and
    what it cost. Never contains a secret. */
function batchId(now, trigger) { return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${trigger}`; }

export async function ingest(env, { trigger = 'cron', now = new Date() } = {}) {
  const started = Date.now();
  const p = policy(env);
  const attempt = { started_at: now.toISOString(), trigger, status: 'running' };
  await env.NFL_KV.put(KV.attempt, JSON.stringify(attempt));
  try {
    /* 1. featured slate: one request, cost = 3 markets × 1 region */
    const sport = SPORT_KEYS.regular;
    const featuredReq = await providerFetch(providerUrl(env, `/sports/${sport}/odds`, { regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'american', dateFormat: 'iso' }));
    if (!featuredReq.response.ok) {
      const failure = providerFailure(featuredReq.response, featuredReq.body);
      const failed = { ...attempt, status: 'failed', finished_at: new Date().toISOString(), step: 'featured', ...failure };
      await env.NFL_KV.put(KV.attempt, JSON.stringify(failed));
      return failed;
    }
    const events = normalizeEvents(Array.isArray(featuredReq.body) ? featuredReq.body : []);
    let usage = safeUsage(featuredReq.response.headers);
    let credits = Number(usage.last_cost) || 0;

    /* 2. player markets for events inside the prop window: one request per
          event, cost = requested markets × 1 region */
    const nowMs = now.getTime();
    const windowEnd = nowMs + p.prop_window_days * 86400000;
    const inWindow = events.filter((e) => { const t = Date.parse(e.commence_time); return Number.isFinite(t) && t >= nowMs - 6 * 3600000 && t <= windowEnd; });
    const index = []; const boardFailures = [];
    const marketsParam = p.prop_markets.join(',');
    const CONCURRENCY = 4;
    for (let i = 0; i < inWindow.length; i += CONCURRENCY) {
      await Promise.all(inWindow.slice(i, i + CONCURRENCY).map(async (e) => {
        const r = await providerFetch(providerUrl(env, `/sports/${sport}/events/${encodeURIComponent(e.id)}/odds`, { regions: 'us', markets: marketsParam, oddsFormat: 'american', dateFormat: 'iso' }));
        if (!r.response.ok) { boardFailures.push({ event_id: e.id, ...providerFailure(r.response, r.body) }); return; }
        usage = safeUsage(r.response.headers);
        credits += Number(usage.last_cost) || 0;
        const ev = normalizeEvents(r.body ? [r.body] : [])[0] || { ...e, bookmakers: [] };
        const captured = new Set(); for (const b of ev.bookmakers || []) for (const m of b.markets || []) captured.add(m.key);
        const quoteCount = flattenPropQuotes(ev).length;
        await env.NFL_KV.put(KV.eventPrefix + e.id, JSON.stringify({ event: ev, markets_requested: p.prop_markets, markets_captured: Array.from(captured), quote_count: quoteCount, provider_last_update: latestBookUpdate([ev]) }));
        index.push({ id: e.id, commence_time: e.commence_time, away_team: e.away_team, home_team: e.home_team, markets_captured: Array.from(captured), quote_count: quoteCount });
      }));
    }
    index.sort((a, b) => String(a.commence_time).localeCompare(String(b.commence_time)));

    /* 3. persist one verified batch */
    const capturedAt = new Date().toISOString();
    const meta = {
      batch_id: batchId(now, trigger), version: VERSION, trigger, captured_at: capturedAt, captured_at_et: etLabel(new Date(capturedAt)),
      /* the trigger time of the attempt that produced this batch; freshness()
         compares a later failed attempt against this, not against captured_at */
      attempt_started_at: attempt.started_at,
      provider: 'the_odds_api', provider_last_update: latestBookUpdate(events), sport_key: sport,
      counts: { events: events.length, boards: index.length, boards_failed: boardFailures.length, board_quotes: index.reduce((n, x) => n + x.quote_count, 0) },
      window: { prop_window_days: p.prop_window_days, from: new Date(nowMs - 6 * 3600000).toISOString(), to: new Date(windowEnd).toISOString() },
      player_markets: p.prop_markets, credits_spent: credits, usage, duration_ms: Date.now() - started,
    };
    await env.NFL_KV.put(KV.featured, JSON.stringify({ league: 'regular', sport_key: sport, markets: Array.from(FEATURED_MARKETS), count: events.length, events, provider_last_update: meta.provider_last_update }));
    await env.NFL_KV.put(KV.index, JSON.stringify(index));
    await env.NFL_KV.put(KV.meta, JSON.stringify(meta));
    const status = boardFailures.length && boardFailures.length === inWindow.length && inWindow.length ? 'partial' : boardFailures.length ? 'partial' : 'ok';
    const done = { ...attempt, status, finished_at: capturedAt, batch_id: meta.batch_id, credits_spent: credits, usage, boards_failed: boardFailures.slice(0, 5) };
    await env.NFL_KV.put(KV.attempt, JSON.stringify(done));
    let batches = []; try { batches = (await env.NFL_KV.get(KV.batches, 'json')) || []; } catch { batches = []; }
    batches.unshift({ batch_id: meta.batch_id, captured_at: capturedAt, trigger, status, credits_spent: credits, counts: meta.counts });
    await env.NFL_KV.put(KV.batches, JSON.stringify(batches.slice(0, 60)));
    return done;
  } catch (error) {
    const failed = { ...attempt, status: 'failed', finished_at: new Date().toISOString(), step: 'exception', error: error instanceof Error ? error.message : String(error) };
    await env.NFL_KV.put(KV.attempt, JSON.stringify(failed));
    return failed;
  }
}

/* ------------------------------------------------------------------ reads */
async function kvJson(env, key) { return env.NFL_KV.get(key, { type: 'json', cacheTtl: READ_CACHE_SECONDS }); }
async function freshness(env, now = new Date()) {
  const [meta, attempt] = await Promise.all([kvJson(env, KV.meta), kvJson(env, KV.attempt)]);
  if (!meta) return null;
  const ageSeconds = Math.max(0, Math.round((now.getTime() - Date.parse(meta.captured_at)) / 1000));
  /* Is the newest attempt a failure that came after the batch we are serving?
     Compare attempt start against attempt start. captured_at is stamped from
     the wall clock when the batch finished writing, while started_at comes from
     the trigger's `now`, so comparing the two mixed those clocks and a failed
     attempt could read as OK -- the batch stayed correct, the reporting did
     not. meta.attempt_started_at is written by the successful ingest from the
     same `now`, so both sides of this comparison share one source. Batches
     written before that field existed fall back to the old basis. */
  const lastSuccessStartedAt = meta.attempt_started_at || meta.captured_at;
  const latestFailed = Boolean(attempt) && attempt.status === 'failed'
    && Date.parse(attempt.started_at) >= Date.parse(lastSuccessStartedAt);
  return {
    semantics: 'LAST_VERIFIED_MARKET',
    batch_id: meta.batch_id, captured_at: meta.captured_at, captured_at_et: meta.captured_at_et,
    age_seconds: ageSeconds, age_hours: Number((ageSeconds / 3600).toFixed(2)),
    provider_last_update: meta.provider_last_update,
    ingest: {
      status: latestFailed ? 'LATEST_INGEST_UNAVAILABLE' : 'OK',
      last_success_at: meta.captured_at, last_attempt_at: attempt?.started_at || meta.captured_at,
      last_attempt_status: attempt?.status || 'ok', last_error_class: latestFailed ? (attempt.provider_error_class || attempt.step || 'PROVIDER') : null,
    },
    source: { provider: 'the_odds_api', semantics: 'MARKET_SNAPSHOT', region: 'us', odds_format: 'american', authority: 'nfl-odds scheduled ingest', read_path: 'kv-snapshot' },
    cache: 'snapshot',
  };
}
function noSnapshot(extra = {}) {
  return json({ error: 'No verified market snapshot has been ingested yet', semantics: 'UNAVAILABLE', hint: 'run the scheduled or manual ingest', ...extra }, 503);
}

async function getFeatured(env, url) {
  const league = leagueFrom(url);
  const markets = splitMarkets(url.searchParams.get('markets') || 'h2h,spreads,totals');
  const v = validateMarkets(markets, FEATURED_MARKETS);
  if (!v.ok) return json({ error: 'Unsupported featured market', invalid_markets: v.invalid, allowed_markets: Array.from(FEATURED_MARKETS) }, 400);
  if (league !== 'regular') return json({ error: 'League not carried by the market snapshot', league, semantics: 'UNAVAILABLE' }, 404);
  const [fresh, stored] = await Promise.all([freshness(env), kvJson(env, KV.featured)]);
  if (!fresh || !stored) return noSnapshot();
  const events = markets.length === FEATURED_MARKETS.size ? stored.events : stored.events.map((e) => filterEventMarkets(e, markets));
  return readJson({ league, sport_key: stored.sport_key, markets, count: events.length, events, ...fresh, generated_at: new Date().toISOString() });
}
async function getEvents(env, url) {
  const league = leagueFrom(url);
  if (league !== 'regular') return json({ error: 'League not carried by the market snapshot', league, semantics: 'UNAVAILABLE' }, 404);
  const [fresh, stored] = await Promise.all([freshness(env), kvJson(env, KV.featured)]);
  if (!fresh || !stored) return noSnapshot();
  const events = stored.events.map((e) => ({ id: e.id, sport_key: e.sport_key, commence_time: e.commence_time, home_team: e.home_team, away_team: e.away_team }));
  return readJson({ league, sport_key: stored.sport_key, count: events.length, events, ...fresh, generated_at: new Date().toISOString() });
}
async function loadEvent(env, eventId) {
  const stored = await kvJson(env, KV.eventPrefix + eventId);
  return stored && stored.event ? stored : null;
}
async function getProps(env, url) {
  const eventId = (url.searchParams.get('event_id') || url.searchParams.get('id') || '').trim();
  if (!eventId) return json({ error: 'event_id is required' }, 400);
  const markets = splitMarkets(url.searchParams.get('markets') || 'player_pass_yds');
  const v = validateMarkets(markets, PLAYER_MARKETS);
  if (!v.ok) return json({ error: 'Unsupported player prop market', invalid_markets: v.invalid, allowed_markets: Array.from(PLAYER_MARKETS) }, 400);
  const [fresh, stored] = await Promise.all([freshness(env), loadEvent(env, eventId)]);
  if (!fresh) return noSnapshot();
  if (!stored) return json({ error: 'Event not in the player-market snapshot window', event_id: eventId, ...fresh, semantics: 'UNAVAILABLE' }, 404);
  const event = filterEventMarkets(stored.event, markets);
  return readJson({ league: 'regular', sport_key: SPORT_KEYS.regular, event_id: eventId, markets, event, ...fresh, provider_last_update: stored.provider_last_update, generated_at: new Date().toISOString() });
}
async function getBoard(env, url) {
  const eventId = (url.searchParams.get('event_id') || url.searchParams.get('id') || '').trim();
  if (!eventId) return json({ error: 'event_id is required' }, 400);
  const markets = splitMarkets(url.searchParams.get('markets') || ['player_pass_yds', 'player_reception_yds', 'player_receptions', 'player_rush_yds'].join(','));
  if (markets.length > 8) return json({ error: 'Maximum 8 player markets per board request', requested: markets.length }, 400);
  const v = validateMarkets(markets, PLAYER_MARKETS);
  if (!v.ok) return json({ error: 'Unsupported player prop market', invalid_markets: v.invalid, allowed_markets: Array.from(PLAYER_MARKETS) }, 400);
  const [fresh, stored] = await Promise.all([freshness(env), loadEvent(env, eventId)]);
  if (!fresh) return noSnapshot();
  if (!stored) return json({ error: 'Event not in the player-market snapshot window', event_id: eventId, ...fresh, semantics: 'UNAVAILABLE' }, 404);
  const event = filterEventMarkets(stored.event, markets);
  const quotes = flattenPropQuotes(event);
  const captured = new Set(stored.markets_captured || []);
  const availability = Object.fromEntries(markets.map((m) => [m, captured.has(m) ? 'IN_SNAPSHOT' : (stored.markets_requested || []).includes(m) ? 'NOT_OFFERED_AT_INGEST' : 'NOT_REQUESTED_BY_INGEST']));
  return readJson({
    event: { id: stored.event.id, commence_time: stored.event.commence_time, away_team: stored.event.away_team, home_team: stored.event.home_team },
    markets, market_availability: availability, quote_count: quotes.length,
    player_market_count: summarizePropMarkets(quotes).length, quotes, market_summary: summarizePropMarkets(quotes), best_price_same_line: bestPricesAtSameLine(quotes),
    ...fresh,
    source: { ...fresh.source, normalization: 'PropBetEdge market normalization v1', implied_probability: 'raw bookmaker implied probability; not vig-free' },
    provider_last_update: stored.provider_last_update, generated_at: new Date().toISOString(),
  });
}
async function getSnapshot(env) {
  const [fresh, index, batches] = await Promise.all([freshness(env), kvJson(env, KV.index), kvJson(env, KV.batches)]);
  if (!fresh) return noSnapshot();
  const meta = await kvJson(env, KV.meta);
  return readJson({ ...fresh, policy: policy(env), counts: meta?.counts, window: meta?.window, player_markets: meta?.player_markets, credits_spent_last_ingest: meta?.credits_spent, usage_at_last_ingest: meta?.usage, boards: index || [], recent_batches: batches || [] });
}

/* ------------------------------------------------------------ admin route */
function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function manualIngest(request, env) {
  if (!env.ODDS_ADMIN_TOKEN) return json({ error: 'Manual ingest is not configured on this worker' }, 503);
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !timingSafeEqual(token, env.ODDS_ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
  if (!env.ODDS_API_KEY) return json({ error: 'Odds provider not configured', semantics: 'UNAVAILABLE' }, 503);
  const result = await ingest(env, { trigger: 'manual' });
  return json({ ok: result.status !== 'failed', ...result }, result.status === 'failed' ? 502 : 200);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith('/health')) {
      const fresh = await freshness(env).catch(() => null);
      return json({
        status: 'ok', service: 'nfl-odds', version: VERSION, provider: 'the_odds_api', configured: Boolean(env.ODDS_API_KEY), manual_ingest_configured: Boolean(env.ODDS_ADMIN_TOKEN),
        sport_keys: SPORT_KEYS, featured_markets: Array.from(FEATURED_MARKETS), player_markets: Array.from(PLAYER_MARKETS),
        semantics: fresh ? 'LAST_VERIFIED_MARKET' : 'UNAVAILABLE', read_path: 'kv-snapshot', provider_calls_on_read: 0, ingest_policy: policy(env), snapshot: fresh, synthetic_fallback: false,
        generated_at: new Date().toISOString(),
      });
    }
    if (path.endsWith('/markets')) return json({ featured: Array.from(FEATURED_MARKETS), player_props: Array.from(PLAYER_MARKETS), synthetic_fallback: false });
    if (path.endsWith('/ingest')) { if (request.method !== 'POST') return json({ error: 'POST required' }, 405); return manualIngest(request, env); }
    if (path.endsWith('/snapshot')) return getSnapshot(env);
    if (path.includes('/board')) return getBoard(env, url);
    if (path.includes('/props')) return getProps(env, url);
    if (path.includes('/events')) return getEvents(env, url);
    if (path.includes('/odds')) return getFeatured(env, url);
    return json({ error: 'Unknown odds route', path }, 404);
  },
  /* Fires at every UTC hour that can be 08:00 / 13:00 / 18:00 in New York;
     only the firing whose New York hour is on the policy list ingests. */
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime || Date.now());
    const hour = etHour(now);
    if (!policy(env).hours_et.includes(hour)) { console.log(`[nfl-odds] cron ${event.cron} skipped: ${hour}:00 ET is not an ingest hour`); return; }
    ctx.waitUntil(ingest(env, { trigger: 'cron', now }).then((r) => console.log(`[nfl-odds] ingest ${r.status} batch=${r.batch_id || '-'} credits=${r.credits_spent ?? '-'}`)));
  },
};
