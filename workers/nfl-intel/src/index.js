/* nfl-intel — What Changed and Best Line, owned by Cloudflare.
 *
 *   GET  /api/changes?window_hours=48   sourced changes + game availability
 *   GET  /api/best-line?days=8&event=   price shopping over the market snapshot
 *   GET  /api/intel/health              lane health from the durable run ledger
 *   POST /api/intel/run?lane=…          manual lane run (Bearer INTEL_ADMIN_TOKEN)
 *
 * Reads never touch a provider: they compose what the scheduled lanes already
 * persisted in KV, plus nfl-current's game state and nfl-odds' snapshot through
 * service bindings. The cron (every 10 min) runs three lanes:
 *
 *   injuries  ESPN core API -> league report + ledger seed      (src/injuries.js)
 *   market    new nfl-odds batch -> consensus history           (src/market.js)
 *   weather   NWS + Open-Meteo per game, every 30 min          (src/weather.js)
 *
 * Truth contract carried over unchanged from the Vercel prototype this
 * replaces: every change names its source and the source's time; "UPDATED",
 * never "CHANGED FROM"; an unavailable source is reported with its reason;
 * best price / consensus / PBE fair value / model edge stay separate, and fair
 * value and edge are null unless a model publishes them.
 */
import {
  gamesFromCurrent, teamGameIndex, gameStatusChanges, parseInjuryReport,
  recentInjuryChanges, availabilityByGame, marketMoves, rankChanges, MARKET_THRESHOLDS
} from './changes-core.js';
import { summarizeEvent, bookLeaderboard } from './bestline-core.js';
import { ingestInjuries, KV_KEYS } from './injuries.js';
import { captureMarket, recentRows } from './market.js';
import { refreshWeather, WX_KEY, WX_MAX_AGE_MS } from './weather.js';
import { nflverseCode, nflverseGameId } from '../../nfl-picks-engine-shared/current-slate.mjs';

const VERSION = 'nfl-intel/1.0.0';
const INJURY_STALE_MS = 30 * 60000;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

/* An absent query parameter is absent, not zero: Number(null) is 0 and 0 is
   finite, so a bare Number.isFinite guard turned a missing window into the
   minimum window. */
export function intParam(url, name, fallback, lo, hi) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
}

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': status === 200 && maxAge ? `public, max-age=${maxAge}` : 'no-store', 'x-pbe-runtime': VERSION }
  });
}

async function currentGames(env) {
  const r = await env.NFL_CURRENT.fetch(new Request('https://nfl-current.internal/api/current-games', { headers: { accept: 'application/json' } }));
  if (!r.ok) throw new Error(`nfl_current_${r.status}`);
  const body = await r.json();
  if (!body?.ok || !Array.isArray(body.games)) throw new Error('nfl_current_unavailable');
  return body;
}

/* ---- run ledger (durable; isolate memory is not evidence a cron ran) ----- */
async function recordRun(env, lane, result, startedAt) {
  const row = { lane, at: new Date().toISOString(), started_at: new Date(startedAt).toISOString(), ms: Date.now() - startedAt, ...result };
  await env.INTEL_KV.put(`run:intel:${lane}`, JSON.stringify(row));
  return row;
}
async function runLane(env, lane, fn) {
  const t = Date.now();
  try { return await recordRun(env, lane, await fn(), t); }
  catch (e) { return recordRun(env, lane, { ok: false, status: 'error', error: String(e?.message || e) }, t); }
}

async function runAll(env, { force = false } = {}) {
  const t = Date.now();
  let slateBody = null, slateErr = null;
  try { slateBody = await currentGames(env); } catch (e) { slateErr = String(e?.message || e); }
  const results = {};
  results.injuries = await runLane(env, 'injuries', async () => {
    if (!slateBody) throw new Error(slateErr || 'season_unknown');
    return ingestInjuries(env, { season: slateBody.season });
  });
  results.market = await runLane(env, 'market', async () => {
    if (!slateBody) throw new Error(slateErr || 'slate_unavailable');
    return captureMarket(env, { slateBody });
  });
  const wx = await env.INTEL_KV.get(WX_KEY, 'json');
  if (force || !wx || Date.now() - Date.parse(wx.fetched_at) >= WX_MAX_AGE_MS - 60000) {
    results.weather = await runLane(env, 'weather', async () => {
      if (!slateBody) throw new Error(slateErr || 'slate_unavailable');
      return refreshWeather(env, { games: gamesFromCurrent(slateBody) });
    });
  }
  return { ms: Date.now() - t, results };
}

