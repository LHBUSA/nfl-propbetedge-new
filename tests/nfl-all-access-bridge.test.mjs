/* PropBetEdge All Access -> NFL (2026-09-24), the ADDITIVE entitlement bridge.
 *
 *   verified NFL session email
 *     -> existing valid NFL entitlement?      YES -> grant exactly as today
 *     -> active pbe_all_access (shared ledger)? YES -> grant NFL Pro
 *     -> otherwise                                   deny exactly as today
 *
 * These tests drive the real auth Worker (workers/nfl-auth) and the real
 * Vercel handlers against a controlled NFL ledger, a controlled billing Worker
 * (propbetedge-sports-billing POST /v1/entitlement) and a Resend spy:
 *   · request/exchange  — All Access earns a magic link and a session; canceled,
 *                         past_due, expired or malformed All Access earns nothing
 *   · session/premium   — the Vercel answer agrees with the Worker's, every time
 *   · fail closed       — a billing Worker that is down, slow, unconfigured or
 *                         refusing the token grants nothing and changes nothing
 *                         for real NFL subscribers
 *   · never copied      — nothing is ever written to nfl_subscriptions
 *
 *   node --test tests/nfl-all-access-bridge.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SECRET = 'all-access-bridge-signing-secret';
const APP = 'https://nfl.propbetedge.ai';
const SUPABASE = 'https://supabase.bridge.test';
const BILLING = 'https://billing.bridge.test';
const READ_TOKEN = 'bridge-billing-read-token';
Object.assign(process.env, {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: 'bridge-service-role-key',
  NFL_SESSION_SIGNING_SECRET: SECRET,
  NFL_OWNER_EMAILS: 'owner@bridge.test',
  NFL_GATEWAY_TOKEN: 'bridge-model-credential',
  PBE_BILLING_URL: BILLING,
  PBE_ENTITLEMENT_READ_TOKEN: READ_TOKEN,
});

const { default: worker, MagicLinkLedger, GENERIC_REQUEST_MESSAGE } = await import('../workers/nfl-auth/src/index-v5.js');
const ent = await import('../api/_nfl-entitlement.js');
const ledgerMod = await import('../api/_nfl-entitlement-ledger.js');
const { SESSION_COOKIE, HMAC_NAMESPACE, getNflSession } = await import('../api/_nfl-auth.js');
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/* ------------------------------------------------------------ the two ledgers */
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const P = ent.NFL_PRICES;
const recurring = (email, price, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: price, stripe_subscription_id: 'sub_1Bridge', stripe_customer_id: 'cus_Bridge', stripe_checkout_session_id: 'cs_live_Bridge', current_period_end: iso(Date.now() + 5 * DAY), cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over });

/* nfl_subscriptions: All Access customers have NO NFL rows. */
const NFL_LEDGER = {
  'weekly@bridge.test': [recurring('weekly@bridge.test', P.foundingWeekly)],
  'both@bridge.test': [recurring('both@bridge.test', P.foundingMonthly, { current_period_end: iso(Date.now() + 20 * DAY) })],
  'nfl-canceled-plus-all-access@bridge.test': [recurring('nfl-canceled-plus-all-access@bridge.test', P.foundingMonthly, { status: 'canceled' })],
  'nfl-expired-only@bridge.test': [recurring('nfl-expired-only@bridge.test', P.foundingWeekly, { current_period_end: iso(Date.now() - DAY) })],
};

