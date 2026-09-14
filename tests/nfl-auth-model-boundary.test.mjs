/* NFL Pro model boundary — premium model output is server-enforced.
 *
 * workers/nfl-picks serves /picks paths only to a server holding
 * NFL_GATEWAY_TOKEN (x-pbe-gateway-token). The gateway forwards the original
 * request, so this covers every public host. api/pro-model.js is the only
 * browser-reachable path to the model: it checks the reader's entitlement
 * FIRST and only then presents the server credential.
 *
 *   node --test tests/nfl-auth-model-boundary.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.NFL_SESSION_SIGNING_SECRET = 'model-boundary-signing-secret';
process.env.NFL_OWNER_EMAILS = 'owner@propbetedge.test';
process.env.NFL_GATEWAY_TOKEN = 'server-model-credential';

const picks = (await import('../workers/nfl-picks/src/index.js')).default;
const { SESSION_COOKIE, HMAC_NAMESPACE } = await import('../api/_nfl-auth.js');
const { NFL_PRICES } = await import('../api/_nfl-entitlement.js');
const { default: proModel } = await import('../api/pro-model.js');

/* ------------------------------------------------------------ nfl-picks Worker */
function oddsSpy() {
  const calls = [];
  return { calls, binding: { fetch: async req => { calls.push(String(req.url || req)); return new Response('{"error":"stub"}', { status: 503 }); } } };
}
const modelReq = (headers = {}, path = '/api/picks/pass?event_id=e1') => new Request(`https://nfl-picks.test${path}`, { headers });

test('nfl-picks: no credential, a wrong one, or a browser-style request gets no model and no market read', async () => {
  const odds = oddsSpy();
  const env = { NFL_GATEWAY_TOKEN: 'server-model-credential', NFL_ODDS: odds.binding };
  for (const headers of [{}, { 'x-pbe-gateway-token': 'guess' }, { 'x-pbe-gateway-token': 'server-model-credentia' }, { authorization: 'Bearer server-model-credential' },
    { origin: 'https://nfl.propbetedge.ai', referer: 'https://nfl.propbetedge.ai/', cookie: 'pbe_nfl_session_v2=anything' }]) {
    const r = await picks.fetch(modelReq(headers), env);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.deepEqual(await r.json(), { error: 'nfl_pro_required', entitlement: 'nfl_pro' });
  }
  for (const path of ['/api/picks', '/picks/pass', '/api/picks/anything?event_id=x']) assert.equal((await picks.fetch(modelReq({}, path), env)).status, 401, path);
  assert.equal(odds.calls.length, 0, 'the market is never read for a refused request');
});

test('nfl-picks: secret unset fails closed (503), even for a caller presenting a token', async () => {
  const odds = oddsSpy();
  const r = await picks.fetch(modelReq({ 'x-pbe-gateway-token': 'server-model-credential' }), { NFL_ODDS: odds.binding });
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'model_access_unavailable'); assert.equal(odds.calls.length, 0);
});

test('nfl-picks: the credentialed server caller reaches the model; /health stays public', async () => {
  const odds = oddsSpy();
  const env = { NFL_GATEWAY_TOKEN: 'server-model-credential', NFL_ODDS: odds.binding };
  const r = await picks.fetch(modelReq({ 'x-pbe-gateway-token': 'server-model-credential' }), env);
  assert.notEqual(r.status, 401);
  assert.notEqual((await r.clone().json().catch(() => ({}))).error, 'model_access_unavailable');
  assert.ok(odds.calls.length > 0, 'model build proceeds to its market read');
  const h = await picks.fetch(modelReq({}, '/health'), {});
  assert.equal(h.status, 200); assert.equal((await h.json()).service, 'nfl-picks');
});

