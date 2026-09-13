/* NFL access QA harness — the real branch, locally, with controlled identity.
 *
 *   node scripts/nfl-access-local-server.mjs [--port 8787] [--odds fixture|live]
 *
 * Serves the checked-out static files and runs the REAL api/*.js handlers
 * in-process, so the paywall is exercised exactly as Vercel would run it. Only
 * the edges are controlled:
 *
 *   Supabase      /__supabase   in-memory nfl_subscriptions ledger (below); every
 *                               other table answers 503, so Supabase-backed
 *                               surfaces show their own degraded state
 *   auth Worker   /__authworker magic-link exchange for QA addresses only
 *   gateway       /__gateway    --odds fixture: the REAL nfl-odds and nfl-intel
 *                               Worker code over an in-memory KV seeded by real
 *                               ingests (stubbed provider, kickoff-relative
 *                               slate); every other path, and everything in
 *                               --odds live, is a read-only GET to the public
 *                               gateway (KV snapshot reads, zero provider spend)
 *
 * QA controls (harness only, never part of the product):
 *   GET /__qa/magic?email=      a magic token the real /api/auth-verify accepts
 *   GET /__qa/ledger?email=&state=valid|canceled|expired|none
 *   GET /__qa/supabase?mode=ok|down
 *
 * QA identities: pro@qa.test (monthly), weekly@qa.test, pass@qa.test (season
 * pass), free@qa.test (none), orphan@qa.test (active, no Stripe proof, null
 * expiry), nullexp@qa.test, expired@qa.test, canceled@qa.test,
 * mlb@qa.test / ufc@qa.test / nba@qa.test / nhl@qa.test (other sports' prices).
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const PORT = Number(arg('port', process.env.PORT || 8787));
const ODDS_MODE = arg('odds', 'live');
const ORIGIN = `http://localhost:${PORT}`;
const PUBLIC_GATEWAY = 'https://nfl-api.propbetedge.ai';

Object.assign(process.env, {
  SUPABASE_URL: `${ORIGIN}/__supabase`,
  SUPABASE_SERVICE_ROLE_KEY: 'local-qa-service-key',
  NFL_SESSION_SIGNING_SECRET: 'local-qa-session-secret',
  NFL_AUTH_WORKER_URL: `${ORIGIN}/__authworker`,
  NFL_GATEWAY: `${ORIGIN}/__gateway`,
  NFL_GATEWAY_TOKEN: 'local-qa-gateway-token',
});

const auth = await import('../api/_nfl-auth.js');
const { NFL_PRICES } = await import('../api/_nfl-entitlement.js');
const { createHmac } = await import('node:crypto');

/* ------------------------------------------------------------ ledger */
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
function row(email, kind) {
  const base = { customer_email: email, cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z' };
  const sub = { stripe_subscription_id: 'sub_1LocalQA', stripe_customer_id: 'cus_LocalQA', stripe_checkout_session_id: 'cs_test_LocalQA' };
  switch (kind) {
    case 'valid': return { ...base, ...sub, status: 'active', stripe_price_id: NFL_PRICES.foundingMonthly, current_period_end: iso(Date.now() + 20 * DAY) };
    case 'weekly': return { ...base, ...sub, status: 'active', stripe_price_id: NFL_PRICES.foundingWeekly, current_period_end: iso(Date.now() + 5 * DAY) };
    case 'pass': return { ...base, status: 'active', stripe_price_id: NFL_PRICES.legacySeasonPass, stripe_subscription_id: null, stripe_customer_id: 'cus_LocalQA', stripe_checkout_session_id: 'cs_test_SeasonPass', current_period_end: '2027-02-15T05:59:59.000Z' };
    case 'orphan': return { ...base, status: 'active', stripe_price_id: null, stripe_subscription_id: null, stripe_customer_id: null, stripe_checkout_session_id: null, current_period_end: null };
    case 'nullexp': return { ...base, ...sub, status: 'active', stripe_price_id: NFL_PRICES.foundingMonthly, current_period_end: null };
    case 'expired': return { ...base, ...sub, status: 'active', stripe_price_id: NFL_PRICES.foundingMonthly, current_period_end: iso(Date.now() - DAY) };
    case 'canceled': return { ...base, ...sub, status: 'canceled', stripe_price_id: NFL_PRICES.foundingMonthly, current_period_end: iso(Date.now() + 3 * DAY) };
    case 'other': return { ...base, ...sub, status: 'active', stripe_price_id: `price_1${email.split('@')[0].toUpperCase()}PropBetEdgePro`, current_period_end: iso(Date.now() + 20 * DAY) };
    default: return null;
  }
}
const LEDGER = new Map();
function setLedger(email, state) {
  const r = row(email, state);
  if (r) LEDGER.set(email, [r]); else LEDGER.delete(email);
  auth.clearEntitlementCache();
}
for (const [email, state] of [['pro@qa.test', 'valid'], ['weekly@qa.test', 'weekly'], ['pass@qa.test', 'pass'], ['orphan@qa.test', 'orphan'], ['nullexp@qa.test', 'nullexp'],
  ['expired@qa.test', 'expired'], ['canceled@qa.test', 'canceled'], ['mlb@qa.test', 'other'], ['ufc@qa.test', 'other'], ['nba@qa.test', 'other'], ['nhl@qa.test', 'other']]) setLedger(email, state);
let supabaseMode = 'ok';

/* ------------------------------------------------------------ gateway fixture */
let fixtureGateway = null;
async function buildFixtureGateway() {
  const odds = (await import('../workers/nfl-odds/src/index.js'));
  const intel = (await import('../workers/nfl-intel/src/index.js')).default;
  const store = new Map();
  const kv = { async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o === 'json' || o?.type === 'json') ? JSON.parse(v) : v; }, async put(k, v) { store.set(k, String(v)); } };
  const now = Date.now();
  const EARLY = { id: 'qa-early-chi-car', commence_time: iso(now - 35 * 60000), away_team: 'Chicago Bears', home_team: 'Carolina Panthers' };
  const LATE = { id: 'qa-late-gb-min', commence_time: iso(now + 150 * 60000), away_team: 'Green Bay Packers', home_team: 'Minnesota Vikings' };
  const FUTURE = { id: 'qa-future-cin-hou', commence_time: iso(now + 7 * DAY), away_team: 'Cincinnati Bengals', home_team: 'Houston Texans' };
  const slate = [EARLY, LATE, FUTURE];
  const PLAYERS = {
    player_pass_yds: [['Caleb Williams', 224.5], ['Jordan Love', 241.5]],
    player_rush_yds: [["D'Andre Swift", 58.5], ['Josh Jacobs', 71.5]],
    player_reception_yds: [['DJ Moore', 58.5], ['Rome Odunze', 49.5], ['Justin Jefferson', 84.5]],
    player_receptions: [['DJ Moore', 4.5], ['Justin Jefferson', 6.5]],
    player_anytime_td: [['DJ Moore', null], ['Josh Jacobs', null]],
  };
  const featured = ev => ({ ...ev, sport_key: 'americanfootball_nfl', bookmakers: ['DraftKings', 'FanDuel', 'BetMGM'].map((title, i) => ({ key: title.toLowerCase(), title, last_update: iso(now - 6 * 3600000), markets: [
    { key: 'spreads', last_update: iso(now - 6 * 3600000), outcomes: [{ name: ev.away_team, point: 3.5 - i * 0.5, price: -110 }, { name: ev.home_team, point: -3.5 + i * 0.5, price: -110 }] },
    { key: 'totals', last_update: iso(now - 6 * 3600000), outcomes: [{ name: 'Over', point: 44.5, price: -110 + i * 3 }, { name: 'Under', point: 44.5, price: -110 - i * 3 }] },
    { key: 'h2h', last_update: iso(now - 6 * 3600000), outcomes: [{ name: ev.away_team, price: 150 + i * 5 }, { name: ev.home_team, price: -175 + i * 5 }] },
  ] })) });
  const props = (ev, offer, stamp) => ({ ...ev, sport_key: 'americanfootball_nfl', bookmakers: offer.length ? ['DraftKings', 'FanDuel'].map((title, b) => ({ key: title.toLowerCase(), title, last_update: stamp, markets: offer.map(m => ({ key: m, last_update: stamp, outcomes: PLAYERS[m].flatMap(([player, point], p) => m === 'player_anytime_td'
    ? [{ name: 'Yes', description: player, price: 160 + p * 40 - b * 5 }]
    : [{ name: 'Over', description: player, point, price: -115 + b * 5 }, { name: 'Under', description: player, point, price: -105 - b * 5 }]) })) })) : [] });
  const ALL = Object.keys(PLAYERS);
  async function run(at, offers) {
    const real = globalThis.fetch;
    globalThis.fetch = async url => {
      const u = String(url);
      const ok = (body, cost) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': String(cost), 'x-requests-used': '1', 'x-requests-remaining': '99999' } });
      const m = /\/events\/([^/]+)\/odds\?/.exec(u);
      if (m) { const ev = slate.find(e => e.id === decodeURIComponent(m[1])); return ok(props(ev, offers[ev.id] || [], iso(at.getTime() - 60000)), 18); }
      return ok(slate.map(featured), 3);
    };
    try { return await odds.ingest({ NFL_KV: kv, ODDS_API_KEY: 'qa', INGEST_PROP_WINDOW_DAYS: '8' }, { trigger: 'qa', now: at }); }
    finally { globalThis.fetch = real; }
  }
  /* 08:00-style capture, a later pre-game capture that has pulled receiving
     yards for the late game, then a capture after the early kickoff */
  await run(new Date(now - 5 * 3600000), { [EARLY.id]: ALL, [LATE.id]: ALL });
  await run(new Date(now - 60 * 60000), { [EARLY.id]: ALL, [LATE.id]: ALL.filter(m => m !== 'player_reception_yds') });
  await run(new Date(now - 5 * 60000), { [LATE.id]: ALL.filter(m => m !== 'player_reception_yds') });
  const oddsBinding = { fetch: req => odds.default.fetch(req instanceof Request ? req : new Request(req), { NFL_KV: kv }, {}) };
  const env = { NFL_ODDS: oddsBinding, NFL_CURRENT: { fetch: async () => new Response('{}', { status: 503 }) }, INTEL_KV: kv };
  return {
    slate: { EARLY, LATE, FUTURE },
    handles: path => path.startsWith('/api/odds') || path === '/api/best-line',
    fetch: async (path, search) => {
      const req = new Request(`https://nfl-api.qa${path}${search}`);
      return path === '/api/best-line' ? intel.fetch(req, env, {}) : oddsBinding.fetch(req);
    },
  };
}
if (ODDS_MODE === 'fixture') fixtureGateway = await buildFixtureGateway();

