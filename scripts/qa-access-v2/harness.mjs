/* NFL access v2 QA harness — this branch, locally, with controlled identity.
 *
 *   node scripts/qa-access-v2/harness.mjs --port 8801 [--auth-worker <path to index-v5.js>]
 *
 * Serves the checked-out static site. Runs THIS branch's access-bearing API
 * handlers in-process (auth-session, auth-verify, auth-logout, auth-email,
 * pro-model, pbe-picks premium views, pbe-prop-picks current, checkout*).
 * Every other /api/* read is proxied to https://nfl.propbetedge.ai, whose public
 * handlers are the 4c24d00 baseline this branch does not change.
 *
 * Controlled edges (never real):
 *   Supabase nfl_subscriptions   in-memory ledger below (other tables 503)
 *   auth Worker exchange         the auth Worker source passed with
 *                                --auth-worker (default: this branch's), with an
 *                                in-memory single-use link ledger
 *   auth Worker link request     stub; no email is ever sent
 *
 * QA controls (harness only):
 *   GET /__qa/magic?email=[&expired=1][&forged=1]   a sign-in link token
 *   GET /__qa/supabase?mode=ok|down|hang
 *   GET /__qa/authsession?mode=ok|500|hang          break /api/auth-session
 *   GET /__qa/authworker?mode=ok|down               break the link exchange
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const PORT = Number(arg('port', 8801));
const ORIGIN = `http://localhost:${PORT}`;
const PROD = 'https://nfl.propbetedge.ai';
const AUTH_WORKER_SOURCE = resolve(arg('auth-worker', join(REPO, 'workers/nfl-auth/src/index-v5.js')));

Object.assign(process.env, {
  SUPABASE_URL: `${ORIGIN}/__supabase`,
  SUPABASE_SERVICE_ROLE_KEY: 'local-qa-service-key',
  NFL_SESSION_SIGNING_SECRET: 'local-qa-session-secret',
  NFL_AUTH_WORKER_URL: `${ORIGIN}/__authworker`,
  NFL_OWNER_EMAILS: 'owner@qa.test',
  NFL_GATEWAY_TOKEN: process.env.QA_NFL_GATEWAY_TOKEN || 'local-qa-gateway-token',
});

const auth = await import(pathToFileURL(join(REPO, 'api/_nfl-auth.js')).href);
const { NFL_PRICES } = await import(pathToFileURL(join(REPO, 'api/_nfl-entitlement.js')).href);
const authWorker = await import(pathToFileURL(AUTH_WORKER_SOURCE).href);

/* ------------------------------------------------------------ ledger */
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const sub = (email, price, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: price, stripe_subscription_id: 'sub_1LocalQA', stripe_customer_id: 'cus_LocalQA', stripe_checkout_session_id: 'cs_test_LocalQA', current_period_end: iso(Date.now() + 5 * DAY), cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over });
const LEDGER = new Map(Object.entries({
  'weekly@qa.test': [sub('weekly@qa.test', NFL_PRICES.foundingWeekly)],
  'monthly@qa.test': [sub('monthly@qa.test', NFL_PRICES.foundingMonthly, { current_period_end: iso(Date.now() + 20 * DAY) })],
  'expired@qa.test': [sub('expired@qa.test', NFL_PRICES.foundingWeekly, { current_period_end: iso(Date.now() - DAY) })],
  'canceled@qa.test': [sub('canceled@qa.test', NFL_PRICES.foundingMonthly, { status: 'canceled', cancel_at_period_end: true })],
  'nonsub@qa.test': [
    { customer_email: 'nonsub@qa.test', status: 'active', stripe_price_id: null, current_period_end: null, created_at: '2026-09-01T00:00:00Z' },
    sub('nonsub@qa.test', 'price_1MLBProWeekly'),
  ],
}));
const modes = { supabase: 'ok', authsession: 'ok', authworker: 'ok' };

/* ------------------------------------------------------------ auth Worker (in-memory DO) */
const magicLedger = (() => {
  const objects = new Map(); let queue = Promise.resolve();
  return {
    idFromName: name => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const store = new Map();
        objects.set(id.name, new authWorker.MagicLinkLedger({ storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, v); }, setAlarm: async () => {}, deleteAll: async () => store.clear() } }));
      }
      const obj = objects.get(id.name);
      return { fetch: (u, init) => (queue = queue.then(() => obj.fetch(new Request(u, init)))) };
    },
  };
})();
/* The exchange re-checks NFL access against the same in-memory ledger and owner. */
const AUTH_ENV = { NFL_SESSION_SIGNING_SECRET: process.env.NFL_SESSION_SIGNING_SECRET, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, NFL_OWNER_EMAILS: process.env.NFL_OWNER_EMAILS, APP_ORIGIN: PROD, MAGIC_LINKS: authWorker.MagicLinkLedger ? magicLedger : undefined };