/* ------------------------------------------------------------ api/pro-model.js */
const b64u = v => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sessionFor = email => {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ email, type: 'session', iat: now, exp: now + 3600, jti: 'x' }))}`;
  return `${SESSION_COOKIE}=${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${process.env.NFL_SESSION_SIGNING_SECRET}`).update(data).digest())}`;
};
const DAY = 86400000;
const row = (email, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: NFL_PRICES.foundingMonthly, stripe_subscription_id: 'sub_1T', stripe_customer_id: 'cus_T', current_period_end: new Date(Date.now() + 20 * DAY).toISOString(), ...over });
const LEDGER = {
  'pro@qa.test': [row('pro@qa.test')],
  'expired@qa.test': [row('expired@qa.test', { current_period_end: new Date(Date.now() - DAY).toISOString() })],
  'canceled@qa.test': [row('canceled@qa.test', { status: 'canceled' })],
};
let upstream = []; let ledgerDown = false; let upstreamStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host === 'supabase.test') {
    if (ledgerDown) return new Response('{}', { status: 503 });
    const email = decodeURIComponent(/customer_email=ilike\.([^&]+)/.exec(u.search)?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return new Response(JSON.stringify(LEDGER[email] || []), { status: 200 });
  }
  if (u.host === 'nfl-api.propbetedge.ai') { upstream.push(new Headers(init.headers)); return new Response('{"model":"pass"}', { status: upstreamStatus, headers: { 'content-type': 'application/json' } }); }
  throw new Error(`unexpected fetch ${u.host}`);
};
function res() { return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = String(b ?? ''); } }; }
async function call(cookie, headers = {}) {
  upstream = [];
  const r = res(); await proModel({ method: 'GET', headers: { cookie, ...headers }, query: { event_id: 'e1' } }, r);
  return { status: r.statusCode, body: r.body, upstream: upstream.length, token: upstream[0]?.get('x-pbe-gateway-token') || null };
}

test('pro-model: anonymous, unpaid, expired, canceled and spoofed readers never cause a credentialed model read', async () => {
  const spoof = { 'x-user-email': 'owner@propbetedge.test', 'x-pbe-role': 'owner', 'x-pbe-gateway-token': 'server-model-credential' };
  const cases = [['', 401], [sessionFor('newuser@qa.test'), 403], [sessionFor('expired@qa.test'), 403], [sessionFor('canceled@qa.test'), 403], ['pbe_role=owner; subscribed=true', 401]];
  for (const [cookie, want] of cases) {
    const r = await call(cookie, spoof);
    assert.equal(r.status, want, cookie.slice(0, 30)); assert.equal(r.upstream, 0, 'no upstream model read');
  }
});

test('pro-model: an entitled reader and the owner get the model, with the server credential attached server-side', async () => {
  for (const email of ['pro@qa.test', 'owner@propbetedge.test']) {
    const r = await call(sessionFor(email));
    assert.equal(r.status, 200, email); assert.equal(r.upstream, 1); assert.equal(r.token, 'server-model-credential');
    assert.equal(/server-model-credential/.test(r.body), false, 'the credential never appears in a response');
  }
});

test('pro-model: ledger outage is 503 with no model read; missing or refused server credential is 503, never a sign-in prompt', async () => {
  ledgerDown = true;
  try { const r = await call(sessionFor('pro@qa.test')); assert.equal(r.status, 503); assert.equal(r.upstream, 0); } finally { ledgerDown = false; }
  const saved = process.env.NFL_GATEWAY_TOKEN; delete process.env.NFL_GATEWAY_TOKEN;
  try { const r = await call(sessionFor('pro@qa.test')); assert.equal(r.status, 503); assert.equal(JSON.parse(r.body).error, 'model_access_unavailable'); assert.equal(r.upstream, 0); } finally { process.env.NFL_GATEWAY_TOKEN = saved; }
  upstreamStatus = 401;
  try { const r = await call(sessionFor('pro@qa.test')); assert.equal(r.status, 503); assert.equal(JSON.parse(r.body).error, 'model_access_unavailable'); } finally { upstreamStatus = 200; }
});

test('the browser never holds the credential: no client file references it', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url);
  const client = readdirSync(root).filter(f => /\.(js|html|css)$/.test(f));
  for (const f of client) assert.equal(/NFL_GATEWAY_TOKEN|x-pbe-gateway-token/.test(readFileSync(new URL(f, root), 'utf8')), false, f);
});
