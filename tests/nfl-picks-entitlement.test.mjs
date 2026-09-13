/* NFL Pro passing-model entitlement.
 *
 * Until 2026-09-13 nfl.propbetedge.ai's paywall only rewrote the BROWSER's
 * model fetch to /api/pro-model; nfl-api.propbetedge.ai/api/picks/pass (and
 * both workers.dev hosts) served the full model to anyone. Two layers now:
 *
 *   A · nfl-picks (the Worker every host reaches) serves model output only to
 *       the server-held PICKS_MODEL_TOKEN, and fails closed when it is unset.
 *   B · api/pro-model (Vercel) is the only browser path: it verifies the NFL
 *       session and an NFL Pro subscription, then calls with that credential.
 *
 * Each test runs the real module; only fetch / the NFL_ODDS binding is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_URL ||= 'https://supabase.test';
const MODEL_TOKEN = 'model-token-for-tests-0123456789abcdef0123456789abcdef';

const worker = (await import('../workers/nfl-picks/src/index.js')).default;
const proModel = (await import('../api/pro-model.js')).default;
const { SESSION_COOKIE, HMAC_NAMESPACE, NFL_PRO_PRICE_IDS } = await import('../api/_nfl-auth.js');

/* ---- A · the model Worker ------------------------------------------------ */
const MODEL_KEYS = ['event', 'market', 'model_version', 'semantics', 'decision_status', 'historical_source', 'market_source', 'market_updated_at', 'models', 'generated_at'];
const q = (direction, point, price, book) => ({ player: 'Aaron Rodgers', market: 'player_pass_yds', direction, point, price, book, book_key: book.toLowerCase() });
const BOARD = {
  event: { id: 'evt1', commence_time: '2026-09-20T17:00:00Z', away_team: 'Atlanta Falcons', home_team: 'Pittsburgh Steelers' },
  quotes: [q('OVER', 213.5, -113, 'DraftKings'), q('UNDER', 213.5, -111, 'DraftKings'), q('OVER', 214.5, -115, 'BetRivers'), q('UNDER', 214.5, -115, 'BetRivers')],
  market_summary: [{ player: 'Aaron Rodgers', market: 'player_pass_yds', consensus_line: 214, book_count: 2 }],
  source: { provider: 'the_odds_api' }, provider_last_update: '2026-09-13T12:00:33Z'
};
function oddsBinding() {
  const calls = [];
  return { calls, fetch: async request => { calls.push(String(request.url)); return new Response(JSON.stringify(BOARD), { status: 200, headers: { 'content-type': 'application/json' } }); } };
}
const call = (path, { token, env } = {}) => worker.fetch(new Request(`https://nfl-api.propbetedge.ai${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env);

test('A · anonymous request to the model is refused and does no model work', async () => {
  const odds = oddsBinding();
  const res = await call('/api/picks/pass?event_id=evt1', { env: { PICKS_MODEL_TOKEN: MODEL_TOKEN, NFL_ODDS: odds } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'nfl_pro_required', entitlement: 'nfl_pro' });
  assert.equal(odds.calls.length, 0, 'no market read, no model computed');
});

test('A · a wrong credential, of any length or scheme, is refused', async () => {
  const env = { PICKS_MODEL_TOKEN: MODEL_TOKEN, NFL_ODDS: oddsBinding() };
  for (const token of ['nope', MODEL_TOKEN.slice(0, -1) + 'X', MODEL_TOKEN + 'X', '']) {
    const res = await call('/api/picks/pass?event_id=evt1', { token, env });
    assert.equal(res.status, 401, `token ${JSON.stringify(token.slice(0, 6))}`);
  }
  const basic = await worker.fetch(new Request('https://x/api/picks/pass?event_id=evt1', { headers: { authorization: `Basic ${MODEL_TOKEN}` } }), env);
  assert.equal(basic.status, 401, 'only a Bearer credential counts');
});

test('A · every model path is gated, on every host that reaches the Worker', async () => {
  const env = { PICKS_MODEL_TOKEN: MODEL_TOKEN, NFL_ODDS: oddsBinding() };
  for (const url of ['https://nfl-api.propbetedge.ai/api/picks/pass?event_id=evt1', 'https://nfl-gateway.sales-fd3.workers.dev/api/picks?event_id=evt1', 'https://nfl-picks.sales-fd3.workers.dev/v1/picks/pass?event_id=evt1']) {
    const res = await worker.fetch(new Request(url), env);
    assert.equal(res.status, 401, url);
  }
});

test('A · fails closed when the credential is not configured', async () => {
  const odds = oddsBinding();
  const res = await call('/api/picks/pass?event_id=evt1', { token: MODEL_TOKEN, env: { NFL_ODDS: odds } });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'model_access_unavailable', entitlement: 'nfl_pro' });
  assert.equal(odds.calls.length, 0);
});

test('A · the credential holder receives the unchanged model response', async () => {
  const odds = oddsBinding();
  const res = await call('/api/picks/pass?event_id=evt1', { token: MODEL_TOKEN, env: { PICKS_MODEL_TOKEN: MODEL_TOKEN, NFL_ODDS: odds } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), MODEL_KEYS, 'production response shape, in order');
  assert.equal(body.model_version, 'PBE_PASS_BASELINE_V1_2');
  assert.equal(body.models[0].player, 'Aaron Rodgers');
  assert.equal(odds.calls.length, 1);
  assert.ok(!JSON.stringify(body).includes(MODEL_TOKEN), 'the credential is never echoed');
});

test('A · /health stays public and carries no model output', async () => {
  const res = await call('/api/picks/health', { env: {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'nfl-picks');
  assert.equal(body.models, undefined);
});

/* ---- B · the Vercel entitlement boundary ---------------------------------- */
const EMAIL = 'pro.fan@example.com';
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = obj => b64u(Buffer.from(JSON.stringify(obj), 'utf8'));
const now = () => Math.floor(Date.now() / 1000);
function sign(payload, namespace = HMAC_NAMESPACE, secret = process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  return `${data}.${b64u(createHmac('sha256', `${namespace}:${secret}`).update(data).digest())}`;
}
const session = (email = EMAIL) => sign({ email, type: 'session', iat: now(), exp: now() + 86400, jti: 't' });

const MODEL_BODY = JSON.stringify({ event: { id: 'evt1' }, market: 'player_pass_yds', model_version: 'PBE_PASS_BASELINE_V1_2', semantics: 'MODEL', models: [{ player: 'Aaron Rodgers', fair_line: 213 }] });
function stubNetwork({ rows = [], supabaseStatus = 200 } = {}) {
  const original = globalThis.fetch;
  const seen = { upstream: [], supabase: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://supabase.test/')) {
      seen.supabase.push(u);
      return new Response(JSON.stringify(rows), { status: supabaseStatus, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://nfl-api.propbetedge.ai/api/picks/pass')) {
      const headers = new Headers(init.headers || {});
      seen.upstream.push({ url: u, authorization: headers.get('authorization') });
      return new Response(MODEL_BODY, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}
async function hit({ cookie = '', token = MODEL_TOKEN } = {}) {
  const saved = process.env.NFL_PICKS_MODEL_TOKEN;
  if (token === null) delete process.env.NFL_PICKS_MODEL_TOKEN; else process.env.NFL_PICKS_MODEL_TOKEN = token;
  const headers = {}; let status = 200; let body = '';
  const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(b) { body = String(b ?? ''); } };
  try {
    await proModel({ method: 'GET', query: { event_id: 'evt1' }, headers: { cookie } }, res);
  } finally {
    if (saved === undefined) delete process.env.NFL_PICKS_MODEL_TOKEN; else process.env.NFL_PICKS_MODEL_TOKEN = saved;
  }
  return { status, headers, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() };
}
const NFL_PRICE = [...NFL_PRO_PRICE_IDS][0];
const row = over => ({ status: 'active', current_period_end: null, cancel_at_period_end: false, stripe_price_id: NFL_PRICE, created_at: '2026-09-01T00:00:00Z', ...over });

test('B · anonymous visitor: 401, the model is never requested', async () => {
  const net = stubNetwork();
  try {
    const r = await hit();
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'sign_in_required');
    assert.equal(net.seen.upstream.length, 0);
  } finally { net.restore(); }
});

test('B · signed-in account without a subscription: 403', async () => {
  const net = stubNetwork({ rows: [] });
  try {
    const r = await hit({ cookie: `${SESSION_COOKIE}=${session()}` });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'nfl_pro_required');
    assert.equal(net.seen.upstream.length, 0);
  } finally { net.restore(); }
});

test('B · wrong-product subscriber: an active row priced for another product is not NFL Pro', async () => {
  const net = stubNetwork({ rows: [row({ stripe_price_id: 'price_1MLBmonthlyXXXXXXXXXXXXX' })] });
  try {
    const r = await hit({ cookie: `${SESSION_COOKIE}=${session()}` });
    assert.equal(r.status, 403);
    assert.equal(net.seen.upstream.length, 0);
    assert.ok(net.seen.supabase.every(u => u.includes('/rest/v1/nfl_subscriptions?')), 'only the NFL entitlement table is consulted');
  } finally { net.restore(); }
});

test('B · wrong-product session: a token signed for another product namespace is not an NFL session', async () => {
  const net = stubNetwork({ rows: [row()] });
  try {
    const foreign = sign({ email: EMAIL, type: 'session', iat: now(), exp: now() + 86400 }, 'pbe-ufc-auth-v1');
    const r = await hit({ cookie: `${SESSION_COOKIE}=${foreign}` });
    assert.equal(r.status, 401);
    const otherCookie = await hit({ cookie: `pbe_ufc_session=${session()}` });
    assert.equal(otherCookie.status, 401, 'another product\'s cookie name is not read');
    assert.equal(net.seen.upstream.length, 0);
  } finally { net.restore(); }
});

test('B · valid NFL Pro subscriber: the unchanged model response, fetched with the server credential', async () => {
  for (const price of [...NFL_PRO_PRICE_IDS, null]) {
    const net = stubNetwork({ rows: [row({ stripe_price_id: price })] });
    try {
      const r = await hit({ cookie: `${SESSION_COOKIE}=${session()}` });
      assert.equal(r.status, 200, `price ${price}`);
      assert.equal(r.body, MODEL_BODY, 'byte-identical passthrough');
      assert.equal(net.seen.upstream.length, 1);
      assert.equal(net.seen.upstream[0].authorization, `Bearer ${MODEL_TOKEN}`);
      assert.equal(r.headers['cache-control'], 'private, no-store, max-age=0');
    } finally { net.restore(); }
  }
});

test('B · expired and cancelled NFL Pro entitlements are refused', async () => {
  for (const r0 of [row({ current_period_end: '2026-01-01T00:00:00Z' }), row({ status: 'canceled' }), row({ status: 'past_due' }), row({ status: 'incomplete_expired' })]) {
    const net = stubNetwork({ rows: [r0] });
    try {
      const r = await hit({ cookie: `${SESSION_COOKIE}=${session()}` });
      assert.equal(r.status, 403, JSON.stringify(r0));
      assert.equal(net.seen.upstream.length, 0);
    } finally { net.restore(); }
  }
});

test('B · fails closed: no model credential configured, or entitlement lookup down', async () => {
  const net = stubNetwork({ rows: [row()] });
  try {
    const r = await hit({ cookie: `${SESSION_COOKIE}=${session()}`, token: null });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: 'entitlement_unavailable' });
    assert.equal(net.seen.upstream.length, 0);
  } finally { net.restore(); }
  const down = stubNetwork({ rows: [], supabaseStatus: 500 });
  try {
    const r = await hit({ cookie: `${SESSION_COOKIE}=${session()}` });
    assert.equal(r.status, 503);
    assert.equal(down.seen.upstream.length, 0);
    assert.ok(!r.body.includes(MODEL_TOKEN) && !r.body.includes('test-service-role-key'), 'no secret in an error');
  } finally { down.restore(); }
});
