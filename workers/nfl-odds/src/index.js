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

const VERSION = 'v3.1.0-snapshot';
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
  /* LAST VERIFIED PLAYER MARKET, per event: every market's newest PRE-GAME
     capture that actually carried quotes. An ingest that finds a market
     missing never deletes its entry. */
  verifiedPrefix: 'odds:v1:props-verified:',
  coverage: 'odds:v1:props-coverage',
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

/* ------------------------------------------------ last verified player market
 *
 * Why this exists: the ingest used to overwrite one event record per run. A
 * book that pulls its player markets at kickoff, or a run that finds nothing
 * posted yet, then replaced a good pre-game board with an empty one.
 *
 * Rules:
 *   · only a capture received BEFORE kickoff can become verified, so an
 *     in-play price is never presented as a pre-game one
 *   · a capture replaces a market's entry only when it carries quotes for it
 *   · every entry keeps its own captured_at and batch_id; a read never stamps
 *     it with a newer batch's time
 */
const VERIFIED_RETENTION_SECONDS = 7 * 86400;          // after kickoff
const COVERAGE_RETENTION_MS = 12 * 3600000;            // started games stay listed this long

export function marketQuotes(event, market) { return flattenPropQuotes(filterEventMarkets(event, [market])); }

/** Fold one pre-game capture into the verified record. Pure. */
export function mergeVerified(previous, capture) {
  if (!capture?.pregame) return previous || null;       // an in-play capture never becomes pre-game truth
  const out = {
    event: capture.event_ref,
    markets: { ...(previous?.markets || {}) },
    updated_at: capture.captured_at,
    updated_batch_id: capture.batch_id,
  };
  for (const market of capture.markets_requested || []) {
    const quotes = marketQuotes(capture.event, market);
    if (!quotes.length) continue;                         // absence is not evidence; keep the last verified entry
    out.markets[market] = {
      market,
      quotes,
      books: Array.from(new Set(quotes.map((q) => q.book))).sort(),
      quote_count: quotes.length,
      provider_last_update: latestBookUpdate([filterEventMarkets(capture.event, [market])]),
      captured_at: capture.captured_at,
      batch_id: capture.batch_id,
    };
  }
  return out;
}

/* One row per game a reader can open in Player Props: which markets the
   newest capture carried and which have a retained pre-game entry, each with
   its own capture time. Reads never fan out per event to build it. */
function coverageEntry(e, verified, currentMarkets, currentCapturedAt) {
  const markets = verified?.markets || {};
  return {
    ...eventRef(e),
    current_markets: currentMarkets,
    current_captured_at: currentCapturedAt,
    verified_markets: Object.keys(markets).sort(),
    verified_captured_at: Object.fromEntries(Object.entries(markets).map(([m, v]) => [m, v.captured_at])),
  };
}
function eventRef(e) { return { id: e.id, commence_time: e.commence_time, away_team: e.away_team, home_team: e.home_team }; }
function verifiedExpiration(commenceTime, nowMs) {
  const k = Date.parse(commenceTime);
  const at = Math.floor(((Number.isFinite(k) ? k : nowMs) / 1000) + VERIFIED_RETENTION_SECONDS);
  return Math.max(at, Math.floor(nowMs / 1000) + 3600);
}

/* Records written before v3.1 carry no captured_at. One is still provably
   pre-game when the previous batch index listed it (so that batch wrote it)
   and both that batch's finish time and every book update in it precede
   kickoff. Only then is it promoted, stamped with THAT batch's time. */