/* The shared billing Worker's answer for product_key pbe_all_access. */
const sub = (status, over = {}) => ({ product_key: 'pbe_all_access', plan: 'monthly', status, current_period_end: iso(Date.now() + 20 * DAY), cancel_at_period_end: false, ...over });
const yes = subscription => ({ entitled: true, product_key: 'pbe_all_access', access_source: 'all_access', subscription });
const no = subscription => ({ entitled: false, product_key: 'pbe_all_access', access_source: null, subscription });
const BILLING_LEDGER = {
  'all-access@bridge.test': yes(sub('active')),
  'all-access-trialing@bridge.test': yes(sub('trialing')),
  'all-access-cancel-at-period-end@bridge.test': yes(sub('active', { cancel_at_period_end: true })),
  'both@bridge.test': yes(sub('active')),
  'nfl-canceled-plus-all-access@bridge.test': yes(sub('active')),
  /* the shared SQL predicate already denies these; the bridge must agree */
  'all-access-canceled@bridge.test': no(sub('canceled')),
  'all-access-pastdue@bridge.test': no(sub('past_due')),
  'all-access-unpaid@bridge.test': no(sub('unpaid')),
  'all-access-expired@bridge.test': no(sub('active', { current_period_end: iso(Date.now() - DAY) })),
  'all-access-incomplete@bridge.test': no(sub('incomplete', { current_period_end: null })),
  /* a billing answer that claims entitlement without a qualifying subscription is refused */
  'lying-expired@bridge.test': yes(sub('active', { current_period_end: iso(Date.now() - 1000) })),
  'lying-status@bridge.test': yes(sub('past_due')),
  'lying-null-expiry@bridge.test': yes(sub('active', { current_period_end: null })),
  'billing-owner@bridge.test': { entitled: true, product_key: 'pbe_all_access', access_source: 'owner', subscription: null },
  'wrong-product@bridge.test': yes({ ...sub('active'), product_key: 'nba_pro' }),
  'shape-mismatch@bridge.test': { entitled: true, product_key: 'nba_pro', access_source: 'sport', subscription: sub('active') },
  'nfl-expired-only@bridge.test': no(null),
};

let nflLedgerMode = 'ok';
let billingMode = 'ok';
const resendCalls = [];
const billingCalls = [];
const nflWrites = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = String(init.method || 'GET').toUpperCase();
  if (u.origin === SUPABASE && u.pathname === '/rest/v1/nfl_subscriptions') {
    if (method !== 'GET') nflWrites.push({ method, url: String(url) });
    const email = (/customer_email=ilike\.([^&]+)/.exec(decodeURIComponent(u.search))?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    if (nflLedgerMode === 'down') return new Response('{"message":"down"}', { status: 503 });
    return new Response(JSON.stringify(NFL_LEDGER[email] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.origin === SUPABASE) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.origin === BILLING) {
    const body = JSON.parse(init.body || '{}');
    billingCalls.push({ path: u.pathname, method, auth: init.headers?.authorization || init.headers?.Authorization || '', body });
    if (billingMode === 'down') return new Response('{"error":"supabase_500"}', { status: 500 });
    if (billingMode === 'slow') return new Promise((resolve, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
    if (u.pathname !== '/v1/entitlement' || method !== 'POST') return new Response('{"error":"not_found"}', { status: 404 });
    if ((init.headers?.authorization || '') !== `Bearer ${READ_TOKEN}`) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (body.product_key !== 'pbe_all_access') return new Response('{"error":"unknown_product_key"}', { status: 400 });
    if (billingMode === 'garbage') return new Response('<html>oops</html>', { status: 200 });
    const answer = BILLING_LEDGER[String(body.email).toLowerCase()] || no(null);
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.host === 'api.resend.com') {
    const body = JSON.parse(init.body);
    resendCalls.push(body);
    return new Response(JSON.stringify({ id: `re_bridge_${resendCalls.length}` }), { status: 200 });
  }
  if (u.host === 'nfl-api.propbetedge.ai') return new Response('{"model":"PAID_MODEL_VALUE"}', { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};

function ledgerNamespace() {
  const objects = new Map();
  let queue = Promise.resolve();
  return {
    objects,
    idFromName: name => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const store = new Map();
        objects.set(id.name, new MagicLinkLedger({ storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, v); }, setAlarm: async () => {}, deleteAll: async () => store.clear() } }));
      }
      const obj = objects.get(id.name);
      return { fetch: (url, init) => (queue = queue.then(() => obj.fetch(new Request(url, init)))) };
    },
  };
}