const b64u = v => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sign(payload, secret = process.env.NFL_SESSION_SIGNING_SECRET) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(createHmac('sha256', `${auth.HMAC_NAMESPACE}:${secret}`).update(data).digest())}`;
}

/* ------------------------------------------------------------ plumbing */
const LOCAL_API = new Set(['auth-session', 'auth-verify', 'auth-logout', 'auth-email', 'pro-model', 'checkout', 'checkout-complete']);
const PREMIUM_PICKS_VIEWS = new Set(['current', 'decision', 'validation-history', 'receipt']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
function vercelRes(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); return res; };
  res.send = body => { res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); return res; };
  res.redirect = (code, url) => { res.statusCode = code; res.setHeader('location', String(url).replace(PROD, ORIGIN)); res.end(); return res; };
  return res;
}
const moduleCache = new Map();
const apiModule = rel => { if (!moduleCache.has(rel)) moduleCache.set(rel, import(pathToFileURL(join(REPO, 'api', rel)).href)); return moduleCache.get(rel); };

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname;

  if (path.startsWith('/__qa/')) {
    const email = String(url.searchParams.get('email') || '').toLowerCase();
    if (path === '/__qa/magic') {
      const t = Math.floor(Date.now() / 1000), expired = url.searchParams.get('expired') === '1';
      const payload = { email, type: 'magic', purpose: 'signin', iat: t - (expired ? 2000 : 0), exp: expired ? t - 60 : t + 900, jti: randomUUID() };
      return send(res, 200, { token: sign(payload, url.searchParams.get('forged') === '1' ? 'attacker-key' : undefined) });
    }
    for (const k of ['supabase', 'authsession', 'authworker']) if (path === `/__qa/${k}`) { modes[k] = url.searchParams.get('mode') || 'ok'; auth.clearEntitlementCache?.(); return send(res, 200, modes); }
    return send(res, 404, { error: 'unknown qa control' });
  }
  if (path.startsWith('/__supabase/rest/v1/')) {
    if (modes.supabase === 'down') return send(res, 503, { message: 'qa outage' });
    if (modes.supabase === 'hang') return; /* never answers; the caller must time out */
    if (path !== '/__supabase/rest/v1/nfl_subscriptions') return send(res, 503, { message: 'table not provided by the QA harness' });
    const raw = decodeURIComponent(/customer_email=ilike\.([^&]+)/.exec(url.search)?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return send(res, 200, LEDGER.get(raw) || []);
  }
  if (path.startsWith('/__authworker/')) {
    if (modes.authworker === 'down') return send(res, 503, { error: 'service_unavailable' });
    if (path === '/__authworker/v1/auth/exchange') {
      const r = await authWorker.default.fetch(new Request('https://auth.qa/v1/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: req.headers.origin || '' }, body: await readBody(req) }), AUTH_ENV);
      return send(res, r.status, await r.text());
    }
    return send(res, 200, { ok: true, provider: 'resend', auth_issuer: 'propbetedge', message: 'QA harness: no email sent' });
  }
  if (path.startsWith('/api/')) {
    const name = path.slice(5).replace(/\/$/, '');
    const view = String(url.searchParams.get('view') || 'state').toLowerCase();
    const local = LOCAL_API.has(name) || (name === 'pbe-picks' && PREMIUM_PICKS_VIEWS.has(view)) || (name === 'pbe-prop-picks' && view === 'current');
    if (name === 'auth-session' && modes.authsession !== 'ok') {
      if (modes.authsession === 'hang') return; /* the browser must give up */
      return send(res, 500, { error: 'qa_auth_session_failure' });
    }
    if (!local) {
      if (req.method !== 'GET') return send(res, 405, { error: 'harness proxies GET only' });
      const upstream = await fetch(`${PROD}${path}${url.search}`, { headers: { accept: req.headers.accept || 'application/json' } }).catch(() => null);
      if (!upstream) return send(res, 502, { error: 'proxy_failed' });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-qa-proxied': 'production' });
      return res.end(Buffer.from(await upstream.arrayBuffer()));
    }
    const file = `${name}.js`;
    if (name.includes('..') || name.startsWith('_') || !existsSync(join(REPO, 'api', file))) return send(res, 404, { error: 'no such route' });
    const raw = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : '';
    let body = raw; try { body = raw ? JSON.parse(raw) : undefined; } catch (_) {}
    const mod = await apiModule(file);
    try { await mod.default(Object.assign(req, { query: Object.fromEntries(url.searchParams), body }), vercelRes(res)); }
    catch (error) { if (!res.headersSent) send(res, 500, { error: 'handler_exception', detail: String(error?.message || error) }); }
    return;
  }
  const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
  const full = normalize(join(REPO, rel));
  if (!full.startsWith(normalize(REPO)) || !existsSync(full) || !statSync(full).isFile()) return send(res, 404, 'not found', 'text/plain');
  res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(full));
}

http.createServer((req, res) => handle(req, res).catch(e => { try { send(res, 500, { error: String(e?.message || e) }); } catch (_) {} }))
  .listen(PORT, () => console.log(`NFL access v2 harness ${ORIGIN} auth-worker=${AUTH_WORKER_SOURCE} ledger=${authWorker.MagicLinkLedger ? 'single-use' : 'none'}`));