export function legacyPregameCapture(stored, prevMeta, prevIndexEntry) {
  if (!stored?.event || stored.captured_at || !prevMeta?.captured_at || !prevIndexEntry) return null;
  const kickoff = Date.parse(stored.event.commence_time);
  const batchAt = Date.parse(prevMeta.captured_at);
  const lastUpdate = stored.provider_last_update ? Date.parse(stored.provider_last_update) : NaN;
  if (!Number.isFinite(kickoff) || !Number.isFinite(batchAt) || batchAt >= kickoff) return null;
  if (Number.isFinite(lastUpdate) && lastUpdate >= kickoff) return null;
  return {
    event: stored.event, event_ref: eventRef(stored.event), markets_requested: stored.markets_requested || [],
    captured_at: prevMeta.captured_at, batch_id: prevMeta.batch_id, pregame: true,
  };
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

    /* 2. player markets for events that have NOT kicked off and sit inside
          the prop window: one request per event, cost = requested markets ×
          1 region. A game already under way is not requested: its in-play
          prices can never be pre-game truth, and its last verified pre-game
          board is retained below instead of being overwritten. */
    const nowMs = now.getTime();
    const windowEnd = nowMs + p.prop_window_days * 86400000;
    const thisBatch = batchId(now, trigger);
    const inWindow = events.filter((e) => { const t = Date.parse(e.commence_time); return Number.isFinite(t) && t > nowMs && t <= windowEnd; });
    const index = []; const boardFailures = [];
    const marketsParam = p.prop_markets.join(',');
    const [prevMeta, prevIndex, prevCoverage] = await Promise.all([
      env.NFL_KV.get(KV.meta, 'json').catch(() => null),
      env.NFL_KV.get(KV.index, 'json').catch(() => null),
      env.NFL_KV.get(KV.coverage, 'json').catch(() => null),
    ]);
    const prevIndexById = new Map((Array.isArray(prevIndex) ? prevIndex : []).map((x) => [x.id, x]));
    const coverage = new Map();
    const CONCURRENCY = 4;
    for (let i = 0; i < inWindow.length; i += CONCURRENCY) {
      await Promise.all(inWindow.slice(i, i + CONCURRENCY).map(async (e) => {
        const r = await providerFetch(providerUrl(env, `/sports/${sport}/events/${encodeURIComponent(e.id)}/odds`, { regions: 'us', markets: marketsParam, oddsFormat: 'american', dateFormat: 'iso' }));
        /* `now` is the trigger instant; elapsed wall time moves it to the moment
           this response arrived without mixing clocks */
        const receivedAt = new Date(nowMs + (Date.now() - started));
        if (!r.response.ok) { boardFailures.push({ event_id: e.id, ...providerFailure(r.response, r.body) }); return; }
        usage = safeUsage(r.response.headers);
        credits += Number(usage.last_cost) || 0;
        const ev = normalizeEvents(r.body ? [r.body] : [])[0] || { ...e, bookmakers: [] };
        /* the response arrived after kickoff (a delayed request near 13:00):
           nothing in it is pre-game, so neither record is touched */
        const pregame = Date.parse(e.commence_time) > receivedAt.getTime();
        if (!pregame) return;
        const captured = new Set(); for (const b of ev.bookmakers || []) for (const m of b.markets || []) captured.add(m.key);
        const quoteCount = flattenPropQuotes(ev).length;
        const capturedAt = receivedAt.toISOString();
        let previous = await env.NFL_KV.get(KV.verifiedPrefix + e.id, 'json').catch(() => null);
        if (!previous) {
          /* first v3.1 run: keep what the previous batch provably captured
             pre-game, read BEFORE this capture overwrites the event record */
          const stored = await env.NFL_KV.get(KV.eventPrefix + e.id, 'json').catch(() => null);
          const legacy = legacyPregameCapture(stored, prevMeta, prevIndexById.get(e.id));
          previous = legacy ? mergeVerified(null, legacy) : null;
        }
        await env.NFL_KV.put(KV.eventPrefix + e.id, JSON.stringify({ event: ev, markets_requested: p.prop_markets, markets_captured: Array.from(captured), quote_count: quoteCount, provider_last_update: latestBookUpdate([ev]), captured_at: capturedAt, batch_id: thisBatch, captured_pregame: true }));
        const verified = mergeVerified(previous, { event: ev, event_ref: eventRef(e), markets_requested: p.prop_markets, captured_at: capturedAt, batch_id: thisBatch, pregame: true });
        if (verified) await env.NFL_KV.put(KV.verifiedPrefix + e.id, JSON.stringify(verified), { expiration: verifiedExpiration(e.commence_time, nowMs) });
        index.push({ id: e.id, commence_time: e.commence_time, away_team: e.away_team, home_team: e.home_team, markets_captured: Array.from(captured), quote_count: quoteCount, captured_at: capturedAt });
        coverage.set(e.id, coverageEntry(e, verified, Array.from(captured), capturedAt));
      }));
    }
    index.sort((a, b) => String(a.commence_time).localeCompare(String(b.commence_time)));

    /* 2b. games not re-requested (kicked off, or a failed board request) keep
           their last verified pre-game board. Promote a pre-v3.1 record the
           previous batch provably captured before kickoff, once. */
    const carry = new Map();
    for (const c of Array.isArray(prevCoverage) ? prevCoverage : []) carry.set(c.id, c);
    for (const x of prevIndexById.values()) if (!carry.has(x.id)) carry.set(x.id, { id: x.id, commence_time: x.commence_time, away_team: x.away_team, home_team: x.home_team });
    for (const c of carry.values()) {
      if (coverage.has(c.id)) continue;
      const kickoff = Date.parse(c.commence_time);
      if (!Number.isFinite(kickoff) || kickoff < nowMs - COVERAGE_RETENTION_MS) continue;
      let verified = await env.NFL_KV.get(KV.verifiedPrefix + c.id, 'json').catch(() => null);
      if (!verified) {
        const stored = await env.NFL_KV.get(KV.eventPrefix + c.id, 'json').catch(() => null);
        const legacy = legacyPregameCapture(stored, prevMeta, prevIndexById.get(c.id));
        if (legacy) {
          verified = mergeVerified(null, legacy);
          if (verified) await env.NFL_KV.put(KV.verifiedPrefix + c.id, JSON.stringify(verified), { expiration: verifiedExpiration(c.commence_time, nowMs) });
        }
      }
      if (verified && Object.keys(verified.markets || {}).length) coverage.set(c.id, coverageEntry(c, verified, [], null));
    }

    /* 3. persist one verified batch */
    const capturedAt = new Date().toISOString();
    const meta = {
      batch_id: thisBatch, version: VERSION, trigger, captured_at: capturedAt, captured_at_et: etLabel(new Date(capturedAt)),
      /* the trigger time of the attempt that produced this batch; freshness()
         compares a later failed attempt against this, not against captured_at */
      attempt_started_at: attempt.started_at,
      provider: 'the_odds_api', provider_last_update: latestBookUpdate(events), sport_key: sport,
      counts: { events: events.length, boards: index.length, boards_failed: boardFailures.length, board_quotes: index.reduce((n, x) => n + x.quote_count, 0), boards_retained_pregame: Array.from(coverage.values()).filter((c) => !c.current_captured_at).length },
      window: { prop_window_days: p.prop_window_days, from: new Date(nowMs - 6 * 3600000).toISOString(), to: new Date(windowEnd).toISOString() },
      player_markets: p.prop_markets, credits_spent: credits, usage, duration_ms: Date.now() - started,
    };
    await env.NFL_KV.put(KV.featured, JSON.stringify({ league: 'regular', sport_key: sport, markets: Array.from(FEATURED_MARKETS), count: events.length, events, provider_last_update: meta.provider_last_update }));
    await env.NFL_KV.put(KV.index, JSON.stringify(index));
    await env.NFL_KV.put(KV.coverage, JSON.stringify(Array.from(coverage.values()).sort((a, b) => String(a.commence_time).localeCompare(String(b.commence_time)))));
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
  /* the event record's own capture time; a pre-v3.1 record has none recorded */
  return readJson({ league: 'regular', sport_key: SPORT_KEYS.regular, event_id: eventId, markets, event, ...fresh, captured_at: stored.captured_at || null, capture_batch_id: stored.batch_id || null, snapshot_captured_at: fresh.captured_at, provider_last_update: stored.provider_last_update, generated_at: new Date().toISOString() });
}
/* Market availability on a board read:
 *   IN_SNAPSHOT                     in the newest pre-game capture of a game that has not kicked off
 *   LAST_VERIFIED_PREGAME_SNAPSHOT  served from the retained pre-game entry: the newest capture
 *                                   omitted the market, or the game has kicked off
 *   NOT_OFFERED_AT_INGEST           requested by every ingest, never captured before kickoff
 *   NOT_REQUESTED_BY_INGEST         outside the ingest's market list
 * Each served market names its own captured_at and batch_id. */