/* ---- GET /api/changes ------------------------------------------------------ */
async function changes(env, url) {
  const now = Date.now();
  const fetchedAt = new Date(now).toISOString();
  const windowHours = intParam(url, 'window_hours', 48, 6, 168);
  const [slateRes, injRes, mktRes, wxRes] = await Promise.allSettled([
    currentGames(env),
    env.INTEL_KV.get(KV_KEYS.report, 'json'),
    recentRows(env, 12),
    env.INTEL_KV.get(WX_KEY, 'json')
  ]);

  const sources = {};
  let games = [];
  if (slateRes.status === 'fulfilled') {
    games = gamesFromCurrent(slateRes.value);
    sources.scoreboard = { provider: 'nfl-current (ESPN scoreboard authority)', available: true, fetched_at: fetchedAt, games: games.length, freshness: slateRes.value.freshness?.state || null };
  } else {
    sources.scoreboard = { provider: 'nfl-current (ESPN scoreboard authority)', available: false, fetched_at: fetchedAt, reason: String(slateRes.reason?.message || slateRes.reason) };
  }

  let injuryRows = [];
  const inj = injRes.status === 'fulfilled' ? injRes.value : null;
  if (inj?.report) {
    injuryRows = parseInjuryReport(inj.report);
    const age = now - Date.parse(inj.fetched_at);
    sources.injuries = {
      provider: 'espn_core_api_injuries', available: true, fetched_at: inj.fetched_at, ingested_by: 'nfl-intel cron',
      age_seconds: Math.round(age / 1000), stale: age > INJURY_STALE_MS, entries: inj.entries,
      failed_teams: inj.failed_teams || [], record_failures: inj.record_failures || 0,
      note: 'Designation and the time ESPN last updated its note. Prior designations are not claimed.'
    };
  } else {
    sources.injuries = { provider: 'espn_core_api_injuries', available: false, fetched_at: fetchedAt, reason: injRes.status === 'rejected' ? String(injRes.reason?.message || injRes.reason) : 'first_ingest_pending' };
  }

  let moves = [];
  if (mktRes.status === 'fulfilled' && mktRes.value.index.length >= 2) {
    const byTape = new Map();
    for (const g of games) {
      const id = nflverseGameId({ season: g.season, seasonType: g.season_type, week: g.week, away: nflverseCode(g.away.abbreviation), home: nflverseCode(g.home.abbreviation) });
      if (id) byTape.set(id, g);
    }
    moves = marketMoves(mktRes.value.rows, byTape).map(m => ({ ...m, source: { provider: 'pbe_market_history', label: 'PropBetEdge market history · cross-book consensus per ingest' } }));
    const idx = mktRes.value.index;
    sources.market = { provider: 'pbe_market_history', available: true, fetched_at: fetchedAt, batches: idx.length, latest_captured_at: idx[0]?.captured_at || null, first_captured_at: idx.at(-1)?.captured_at || null, semantics: 'CROSS_BOOK_CONSENSUS_PER_SCHEDULED_INGEST', thresholds: MARKET_THRESHOLDS };
  } else {
    const n = mktRes.status === 'fulfilled' ? mktRes.value.index.length : 0;
    sources.market = { provider: 'pbe_market_history', available: false, fetched_at: fetchedAt, batches: n, reason: mktRes.status === 'rejected' ? String(mktRes.reason?.message || mktRes.reason) : n === 1 ? 'one_capture_so_far_a_move_needs_two' : 'no_capture_yet' };
  }

  const wx = wxRes.status === 'fulfilled' ? wxRes.value : null;
  const weather = wx
    ? { available: true, fetched_at: wx.fetched_at, monitored: wx.monitored, events: [...(wx.events || []), ...(wx.shifts || [])], semantics: wx.semantics }
    : { available: false, reason: wxRes.status === 'rejected' ? String(wxRes.reason?.message || wxRes.reason) : 'first_snapshot_pending' };
  sources.weather = { provider: 'nws_alerts + open_meteo_forecast', available: weather.available, fetched_at: weather.fetched_at || fetchedAt, reason: weather.reason };

  const list = rankChanges([
    ...gameStatusChanges(games, fetchedAt),
    ...recentInjuryChanges(injuryRows, teamGameIndex(games), { now, windowHours }),
    ...moves
  ]);
  const counts = list.reduce((acc, c) => { acc[c.kind] = (acc[c.kind] || 0) + 1; return acc; }, { total: list.length });
  const anySource = sources.injuries.available || sources.scoreboard.available || sources.market.available || weather.available;
  return json({
    ok: anySource,
    semantics: 'SOURCED_CHANGES',
    runtime: VERSION,
    generated_at: fetchedAt,
    window_hours: windowHours,
    transitions: {
      available: false,
      reason: 'change_ledger_not_published',
      note: 'Status transitions (e.g. QUESTIONABLE to OUT) need a durable ledger of prior observations. Items here are current designations with their source update time.'
    },
    sources,
    games: games.map(g => ({ id: g.id, matchup: g.matchup, kickoff: g.kickoff, semantics: g.semantics, detail: g.detail, week: g.week, away: g.away, home: g.home })),
    counts,
    changes: list,
    availability: availabilityByGame(injuryRows, games),
    weather
  }, anySource ? 200 : 503, anySource ? 60 : 0);
}