const ENV = {
  NFL_SESSION_SIGNING_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: 'bridge-service-role-key', SUPABASE_URL: SUPABASE,
  RESEND_API_KEY: 're_bridge_key', APP_ORIGIN: APP, NFL_OWNER_EMAILS: 'owner@bridge.test', MAGIC_LINKS: ledgerNamespace(),
  PBE_BILLING_URL: BILLING, PBE_ENTITLEMENT_READ_TOKEN: READ_TOKEN,
};

async function requestLink(email, { purpose = 'signin', env = ENV } = {}) {
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p) };
  const r = await worker.fetch(new Request('https://auth.bridge.test/v1/auth/request', { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose }) }), env, ctx);
  const answer = { status: r.status, body: await r.json() };
  await Promise.all(pending);
  return answer;
}
async function exchange(token, env = ENV) {
  const r = await worker.fetch(new Request('https://auth.bridge.test/v1/auth/exchange', { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: JSON.stringify({ token }) }), env);
  return { status: r.status, body: await r.json() };
}
const tokenFrom = mail => new URL(/https:\/\/nfl\.propbetedge\.ai\/api\/auth-verify\?token=[^\s"<]+/.exec(mail.text)[0]).searchParams.get('token');
const GENERIC = { ok: true, provider: 'resend', auth_issuer: 'propbetedge', purpose: 'signin', message: GENERIC_REQUEST_MESSAGE };

const b64u = v => Buffer.from(v).toString('base64url');
function mint(payload) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${SECRET}`).update(data).digest())}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const staleLink = email => mint({ email, type: 'magic', purpose: 'signin', iat: nowS() - 60, exp: nowS() + 840, jti: crypto.randomUUID() });
const sessionCookie = email => `${SESSION_COOKIE}=${mint({ email, type: 'session', iat: nowS(), exp: nowS() + 86400, jti: crypto.randomUUID() })}`;
function mockRes() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = JSON.stringify(b); return this; }, send(b) { this.body = String(b); return this; }, end(b) { this.body = String(b ?? ''); return this; }, redirect(c, l) { this.statusCode = c; this.headers.location = l; return this; } };
}

/* ------------------------------------------------------------ the matrix */
const GRANTED_VIA_ALL_ACCESS = [
  ['All Access, active', 'all-access@bridge.test'],
  ['All Access, trialing', 'all-access-trialing@bridge.test'],
  ['All Access, canceling at period end (still paid)', 'all-access-cancel-at-period-end@bridge.test'],
  ['canceled NFL subscription but active All Access', 'nfl-canceled-plus-all-access@bridge.test'],
];
const GRANTED_VIA_NFL = [
  ['valid weekly NFL, no All Access', 'weekly@bridge.test'],
  ['valid monthly NFL AND All Access (NFL row wins)', 'both@bridge.test'],
  ['owner (server configuration)', 'owner@bridge.test'],
];
const DENIED = [
  ['canceled All Access', 'all-access-canceled@bridge.test'],
  ['past_due All Access', 'all-access-pastdue@bridge.test'],
  ['unpaid All Access', 'all-access-unpaid@bridge.test'],
  ['expired All Access', 'all-access-expired@bridge.test'],
  ['incomplete All Access (no period yet)', 'all-access-incomplete@bridge.test'],
  ['billing claims entitled but period end is past', 'lying-expired@bridge.test'],
  ['billing claims entitled but status is past_due', 'lying-status@bridge.test'],
  ['billing claims entitled but no period end', 'lying-null-expiry@bridge.test'],
  ['billing owner identity exception (not a subscription)', 'billing-owner@bridge.test'],
  ['billing subscription is for another product', 'wrong-product@bridge.test'],
  ['billing answered for a different product key', 'shape-mismatch@bridge.test'],
  ['expired NFL and no All Access', 'nfl-expired-only@bridge.test'],
  ['nobody', 'none@bridge.test'],
];

/* ------------------------------------------------------------ request */
for (const [name, email] of GRANTED_VIA_ALL_ACCESS) {
  test(`request: ${name} -> generic 200 and exactly one NFL sign-in email`, async () => {
    resendCalls.length = 0;
    const r = await requestLink(email);
    assert.equal(r.status, 200); assert.deepEqual(r.body, GENERIC);
    assert.equal(resendCalls.length, 1); assert.deepEqual(resendCalls[0].to, [email]);
  });
}
for (const [name, email] of DENIED) {
  test(`request: ${name} -> generic 200, ZERO Resend email`, async () => {
    resendCalls.length = 0;
    const r = await requestLink(email);
    assert.equal(r.status, 200); assert.deepEqual(r.body, GENERIC);
    assert.equal(resendCalls.length, 0, 'Resend must not be called');
  });
}

test('request: the billing Worker is asked only for pbe_all_access, only with the server read token, only after NFL denies', async () => {
  billingCalls.length = 0;
  await requestLink('weekly@bridge.test');
  assert.equal(billingCalls.length, 0, 'an NFL subscriber never reaches the billing Worker');
  await requestLink('owner@bridge.test');
  assert.equal(billingCalls.length, 0, 'the owner never reaches the billing Worker');
  await requestLink('all-access@bridge.test');
  assert.equal(billingCalls.length, 1);
  assert.deepEqual(billingCalls[0], { path: '/v1/entitlement', method: 'POST', auth: `Bearer ${READ_TOKEN}`, body: { email: 'all-access@bridge.test', product_key: 'pbe_all_access' } });
});

/* ------------------------------------------------------------ exchange */
test('exchange: an All Access customer exchanges the link once for a session; replay refused', async () => {
  resendCalls.length = 0;
  await requestLink('all-access@bridge.test');
  const token = tokenFrom(resendCalls[0]);
  const first = await exchange(token);
  assert.equal(first.status, 200); assert.equal(first.body.email, 'all-access@bridge.test'); assert.ok(first.body.session_token);
  const replay = await exchange(token);
  assert.equal(replay.status, 401);
});

test('exchange: All Access canceled between request and click -> not_authorized, no session', async () => {
  const email = 'all-access-flip@bridge.test';
  BILLING_LEDGER[email] = yes(sub('active'));
  resendCalls.length = 0;
  await requestLink(email);
  const token = tokenFrom(resendCalls[0]);
  BILLING_LEDGER[email] = no(sub('canceled'));
  const r = await exchange(token);
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_authorized'); assert.equal(r.body.session_token, undefined);
});

for (const [name, email] of DENIED) {
  test(`exchange: a validly signed link for ${name} -> not_authorized, no session`, async () => {
    const r = await exchange(staleLink(email));
    assert.equal(r.status, 403); assert.equal(r.body.error, 'not_authorized'); assert.equal(r.body.session_token, undefined);
  });
}

/* ------------------------------------------------------------ Vercel: session + premium */
test('auth-session: All Access customers are NFL Pro, with the All Access plan named and the shared ledger as source', async () => {
  const { default: handler } = await import('../api/auth-session.js');
  for (const [, email] of GRANTED_VIA_ALL_ACCESS) {
    const res = mockRes();
    await handler({ method: 'GET', headers: { cookie: sessionCookie(email) } }, res);
    const body = JSON.parse(res.body);
    assert.equal(body.pro, true, email); assert.equal(body.access, 'granted'); assert.equal(body.role, 'subscriber');
    assert.equal(body.entitlement.plan, 'all_access'); assert.equal(body.entitlement.source, 'pbe_all_access');
    assert.equal(body.subscription.plan, 'all_access'); assert.equal(body.subscription.stripe_price_id, null);
    assert.equal(res.headers['set-cookie'], undefined, 'the NFL session cookie stays');
  }
});

test('auth-session: an NFL subscriber who also holds All Access keeps the NFL plan (grant exactly as today)', async () => {
  const s = await getNflSession({ headers: { cookie: sessionCookie('both@bridge.test') } });
  assert.equal(s.pro, true); assert.equal(s.entitlement.plan, 'founding_monthly'); assert.equal(s.entitlement.source, 'nfl');
  assert.equal(s.subscription.stripe_price_id, P.foundingMonthly);
});

test('auth-session: canceled / past_due / expired / malformed All Access is PAYWALLED exactly like no subscription', async () => {
  const { default: handler } = await import('../api/auth-session.js');
  for (const [, email] of DENIED) {
    const res = mockRes();
    await handler({ method: 'GET', headers: { cookie: sessionCookie(email) } }, res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.pro, false, email); assert.equal(body.valid, false); assert.equal(body.access, 'no_entitlement'); assert.equal(body.paywalled, true);
    assert.ok(res.headers['set-cookie'].some(c => c.startsWith(`${SESSION_COOKIE}=;`)), 'NFL cookie cleared');
  }
});

test('premium routes: All Access sessions are served exactly like NFL subscribers; denied All Access sees no paid value', async () => {
  const { default: proModel } = await import('../api/pro-model.js');
  const { default: picks } = await import('../api/pbe-picks.js');
  const { default: propPicks } = await import('../api/pbe-prop-picks.js');
  const routes = [
    ['pro-model', proModel, { event_id: 'e1' }],
    ['pbe-picks current', picks, { view: 'current' }],
    ['pbe-prop-picks current', propPicks, { view: 'current' }],
  ];
  for (const [name, handler, query] of routes) {
    const nfl = mockRes();
    await handler({ method: 'GET', headers: { cookie: sessionCookie('weekly@bridge.test') }, query }, nfl);
    const all = mockRes();
    await handler({ method: 'GET', headers: { cookie: sessionCookie('all-access@bridge.test') }, query }, all);
    assert.notEqual(nfl.statusCode, 403, `${name}: the NFL subscriber is the reference`);
    assert.equal(all.statusCode, nfl.statusCode, `${name}: All Access answered differently from an NFL subscriber`);
    for (const [, email] of DENIED) {
      const res = mockRes();
      await handler({ method: 'GET', headers: { cookie: sessionCookie(email) }, query }, res);
      assert.equal(res.statusCode, 403, `${name} for ${email}`);
      assert.equal(/PAID_MODEL_VALUE|fair_line|model_probability/.test(res.body), false, `${name} leaked a paid value`);
    }
  }
});

/* ------------------------------------------------------------ both runtimes agree */
test('agreement: the Worker gate and the Vercel session give the same answer for every email in the matrix', async () => {
  for (const [name, email] of [...GRANTED_VIA_ALL_ACCESS, ...GRANTED_VIA_NFL, ...DENIED]) {
    const w = await ledgerMod.resolveNflAccess(email, { ownerEmails: ledgerMod.parseOwnerEmails(ENV.NFL_OWNER_EMAILS), supabaseUrl: SUPABASE, serviceKey: ENV.SUPABASE_SERVICE_ROLE_KEY, allAccess: { billingUrl: BILLING, readToken: READ_TOKEN } });
    const v = await getNflSession({ headers: { cookie: sessionCookie(email) } });
    assert.equal(v.pro, w.allowed, `${name}: Worker=${w.allowed} Vercel=${v.pro}`);
    if (w.allowed) assert.equal(v.entitlement.plan, w.verdict.plan, name);
  }
});

/* ------------------------------------------------------------ fail closed */
test('fail closed: billing Worker down -> All Access grants nothing, NFL subscribers unaffected, no outage reported', async () => {
  billingMode = 'down';
  try {
    resendCalls.length = 0;
    await requestLink('all-access@bridge.test');
    assert.equal(resendCalls.length, 0);
    await requestLink('weekly@bridge.test');
    assert.equal(resendCalls.length, 1, 'the NFL subscriber still receives a link');
    const r = await exchange(staleLink('all-access@bridge.test'));
    assert.equal(r.status, 403, 'a denial, not a 503: NFL itself answered');
    const s = await getNflSession({ headers: { cookie: sessionCookie('all-access@bridge.test') } });
    assert.equal(s.pro, false); assert.equal(s.access, 'no_entitlement'); assert.equal(s.degraded, false);
    assert.equal(s.entitlement.all_access, 'unavailable');
  } finally { billingMode = 'ok'; }
});

test('fail closed: a slow billing Worker times out and grants nothing', async () => {
  billingMode = 'slow';
  try {
    await assert.rejects(ledgerMod.lookupAllAccess('all-access@bridge.test', { billingUrl: BILLING, readToken: READ_TOKEN, timeoutMs: 20 }), /all_access_timeout/);
    const verdict = await ledgerMod.lookupNflAccessVerdict('all-access@bridge.test', { supabaseUrl: SUPABASE, serviceKey: 'k', allAccess: { billingUrl: BILLING, readToken: READ_TOKEN, timeoutMs: 20 } });
    assert.equal(verdict.entitled, false); assert.equal(verdict.all_access, 'unavailable'); assert.equal(verdict.all_access_error, 'all_access_timeout');
  } finally { billingMode = 'ok'; }
});

test('fail closed: an unreadable billing answer grants nothing', async () => {
  billingMode = 'garbage';
  try {
    const verdict = await ledgerMod.lookupNflAccessVerdict('all-access@bridge.test', { supabaseUrl: SUPABASE, serviceKey: 'k', allAccess: { billingUrl: BILLING, readToken: READ_TOKEN } });
    assert.equal(verdict.entitled, false); assert.equal(verdict.all_access, 'unavailable'); assert.equal(verdict.all_access_error, 'all_access_unreadable');
  } finally { billingMode = 'ok'; }
});

test('fail closed: a refused read token grants nothing', async () => {
  const verdict = await ledgerMod.lookupNflAccessVerdict('all-access@bridge.test', { supabaseUrl: SUPABASE, serviceKey: 'k', allAccess: { billingUrl: BILLING, readToken: 'wrong-token' } });
  assert.equal(verdict.entitled, false); assert.equal(verdict.all_access, 'unavailable'); assert.equal(verdict.all_access_error, 'all_access_401');
});

test('fail closed: without the read token the bridge is off and NFL decides exactly as before (Worker + Vercel)', async () => {
  resendCalls.length = 0; billingCalls.length = 0;
  const { PBE_ENTITLEMENT_READ_TOKEN, ...env } = ENV;
  await requestLink('all-access@bridge.test', { env });
  await requestLink('weekly@bridge.test', { env });
  assert.equal(resendCalls.length, 1); assert.deepEqual(resendCalls[0].to, ['weekly@bridge.test']);
  assert.equal(billingCalls.length, 0, 'an unconfigured bridge never calls out');
  const saved = process.env.PBE_ENTITLEMENT_READ_TOKEN;
  delete process.env.PBE_ENTITLEMENT_READ_TOKEN;
  try {
    const s = await getNflSession({ headers: { cookie: sessionCookie('all-access@bridge.test') } });
    assert.equal(s.pro, false); assert.equal(s.entitlement.all_access, 'not_configured');
    const n = await getNflSession({ headers: { cookie: sessionCookie('weekly@bridge.test') } });
    assert.equal(n.pro, true);
  } finally { process.env.PBE_ENTITLEMENT_READ_TOKEN = saved; }
});

test('fail closed: the NFL ledger down still denies everyone, All Access included (the NFL predicate is never bypassed)', async () => {
  nflLedgerMode = 'down';
  try {
    resendCalls.length = 0; billingCalls.length = 0;
    await requestLink('all-access@bridge.test');
    await requestLink('weekly@bridge.test');
    assert.equal(resendCalls.length, 0); assert.equal(billingCalls.length, 0, 'All Access is never consulted before NFL has answered');
    const r = await exchange(staleLink('all-access@bridge.test'));
    assert.equal(r.status, 503); assert.equal(r.body.error, 'entitlement_unavailable');
  } finally { nflLedgerMode = 'ok'; }
});

/* ------------------------------------------------------------ transport */
test('transport: the Worker prefers the BILLING Service Binding (Cloudflare error 1042) with the same token and product key; a failing binding grants nothing', async () => {
  const bindingCalls = [];
  const BILLING_BINDING = {
    async fetch(url, init) {
      bindingCalls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) });
      return new Response(JSON.stringify(yes(sub('active'))), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  const env = { ...ENV, BILLING: BILLING_BINDING, PBE_BILLING_URL: 'https://never-called.test' };
  const h = await (await worker.fetch(new Request('https://auth.bridge.test/health'), env)).json();
  assert.equal(h.all_access_bridge.transport, 'service_binding'); assert.equal(h.all_access_bridge.configured, true);
  resendCalls.length = 0; billingCalls.length = 0;
  await requestLink('binding-only@bridge.test', { env });
  assert.equal(resendCalls.length, 1, 'All Access via the binding earns the link');
  assert.equal(billingCalls.length, 0, 'no plain fetch left the Worker');
  assert.deepEqual(bindingCalls, [{ url: 'https://propbetedge-sports-billing/v1/entitlement', auth: `Bearer ${READ_TOKEN}`, body: { email: 'binding-only@bridge.test', product_key: 'pbe_all_access' } }]);
  resendCalls.length = 0;
  const down = { ...env, BILLING: { async fetch() { return new Response('{"error":"x"}', { status: 500 }); } } };
  await requestLink('binding-only@bridge.test', { env: down });
  assert.equal(resendCalls.length, 0, 'a failing binding grants nothing');
  const plain = await (await worker.fetch(new Request('https://auth.bridge.test/health'), ENV)).json();
  assert.equal(plain.all_access_bridge.transport, 'fetch');
});

/* ------------------------------------------------------------ invariants */
test('the shared All Access ledger is never copied: no write ever reaches nfl_subscriptions', () => {
  assert.deepEqual(nflWrites, []);
});

test('drift: both runtimes reach All Access through the one shared lookup; the bridge never accepts an identity exception or a missing period', () => {
  const ledger = read('api/_nfl-entitlement-ledger.js');
  assert.match(ledger, /export const ALL_ACCESS_PRODUCT_KEY = 'pbe_all_access'/);
  assert.match(ledger, /body\.access_source === 'owner' \|\| !sub \|\| sub\.product_key !== ALL_ACCESS_PRODUCT_KEY/);
  assert.match(ledger, /if \(end <= now\) return \{ entitled: false, reason: 'all_access_expired'/);
  assert.match(ledger, /const verdict = await lookupNflEntitlement\(email, ledger\);\s*if \(verdict\.entitled === true\) return verdict;/, 'NFL answers first, unchanged');
  assert.match(read('api/_nfl-auth.js'), /return lookupNflAccessVerdict\(email, \{/);
  const workerSrc = read('workers/nfl-auth/src/index-v5.js');
  assert.match(workerSrc, /allAccess:allAccessConfig\(env\)/);
  assert.equal(/pbe_sport_entitlements|rlfyavnhbngwbldebrid|supabase\.co\/rest\/v1\/pbe/.test(ledger + workerSrc + read('api/_nfl-auth.js')), false, 'NFL never reads the shared ledger directly; only through the billing Worker');
});