export const AVAILABILITY = Object.freeze({
  current: 'IN_SNAPSHOT', verified: 'LAST_VERIFIED_PREGAME_SNAPSHOT', never: 'NOT_OFFERED_AT_INGEST', notRequested: 'NOT_REQUESTED_BY_INGEST',
});

/** Pure board resolution, exported for the regression suite. */
export function resolveBoard({ stored, verified, markets, nowMs, meta, prevIndex = null, requestedMarkets = DEFAULT_PROP_MARKETS }) {
  const ref = stored?.event || verified?.event;
  const kickoff = Date.parse(ref?.commence_time || '');
  const started = Number.isFinite(kickoff) && kickoff <= nowMs;
  const requested = new Set(stored?.markets_requested || requestedMarkets);
  /* a pre-v3.1 record has no captured_at: the batch index proves which batch wrote it */
  const inPrevIndex = Array.isArray(prevIndex) && prevIndex.some((x) => x.id === ref?.id);
  const legacyAt = stored && !stored.captured_at && inPrevIndex ? meta?.captured_at || null : null;
  const legacyBatch = stored && !stored.captured_at && inPrevIndex ? meta?.batch_id || null : null;
  const legacyPregame = legacyAt && Date.parse(legacyAt) < kickoff
    && !(stored.provider_last_update && Date.parse(stored.provider_last_update) >= kickoff);
  const quotes = []; const availability = {}; const provenance = {};
  for (const m of markets) {
    const current = stored ? marketQuotes(stored.event, m) : [];
    const currentAt = stored?.captured_at || legacyAt;
    const currentIsPregame = stored?.captured_pregame === true || legacyPregame;
    const kept = verified?.markets?.[m];
    let chosen = null;
    if (current.length && currentAt && currentIsPregame && !started) {
      chosen = { semantics: AVAILABILITY.current, quotes: current, captured_at: currentAt, batch_id: stored.batch_id || legacyBatch, provider_last_update: latestBookUpdate([filterEventMarkets(stored.event, [m])]) };
    } else if (kept?.quotes?.length) {
      chosen = { semantics: AVAILABILITY.verified, quotes: kept.quotes, captured_at: kept.captured_at, batch_id: kept.batch_id, provider_last_update: kept.provider_last_update };
    } else if (started && current.length && currentAt && legacyPregame) {
      chosen = { semantics: AVAILABILITY.verified, quotes: current, captured_at: currentAt, batch_id: legacyBatch, provider_last_update: latestBookUpdate([filterEventMarkets(stored.event, [m])]) };
    }
    if (chosen) {
      availability[m] = chosen.semantics;
      provenance[m] = { semantics: chosen.semantics, captured_at: chosen.captured_at, captured_at_et: chosen.captured_at ? etLabel(new Date(chosen.captured_at)) : null, batch_id: chosen.batch_id || null, provider_last_update: chosen.provider_last_update || null, books: Array.from(new Set(chosen.quotes.map((q) => q.book))).sort(), quote_count: chosen.quotes.length };
      for (const q of chosen.quotes) quotes.push({ ...q, captured_at: chosen.captured_at, batch_id: chosen.batch_id || null, snapshot_semantics: chosen.semantics });
    } else {
      availability[m] = requested.has(m) ? AVAILABILITY.never : AVAILABILITY.notRequested;
      provenance[m] = { semantics: availability[m], captured_at: null, captured_at_et: null, batch_id: null, provider_last_update: null, books: [], quote_count: 0 };
    }
  }
  /* The board-level time is the OLDEST served capture, so a consumer that reads
     one timestamp can never take a retained market for a fresh one. */
  const servedTimes = Object.values(provenance).map((x) => x.captured_at).filter(Boolean).sort();
  return {
    event: ref ? { id: ref.id, commence_time: ref.commence_time, away_team: ref.away_team, home_team: ref.home_team, started, state: started ? 'KICKED_OFF' : 'PRE_GAME' } : null,
    started, quotes, market_availability: availability, market_provenance: provenance,
    captured_at: servedTimes[0] || stored?.captured_at || legacyAt || null,
  };
}