/* ---- GET /api/best-line ---------------------------------------------------- */
async function bestLine(env, url) {
  const now = Date.now();
  const days = intParam(url, 'days', 8, 1, 21);
  const only = String(url.searchParams.get('event') || '').trim();
  let snap;
  try {
    const r = await env.NFL_ODDS.fetch(new Request('https://nfl-odds.internal/api/odds', { headers: { accept: 'application/json' } }));
    const text = await r.text();
    if (!r.ok) return json({ ok: false, semantics: 'UNAVAILABLE', error: `odds_snapshot_${r.status}`, detail: text.slice(0, 160), runtime: VERSION }, r.status === 503 ? 503 : 502);
    snap = JSON.parse(text);
  } catch (e) {
    return json({ ok: false, semantics: 'UNAVAILABLE', error: 'odds_snapshot_unreachable', detail: String(e?.message || e), runtime: VERSION }, 502);
  }
  let slateBody = null;
  try { slateBody = await currentGames(env); } catch (_) { /* market price shopping remains available */ }
  const slateGames = slateBody ? gamesFromCurrent(slateBody) : [];
  const teamKey = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const matchupKey = (away, home) => `${teamKey(away)}|${teamKey(home)}`;
  const slateByMatchup = new Map(slateGames.map(g => [matchupKey(g.away?.name, g.home?.name), g]));
  const horizon = now + days * 86400000;
  const events = (Array.isArray(snap?.events) ? snap.events : [])
    .filter(e => (only ? String(e.id) === only : true))
    .filter(e => { const k = Date.parse(e?.commence_time || ''); return Number.isFinite(k) && k <= horizon && k > now - 5 * 3600000; })
    .map(e => {
      const summary = summarizeEvent(e, { now });
      const slate = slateByMatchup.get(matchupKey(e?.away_team, e?.home_team));
      return { ...summary, season: slate?.season ?? null, week: slate?.week ?? null };
    })
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const currentWeekRaw = slateBody?.current_week ?? slateBody?.week;
  const currentWeek = Number.isFinite(Number(currentWeekRaw)) ? Number(currentWeekRaw)
    : events.map(e => Number(e.week)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  return json({
    ok: true,
    runtime: VERSION,
    semantics: snap?.semantics || 'LAST_VERIFIED_MARKET',
    price_semantics: 'SCHEDULED_SNAPSHOT_NOT_LIVE',
    captured_at: snap?.captured_at || null,
    captured_at_et: snap?.captured_at_et || null,
    age_seconds: Number.isFinite(Number(snap?.age_seconds)) ? Number(snap.age_seconds) : null,
    ingest: snap?.ingest || null,
    source: { provider: snap?.source?.provider || 'the_odds_api', authority: 'nfl-odds scheduled ingest', read_path: 'service-binding kv-snapshot', region: snap?.source?.region || 'us' },
    window_days: days,
    current_week: currentWeek,
    definitions: {
      best: 'Most favourable number, then best price at it, from one named sportsbook.',
      consensus: 'Median line across books; vig-free probability averaged over books quoting both sides at that line.',
      fair: 'PropBetEdge model fair value. Not published on this surface; never approximated from consensus.',
      edge: 'Model fair value versus the best price. Exists only where a fair value is published.'
    },
    events,
    book_leaderboard: bookLeaderboard(events.filter(e => !e.started)),
    generated_at: new Date(now).toISOString()
  }, 200, 60);
}

async function health(env) {
  const lanes = ['injuries', 'market', 'weather'];
  const rows = await Promise.all(lanes.map(l => env.INTEL_KV.get(`run:intel:${l}`, 'json')));
  const out = Object.fromEntries(lanes.map((l, i) => [l, rows[i] || { status: 'never_run' }]));
  return json({ service: 'nfl-intel', version: VERSION, lanes: out, checked_at: new Date().toISOString() });
}

function authorized(req, env) {
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const want = String(env.INTEL_ADMIN_TOKEN || '');
  if (!want || token.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/api/intel/run') {
        if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
        if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
        return json(await runAll(env, { force: true }));
      }
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      if (path === '/api/changes') return await changes(env, url);
      if (path === '/api/best-line') return await bestLine(env, url);
      if (path === '/api/intel/health' || path === '/health') return await health(env);
      return json({ error: 'not_found', path, service: 'nfl-intel' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'internal', detail: String(e?.message || e), runtime: VERSION }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  }
};