/* ------------------------------------------------------------ handlers */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const b64u = v => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sign(payload) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(createHmac('sha256', `${auth.HMAC_NAMESPACE}:${process.env.NFL_SESSION_SIGNING_SECRET}`).update(data).digest())}`;
}
const moduleCache = new Map();
async function apiModule(rel) {
  if (!moduleCache.has(rel)) moduleCache.set(rel, import(pathToFileURL(join(REPO, 'api', rel)).href));
  return moduleCache.get(rel);
}
function vercelRes(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); return res; };
  res.send = body => { res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); return res; };
  res.redirect = (code, url) => {
    /* auth-verify / checkout-complete send the browser to production; keep it here */
    const local = String(url).replace(/^https:\/\/nfl\.propbetedge\.ai/, ORIGIN);
    res.statusCode = code; res.setHeader('location', local); res.end(); return res;
  };
  return res;
}
const readBody = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); });
const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname;

  if (path.startsWith('/__qa/')) {
    const email = String(url.searchParams.get('email') || '').toLowerCase();
    if (path === '/__qa/magic') return send(res, 200, { token: sign({ email, type: 'magic', purpose: 'signin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }) });
    if (path === '/__qa/ledger') { setLedger(email, url.searchParams.get('state')); return send(res, 200, { ok: true, email, rows: LEDGER.get(email) || [] }); }
    if (path === '/__qa/supabase') { supabaseMode = url.searchParams.get('mode') === 'down' ? 'down' : 'ok'; auth.clearEntitlementCache(); return send(res, 200, { mode: supabaseMode }); }
    if (path === '/__qa/slate') return send(res, 200, fixtureGateway?.slate || null);
    return send(res, 404, { error: 'unknown qa control' });
  }
  if (path.startsWith('/__supabase/rest/v1/')) {
    if (supabaseMode === 'down') return send(res, 503, { message: 'qa outage' });
    if (path !== '/__supabase/rest/v1/nfl_subscriptions') return send(res, 503, { message: 'table not provided by the QA harness' });
    const raw = decodeURIComponent(/customer_email=ilike\.([^&]+)/.exec(url.search)?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return send(res, 200, LEDGER.get(raw) || []);
  }
  if (path === '/__authworker/v1/auth/exchange') {
    const body = JSON.parse(await readBody(req) || '{}');
    try {
      const magic = auth.verifyWorkerJwt(body.token, process.env.NFL_SESSION_SIGNING_SECRET, 'magic');
      return send(res, 200, { ok: true, email: magic.email, session_token: sign({ email: magic.email, type: 'session', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400, jti: 'qa' }) });
    } catch (error) { return send(res, 401, { error: error.message }); }
  }
  if (path.startsWith('/__authworker/')) return send(res, 200, { ok: true, provider: 'resend', auth_issuer: 'propbetedge', message: 'QA harness: no email sent' });
  if (path.startsWith('/__gateway/')) {
    const token = req.headers['x-pbe-gateway-token'];
    if (token !== process.env.NFL_GATEWAY_TOKEN) return send(res, 401, { error: 'gateway_token_required' });
    const gpath = path.slice('/__gateway'.length);
    let upstream;
    if (fixtureGateway?.handles(gpath)) upstream = await fixtureGateway.fetch(gpath, url.search);
    else upstream = await fetch(`${PUBLIC_GATEWAY}${gpath}${url.search}`, { headers: { accept: 'application/json' } });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    return res.end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (path.startsWith('/api/')) {
    let rel = path.slice(5);
    const query = Object.fromEntries(url.searchParams);
    if (rel.startsWith('gw/')) { query.__gw_path = rel.slice(3); rel = 'gw'; }
    const file = `${rel.replace(/\/$/, '')}.js`;
    if (rel.includes('..') || rel.startsWith('_') || !existsSync(join(REPO, 'api', file))) return send(res, 404, { error: 'no such route' });
    const raw = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : '';
    let body = raw;
    try { body = raw ? JSON.parse(raw) : undefined; } catch (_) { /* leave raw */ }
    const mod = await apiModule(file);
    const vreq = Object.assign(req, { query, body });
    try { await mod.default(vreq, vercelRes(res)); }
    catch (error) { if (!res.headersSent) send(res, 500, { error: 'handler_exception', detail: String(error?.message || error) }); }
    return;
  }
  let rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
  const full = normalize(join(REPO, rel));
  if (!full.startsWith(normalize(REPO)) || !existsSync(full) || !statSync(full).isFile()) return send(res, 404, 'not found', 'text/plain');
  res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(full));
}

http.createServer((req, res) => handle(req, res).catch(error => { try { send(res, 500, { error: String(error?.message || error) }); } catch (_) {} }))
  .listen(PORT, () => console.log(`NFL access QA harness ${ORIGIN} (odds=${ODDS_MODE})`));