async function getBoard(env, url) {
  const eventId = (url.searchParams.get('event_id') || url.searchParams.get('id') || '').trim();
  if (!eventId) return json({ error: 'event_id is required' }, 400);
  const markets = splitMarkets(url.searchParams.get('markets') || ['player_pass_yds', 'player_reception_yds', 'player_receptions', 'player_rush_yds'].join(','));
  if (markets.length > 8) return json({ error: 'Maximum 8 player markets per board request', requested: markets.length }, 400);
  const v = validateMarkets(markets, PLAYER_MARKETS);
  if (!v.ok) return json({ error: 'Unsupported player prop market', invalid_markets: v.invalid, allowed_markets: Array.from(PLAYER_MARKETS) }, 400);
  const now = new Date();
  const [fresh, stored, verified, meta, index] = await Promise.all([freshness(env, now), loadEvent(env, eventId), kvJson(env, KV.verifiedPrefix + eventId), kvJson(env, KV.meta), kvJson(env, KV.index)]);
  if (!fresh) return noSnapshot();
  if (!stored && !verified) return json({ error: 'Event not in the player-market snapshot window', event_id: eventId, ...fresh, semantics: 'UNAVAILABLE' }, 404);
  const board = resolveBoard({ stored, verified, markets, nowMs: now.getTime(), meta, prevIndex: index, requestedMarkets: policy(env).prop_markets });
  const summary = summarizePropMarkets(board.quotes);
  const ageSeconds = board.captured_at ? Math.max(0, Math.round((now.getTime() - Date.parse(board.captured_at)) / 1000)) : fresh.age_seconds;
  return readJson({
    event: board.event,
    markets, market_availability: board.market_availability, market_provenance: board.market_provenance, quote_count: board.quotes.length,
    player_market_count: summary.length, quotes: board.quotes, market_summary: summary, best_price_same_line: bestPricesAtSameLine(board.quotes),
    ...fresh,
    price_semantics: board.started ? 'KICKED_OFF_PREGAME_SNAPSHOT_NOT_LIVE' : 'SCHEDULED_SNAPSHOT_NOT_LIVE',
    captured_at: board.captured_at, captured_at_et: board.captured_at ? etLabel(new Date(board.captured_at)) : null,
    age_seconds: ageSeconds, age_hours: Number((ageSeconds / 3600).toFixed(2)),
    snapshot_batch_id: fresh.batch_id, snapshot_captured_at: fresh.captured_at,
    source: { ...fresh.source, normalization: 'PropBetEdge market normalization v1', implied_probability: 'raw bookmaker implied probability; not vig-free' },
    provider_last_update: stored?.provider_last_update || null, generated_at: now.toISOString(),
  });
}

async function getPropCoverage(env) {
  const now = Date.now();
  const [fresh, coverage] = await Promise.all([freshness(env), kvJson(env, KV.coverage)]);
  if (!fresh) return noSnapshot();
  const events = (Array.isArray(coverage) ? coverage : []).map((c) => {
    const kickoff = Date.parse(c.commence_time);
    return { ...c, started: Number.isFinite(kickoff) && kickoff <= now, has_player_props: Boolean((c.current_markets || []).length || (c.verified_markets || []).length) };
  });
  return readJson({ semantics: 'PLAYER_PROP_COVERAGE', batch_id: fresh.batch_id, captured_at: fresh.captured_at, ingest: fresh.ingest, count: events.length, events, generated_at: new Date(now).toISOString() });
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
    if (path.endsWith('/prop-coverage')) return getPropCoverage(env);
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
