/* NFL access unlock. Identity != entitlement.
 *
 * Proves, against the real handlers and a stubbed Supabase / gateway:
 *   · only a verifiable, current, explicitly-NFL purchase — or the verified
 *     owner — unlocks premium data
 *   · every premium route and premium variant fails closed (401 / 403 / 503)
 *     and leaks nothing; public routes are never refused
 *   · a premium response can never be shared by a cache
 *   · MLB / UFC / NBA / NHL subscriptions are not NFL subscriptions
 *   · signing in never changes access; typing the owner email grants nothing
 *   · the gateway lock refuses callers without the server token
 * No network call leaves the process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

Object.assign(process.env, {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  NFL_SESSION_SIGNING_SECRET: 'test-session-signing-secret',
  NFL_GATEWAY: 'https://gateway.test',
  NFL_GATEWAY_TOKEN: 'gateway-token-test-value',
  NFL_AUTH_WORKER_URL: 'https://auth-worker.test',
  NFL_OWNER_EMAILS: 'owner@propbetedge.test',
});

const auth = await import('../api/_nfl-auth.js');
const E = await import('../api/_nfl-entitlement.js');
const { PREMIUM_ROUTES, MIXED_ROUTES, PUBLIC_ROUTES } = await import('../api/_nfl-route-policy.js');
const { forwardablePath } = await import('../api/gw.js');

const API_DIR = fileURLToPath(new URL('../api/', import.meta.url));
const NOW = Date.now();
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

/* ---------------------------------------------------------------- fixtures */
const b64u = v => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sessionToken(email, { exp = Math.floor(NOW / 1000) + 3600, type = 'session' } = {}) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ email, type, iat: Math.floor(NOW / 1000), exp, jti: 't' }))}`;
  return `${data}.${b64u(createHmac('sha256', `${auth.HMAC_NAMESPACE}:${process.env.NFL_SESSION_SIGNING_SECRET}`).update(data).digest())}`;
}
const cookieFor = email => `${auth.SESSION_COOKIE}=${sessionToken(email)}`;

const P = E.NFL_PRICES;
const recurring = (email, over = {}) => ({
  status: 'active', customer_email: email, stripe_price_id: P.foundingMonthly,
  stripe_subscription_id: 'sub_1TestSubscription', stripe_customer_id: 'cus_TestCustomer', stripe_checkout_session_id: 'cs_live_TestCheckout',
  current_period_end: iso(NOW + 20 * DAY), cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over,
});
const seasonPass = (email, over = {}) => ({
  status: 'active', customer_email: email, stripe_price_id: P.legacySeasonPass,
  stripe_subscription_id: null, stripe_customer_id: 'cus_TestCustomer', stripe_checkout_session_id: 'cs_live_SeasonPass',
  current_period_end: '2027-02-15T05:59:59.000Z', cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over,
});

/* Production shape the brief names: active, no Stripe proof, no expiry. */
const ORPHAN = email => ({ status: 'active', customer_email: email, stripe_price_id: null, stripe_subscription_id: null, stripe_customer_id: null, stripe_checkout_session_id: null, current_period_end: null, created_at: '2026-08-01T00:00:00Z' });

/* Other sports' subscriptions. The MLB, UFC, NBA and NHL products bill through
   the same Stripe account under their own prices. */
const OTHER_SPORT_PRICES = {
  mlb: 'price_1MLBPropBetEdgeProMonthly',
  ufc: 'price_1UFCPropBetEdgeProMonthly',
  nba: 'price_1NBAPropBetEdgeProMonthly',
  nhl: 'price_1NHLPropBetEdgeProMonthly',
};

const LEDGER = new Map();           // email -> rows in nfl_subscriptions
const calls = { supabase: [], gateway: [], other: [] };
let supabaseMode = 'ok';            // ok | http500 | network | badjson
function resetWorld() {
  LEDGER.clear();
  calls.supabase.length = 0; calls.gateway.length = 0; calls.other.length = 0;
  supabaseMode = 'ok';
  auth.clearEntitlementCache();
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const headers = new Headers(init.headers || {});
  if (url.host === 'supabase.test') {
    calls.supabase.push({ path: url.pathname, search: decodeURIComponent(url.search) });
    if (supabaseMode === 'network') throw new TypeError('fetch failed');
    if (supabaseMode === 'http500') return json({ message: 'down' }, 500);
    if (supabaseMode === 'badjson') return new Response('<html>', { status: 200 });
    if (url.pathname !== '/rest/v1/nfl_subscriptions') return json({ error: 'unexpected table' }, 404);
    const raw = /customer_email=ilike\.([^&]+)/.exec(url.search)?.[1] || '';
    const literal = decodeURIComponent(raw).replace(/\\([%_*\\])/g, '$1');
    return json(LEDGER.get(literal) || []);
  }
  if (url.host === 'gateway.test') {
    calls.gateway.push({ path: url.pathname, search: url.search, token: headers.get('x-pbe-gateway-token') });
    return json({ ok: true, path: url.pathname, query: url.search, semantics: 'LAST_VERIFIED_MARKET' }, 200, { 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' });
  }
  if (url.host === 'auth-worker.test') {
    return json({ ok: true, session_token: sessionToken('brand-new@propbetedge.test') });
  }
  calls.other.push(url.toString());
  throw new Error(`unstubbed network call ${url}`);
};

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '', redirectedTo: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.headers['content-type'] ||= 'application/json'; this.body = JSON.stringify(b); return this; },
    send(b) { this.body = typeof b === 'string' ? b : JSON.stringify(b); return this; },
    end(b = '') { this.body = String(b); return this; },
    redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
  };
}
async function call(route, { cookie = '', query = {}, method = 'GET' } = {}) {
  const { default: handler } = await import(`../api/${route}`);
  const res = mockRes();
  await handler({ method, query, headers: cookie ? { cookie } : {}, url: `/api/${route}` }, res);
  let body = null; try { body = JSON.parse(res.body || 'null'); } catch (_) { body = res.body; }
  return { status: res.statusCode, headers: res.headers, text: res.body, body, res };
}
const session = email => auth.getNflSession({ headers: { cookie: cookieFor(email) } });

/* ======================================================== entitlement rules */

test('anonymous: no cookie is access=anonymous, never Pro', async () => {
  resetWorld();
  const s = await auth.getNflSession({ headers: {} });
  assert.equal(s.access, 'anonymous'); assert.equal(s.pro, false); assert.equal(s.valid, false);
  assert.equal(calls.supabase.length, 0);
});

test('valid email session with no subscription: identity yes, access no', async () => {
  resetWorld();
  const s = await session('free@propbetedge.test');
  assert.equal(s.valid, true);
  assert.equal(s.user.email, 'free@propbetedge.test');
  assert.equal(s.access, 'no_entitlement');
  assert.equal(s.pro, false);
  assert.equal(s.entitlement.reason, 'no_subscription');
});

test('active orphan row with no Stripe proof and no expiry is denied (the production rows)', async () => {
  resetWorld();
  LEDGER.set('orphan@propbetedge.test', [ORPHAN('orphan@propbetedge.test')]);
  const s = await session('orphan@propbetedge.test');
  assert.equal(s.access, 'no_entitlement'); assert.equal(s.pro, false);
  assert.equal(E.evaluateNflEntitlementRow(ORPHAN('x@y.co'), 'x@y.co', NOW).entitled, false);
});

test('active row with a recognized price and Stripe ids but NULL expiry is denied', async () => {
  resetWorld();
  for (const row of [recurring('n@p.test', { current_period_end: null }), seasonPass('n@p.test', { current_period_end: null })]) {
    const r = E.evaluateNflEntitlementRow(row, 'n@p.test', NOW);
    assert.equal(r.entitled, false); assert.equal(r.reason, 'null_expiry');
  }
  LEDGER.set('null@propbetedge.test', [recurring('null@propbetedge.test', { current_period_end: null })]);
  assert.equal((await session('null@propbetedge.test')).access, 'no_entitlement');
});

test('each missing Stripe proof is denied on its own', () => {
  const e = 'p@p.test';
  assert.equal(E.evaluateNflEntitlementRow(recurring(e, { stripe_subscription_id: null }), e, NOW).reason, 'no_stripe_subscription');
  assert.equal(E.evaluateNflEntitlementRow(recurring(e, { stripe_subscription_id: 'not-a-sub' }), e, NOW).reason, 'no_stripe_subscription');
  assert.equal(E.evaluateNflEntitlementRow(recurring(e, { stripe_customer_id: null }), e, NOW).reason, 'no_stripe_customer');
  assert.equal(E.evaluateNflEntitlementRow(seasonPass(e, { stripe_checkout_session_id: null }), e, NOW).reason, 'no_stripe_checkout');
  assert.equal(E.evaluateNflEntitlementRow(seasonPass(e, { stripe_subscription_id: 'sub_1X' }), e, NOW).reason, 'one_time_with_subscription');
  assert.equal(E.evaluateNflEntitlementRow(recurring(e, { stripe_price_id: null }), e, NOW).reason, 'no_price');
  assert.equal(E.evaluateNflEntitlementRow(recurring(e, { current_period_end: 'soon' }), e, NOW).reason, 'invalid_expiry');
});

test('expired NFL subscription is denied', async () => {
  resetWorld();
  LEDGER.set('expired@propbetedge.test', [recurring('expired@propbetedge.test', { current_period_end: iso(NOW - 1000) })]);
  const s = await session('expired@propbetedge.test');
  assert.equal(s.access, 'no_entitlement'); assert.equal(s.entitlement.reason, 'expired');
  assert.equal(E.evaluateNflEntitlementRow(seasonPass('a@b.co', { current_period_end: iso(NOW - DAY) }), 'a@b.co', NOW).reason, 'expired');
});

test('canceled and payment-failed NFL subscriptions are denied, even with a future period end', async () => {
  resetWorld();
  LEDGER.set('canceled@propbetedge.test', [recurring('canceled@propbetedge.test', { status: 'canceled' })]);
  const s = await session('canceled@propbetedge.test');
  assert.equal(s.access, 'no_entitlement'); assert.equal(s.entitlement.reason, 'canceled');
  for (const status of ['past_due', 'unpaid']) assert.equal(E.evaluateNflEntitlementRow(recurring('a@b.co', { status }), 'a@b.co', NOW).reason, 'payment_failed');
  for (const status of ['incomplete', 'paused', 'incomplete_expired', '']) assert.equal(E.evaluateNflEntitlementRow(recurring('a@b.co', { status }), 'a@b.co', NOW).entitled, false, status);
});

test('no perpetual rows: expiry beyond one billing period or the season pass end is denied', () => {
  const e = 'far@p.test';
  assert.equal(E.evaluateNflEntitlementRow(recurring(e, { current_period_end: '2099-01-01T00:00:00Z' }), e, NOW).reason, 'expiry_out_of_range');
  assert.equal(E.evaluateNflEntitlementRow(seasonPass(e, { current_period_end: '2099-01-01T00:00:00Z' }), e, NOW).reason, 'expiry_out_of_range');
  assert.equal(E.evaluateNflEntitlementRow(recurring(e, { current_period_end: iso(NOW + 44 * DAY) }), e, NOW).entitled, true);
});

test('MLB-only, UFC-only, NBA-only and NHL-only subscriptions are not NFL subscriptions', async () => {
  resetWorld();
  for (const [sport, price] of Object.entries(OTHER_SPORT_PRICES)) {
    const email = `${sport}-only@propbetedge.test`;
    LEDGER.set(email, [recurring(email, { stripe_price_id: price })]);
    const s = await session(email);
    assert.equal(s.access, 'no_entitlement', sport);
    assert.equal(s.pro, false, sport);
    assert.equal(s.entitlement.reason, 'not_an_nfl_price', sport);
    const r = await call('gw.js', { cookie: cookieFor(email), query: { __gw_path: 'api/picks/pass', event_id: 'e1' } });
    assert.equal(r.status, 403, `${sport} subscriber is refused premium NFL data`);
  }
  assert.ok(calls.supabase.every(c => c.path === '/rest/v1/nfl_subscriptions'), 'only the NFL ledger is ever consulted');
  assert.equal(calls.gateway.length, 0);
});

test('valid current NFL recurring subscriptions (all three recognized prices) are allowed', async () => {
  resetWorld();
  for (const [plan, price] of [['founding_monthly', P.foundingMonthly], ['founding_weekly', P.foundingWeekly], ['legacy_weekly', P.legacyWeekly]]) {
    const email = `${plan}@propbetedge.test`;
    LEDGER.set(email, [recurring(email, { stripe_price_id: price, current_period_end: iso(NOW + 6 * DAY) })]);
    const s = await session(email);
    assert.equal(s.access, 'granted', plan); assert.equal(s.pro, true, plan);
    assert.equal(s.entitlement.plan, plan); assert.equal(s.entitlement.billing, 'recurring');
    assert.ok(s.subscription.current_period_end);
  }
  LEDGER.set('trial@propbetedge.test', [recurring('trial@propbetedge.test', { status: 'trialing' })]);
  assert.equal((await session('trial@propbetedge.test')).access, 'granted');
});

test('valid current NFL one-time (season pass) entitlement is allowed', async () => {
  resetWorld();
  LEDGER.set('pass@propbetedge.test', [seasonPass('pass@propbetedge.test')]);
  const s = await session('pass@propbetedge.test');
  assert.equal(s.access, 'granted'); assert.equal(s.entitlement.plan, 'season_pass'); assert.equal(s.entitlement.billing, 'one_time');
});

test('a granting row wins over older denied rows for the same email; mixed-case ledger email still matches exactly', async () => {
  resetWorld();
  const email = 'mixed@propbetedge.test';
  LEDGER.set(email, [ORPHAN(email), recurring(email, { status: 'canceled' }), recurring('Mixed@PropBetEdge.test ')]);
  assert.equal((await session(email)).access, 'granted');
});

test('ilike wildcards cannot borrow another subscriber: j_stin is not justin', async () => {
  resetWorld();
  LEDGER.set('j_stin@propbetedge.test', [recurring('justin@propbetedge.test')]);   // what a wildcard query would have returned
  const s = await session('j_stin@propbetedge.test');
  assert.equal(s.access, 'no_entitlement');
  assert.equal(s.entitlement.reason, 'email_mismatch');
  assert.match(calls.supabase[0].search, /customer_email=ilike\.j\\_stin@propbetedge\.test/, 'the wildcard is escaped in the lookup');
  assert.equal(E.ilikeLiteral('a%b*c_d'), 'a\\%b\\*c\\_d');
});

test('entitlement lookup outage fails closed: HTTP 500, network error, unreadable body, missing key', async () => {
  for (const mode of ['http500', 'network', 'badjson']) {
    resetWorld(); supabaseMode = mode;
    LEDGER.set('pro@propbetedge.test', [recurring('pro@propbetedge.test')]);
    const s = await session('pro@propbetedge.test');
    assert.equal(s.access, 'unavailable', mode); assert.equal(s.pro, false, mode); assert.equal(s.degraded, true, mode);
    const r = await call('gw.js', { cookie: cookieFor('pro@propbetedge.test'), query: { __gw_path: 'api/picks/pass', event_id: 'e1' } });
    assert.equal(r.status, 503, mode); assert.equal(r.headers['x-pbe-access'], 'unavailable');
  }
  resetWorld();
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const s = await session('pro@propbetedge.test');
    assert.equal(s.access, 'unavailable'); assert.equal(s.stage, 'entitlement_secret_missing');
  } finally { process.env.SUPABASE_SERVICE_ROLE_KEY = saved; }
  assert.equal(calls.gateway.length, 0, 'no data is fetched during an outage');
});

test('the recognized NFL prices are exactly the prices the NFL billing webhook writes', () => {
  const billing = readFileSync(new URL('../workers/nfl-billing/src/index.js', import.meta.url), 'utf8');
  const block = /const PRICE = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(billing)[1];
  const written = new Set([...block.matchAll(/'(price_[A-Za-z0-9]+)'/g)].map(m => m[1]));
  assert.deepEqual([...written].sort(), Object.values(P).sort());
  const checkout = readFileSync(new URL('../api/checkout.js', import.meta.url), 'utf8');
  assert.ok(checkout.includes("SEASON_PASS_EXPIRES_AT = '2027-02-14T23:59:59-06:00'"), 'season pass cap matches the checkout expiry');
  assert.equal(E.SEASON_PASS_LATEST_EXPIRY_MS, Date.parse('2027-02-14T23:59:59-06:00'));
});

/* ============================================================ sign-in alone */

test('sign-in alone never changes Pro/access status', async () => {
  resetWorld();
  const { default: verify } = await import('../api/auth-verify.js');
  const res = mockRes();
  await verify({ method: 'GET', query: { token: 'x'.repeat(60) }, headers: {} }, res);
  assert.equal(res.statusCode, 302);
  const set = res.headers['set-cookie'].find(c => c.startsWith(`${auth.SESSION_COOKIE}=`));
  const cookie = set.split(';')[0];
  const { default: sessionRoute } = await import('../api/auth-session.js');
  const s = mockRes();
  await sessionRoute({ method: 'GET', headers: { cookie } }, s);
  const body = JSON.parse(s.body);
  assert.equal(body.valid, true, 'identity is established');
  assert.equal(body.user.email, 'brand-new@propbetedge.test');
  assert.equal(body.pro, false);
  assert.equal(body.access, 'no_entitlement');
  const data = await call('gw.js', { cookie, query: { __gw_path: 'api/picks/pass', event_id: 'e1' } });
  assert.equal(data.status, 403);
  assert.equal(calls.gateway.length, 0);
});

/* ========================================================= route inventory */

function apiRoutes(dir = API_DIR) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name.startsWith('_')) continue;
    if (statSync(full).isDirectory()) out.push(...apiRoutes(full));
    else if (name.endsWith('.js')) out.push(relative(API_DIR, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

test('every Vercel API route is classified PREMIUM, MIXED or PUBLIC, and nothing twice', () => {
  const routes = apiRoutes();
  const classified = [...PREMIUM_ROUTES, ...Object.keys(MIXED_ROUTES), ...Object.keys(PUBLIC_ROUTES)];
  assert.deepEqual(routes.filter(r => !classified.includes(r)), [], 'unclassified routes');
  assert.deepEqual(classified.filter(r => !routes.includes(r)), [], 'policy names a route that does not exist');
  assert.equal(new Set(classified).size, classified.length);
  for (const route of [...PREMIUM_ROUTES, ...Object.keys(MIXED_ROUTES)]) {
    const src = readFileSync(join(API_DIR, route), 'utf8');
    assert.match(src, /export default withNflEntitlement\(handler/, `${route} is wrapped by the one gate`);
  }
  for (const route of Object.keys(PUBLIC_ROUTES)) {
    const src = readFileSync(join(API_DIR, route), 'utf8');
    assert.doesNotMatch(src, /export default withNflEntitlement/, `${route} is public: no site-wide gate`);
  }
});

/* every premium route and premium variant of a mixed route */
const PREMIUM_PROBES = [
  ['pro-model.js', { event_id: 'e1' }],
  ['gw.js', { __gw_path: 'api/picks/pass', event_id: 'e1' }],
  ['pbe-picks.js', { view: 'current' }],
  ['pbe-picks.js', { view: 'validation-history' }],
  ['pbe-picks.js', { view: 'decision', id: '11111111-1111-4111-8111-111111111111' }],
  ['pbe-prop-picks.js', { view: 'current' }],
];

for (const [route, query] of PREMIUM_PROBES) {
  test(`premium data without entitlement is denied: /api/${route}?${new URLSearchParams(query)}`, async () => {
    resetWorld();
    LEDGER.set('orphan@propbetedge.test', [ORPHAN('orphan@propbetedge.test')]);
    const cases = [
      ['anonymous', '', 401, 'anonymous'],
      ['forged cookie', `${auth.SESSION_COOKIE}=eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InByb0B4LmNvbSJ9.AAAA`, 401, 'anonymous'],
      ['signed in, no subscription', cookieFor('free@propbetedge.test'), 403, 'no_entitlement'],
      ['active orphan row', cookieFor('orphan@propbetedge.test'), 403, 'no_entitlement'],
      /* client-side claims are ignored, including a claimed owner role */
      ['client flags', `pbe_pro=1; subscribed=true; role=owner; owner=owner@propbetedge.test; ${auth.LEGACY_SESSION_COOKIE}=granted`, 401, 'anonymous'],
    ];
    for (const [label, cookie, status, access] of cases) {
      const r = await call(route, { cookie, query: { ...query, subscribed: 'true', pro: '1', role: 'owner', email: 'owner@propbetedge.test' } });
      assert.equal(r.status, status, `${route} ${label}`);
      assert.equal(r.headers['x-pbe-access'], access, `${route} ${label}`);
      assert.equal(r.headers['cache-control'], 'private, no-store, max-age=0', `${route} ${label} is never cacheable`);
      assert.deepEqual(Object.keys(r.body).sort(), status === 401 ? ['access', 'entitlement', 'error', 'product'] : ['access', 'error', 'product', 'reason'], `${route} ${label} carries no data`);
    }
    supabaseMode = 'http500';
    const outage = await call(route, { cookie: cookieFor('pro@propbetedge.test'), query });
    assert.equal(outage.status, 503, `${route} outage`);
    assert.equal(calls.gateway.length, 0, `${route}: no upstream read happened for any refused call`);
    assert.equal(calls.other.length, 0);
  });
}

/* public routes and the public variants of mixed routes: never refused for
   lack of a subscription (the handlers may still fail on their stubbed
   upstreams — that is not an access decision) */
const PUBLIC_PROBES = [
  ['gw.js', { __gw_path: 'api/best-line' }], ['gw.js', { __gw_path: 'api/odds/board', event_id: 'e1', markets: 'player_pass_yds' }],
  ['pbe-picks.js', { view: 'state' }], ['pbe-picks.js', { view: 'preview' }], ['pbe-picks.js', { view: 'trackrecord' }], ['pbe-picks.js', { view: 'receipt' }],
  ['pbe-prop-picks.js', { view: 'state' }], ['pbe-prop-picks.js', { view: 'trackrecord' }],
  ['game-intel.js', { event_id: 'e1' }], ['home-market.js', { away: 'a', home: 'b' }], ['weather-watch.js', {}], ['pbe-validation.js', {}],
  ['qb-dna.js', { list: '1' }], ['wr-dna.js', { list: '1' }], ['rb-dna.js', { list: '1' }], ['te-dna.js', { list: '1' }],
];
test('public site data is never refused for a visitor without a subscription', async () => {
  for (const [route, query] of PUBLIC_PROBES) {
    resetWorld();
    const r = await call(route, { query });
    assert.ok(![401, 403].includes(r.status), `${route} ${JSON.stringify(query)} -> ${r.status}`);
    assert.equal(r.headers['x-pbe-access'], undefined, `${route} ${JSON.stringify(query)} made no access decision`);
  }
});

test('PBE Picks: live selections are premium; state, preview, record and receipts are public', async () => {
  resetWorld();
  for (const view of ['current', 'validation-history', 'decision']) assert.equal((await call('pbe-picks.js', { query: { view } })).status, 401, view);
  for (const view of ['state', 'preview', 'trackrecord', 'receipt']) assert.ok(![401, 403].includes((await call('pbe-picks.js', { query: { view } })).status), view);
});

/* ============================================================ granted path */

test('premium data with a valid entitlement is allowed, forwarded with the server token, and private', async () => {
  resetWorld();
  LEDGER.set('pro@propbetedge.test', [recurring('pro@propbetedge.test')]);
  const r = await call('gw.js', { cookie: cookieFor('pro@propbetedge.test'), query: { __gw_path: 'api/picks/pass', event_id: 'e1' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.path, '/api/picks/pass');
  assert.equal(r.body.query, '?event_id=e1', '__gw_path is not forwarded');
  assert.equal(calls.gateway[0].token, 'gateway-token-test-value', 'server-only token attached upstream');
  assert.equal(r.headers['cache-control'], 'private, no-store, max-age=0', 'upstream public caching is not passed through');
  assert.equal(r.headers['x-pbe-access'], 'granted');
  assert.match(String(r.headers.vary), /Cookie/);
  assert.equal(r.text.includes('gateway-token-test-value'), false, 'the token never reaches the browser');

  const model = await call('pro-model.js', { cookie: cookieFor('pro@propbetedge.test'), query: { event_id: 'e1' } });
  assert.equal(model.status, 200);
  assert.equal(calls.gateway.at(-1).path, '/api/picks/pass');
  assert.equal(calls.gateway.at(-1).token, 'gateway-token-test-value');
});

test('a public gateway read needs no session, is shared-cacheable, and still never exposes the token', async () => {
  resetWorld();
  const r = await call('gw.js', { query: { __gw_path: 'api/odds/board', event_id: 'e1', markets: 'player_pass_yds' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=30, s-maxage=60');
  assert.equal(calls.gateway[0].token, 'gateway-token-test-value');
  assert.equal(r.text.includes('gateway-token-test-value'), false);
});

/* ============================================================ owner access */

test('owner: a verified owner session unlocks every premium route without a subscription or ledger read', async () => {
  resetWorld();
  const cookie = cookieFor('Owner@PropBetEdge.test'.toLowerCase());
  const s = await session('owner@propbetedge.test');
  assert.equal(s.access, 'granted'); assert.equal(s.pro, true); assert.equal(s.role, 'owner');
  assert.equal(s.entitlement.plan, 'owner');
  for (const [route, query] of PREMIUM_PROBES) {
    const r = await call(route, { cookie, query });
    /* the gate's decision; a stubbed picks backend may still answer 503 after it */
    assert.equal(r.headers['x-pbe-access'], 'granted', `${route} ${JSON.stringify(query)} -> ${r.status}`);
    assert.ok(![401, 403].includes(r.status), `${route} ${JSON.stringify(query)} -> ${r.status}`);
  }
  assert.equal(calls.supabase.filter(c => c.path === '/rest/v1/nfl_subscriptions').length, 0, 'owner is not a subscription lookup');
  supabaseMode = 'http500';
  assert.equal((await session('owner@propbetedge.test')).access, 'granted', 'an entitlement-store outage does not lock the owner out');
});

test('owner: typing the owner email, a request field, a client role or a forged session grants nothing', async () => {
  resetWorld();
  const q = { __gw_path: 'api/picks/pass', event_id: 'e1', email: 'owner@propbetedge.test', role: 'owner', owner: '1' };
  assert.equal((await call('gw.js', { query: q })).status, 401, 'email in the request');
  assert.equal((await call('gw.js', { cookie: 'role=owner; email=owner@propbetedge.test; pbe_owner=1', query: q })).status, 401, 'client cookies');
  const b64 = v => Buffer.from(v).toString('base64url');
  const unsigned = `${b64(JSON.stringify({ alg: 'none' }))}.${b64(JSON.stringify({ email: 'owner@propbetedge.test', type: 'session', exp: Math.floor(Date.now() / 1000) + 600 }))}.`;
  assert.equal((await call('gw.js', { cookie: `${auth.SESSION_COOKIE}=${unsigned}`, query: q })).status, 401, 'unsigned session');
  const wrongKey = createHmac('sha256', `${auth.HMAC_NAMESPACE}:not-the-secret`);
  const data = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ email: 'owner@propbetedge.test', type: 'session', iat: 1, exp: Math.floor(Date.now() / 1000) + 600 }))}`;
  assert.equal((await call('gw.js', { cookie: `${auth.SESSION_COOKIE}=${data}.${b64(wrongKey.update(data).digest())}`, query: q })).status, 401, 'session signed with another key');
  const magic = sessionToken('owner@propbetedge.test', { type: 'magic' });
  assert.equal((await call('gw.js', { cookie: `${auth.SESSION_COOKIE}=${magic}`, query: q })).status, 401, 'a magic-link token is not a session');
  const expired = sessionToken('owner@propbetedge.test', { exp: Math.floor(Date.now() / 1000) - 5 });
  assert.equal((await call('gw.js', { cookie: `${auth.SESSION_COOKIE}=${expired}`, query: q })).status, 401, 'expired owner session');
});

test('owner: the designation is server configuration; without it the same account is an ordinary user', async () => {
  resetWorld();
  const saved = process.env.NFL_OWNER_EMAILS;
  try {
    delete process.env.NFL_OWNER_EMAILS;
    const s = await session('owner@propbetedge.test');
    assert.equal(s.access, 'no_entitlement'); assert.equal(s.role, undefined);
    process.env.NFL_OWNER_EMAILS = 'not-an-email, ,';
    assert.equal((await session('owner@propbetedge.test')).access, 'no_entitlement');
  } finally { process.env.NFL_OWNER_EMAILS = saved; }
  assert.equal(auth.isOwnerEmail('someone@propbetedge.test'), false);
});

test('owner: signing out clears the session cookie and access with it', async () => {
  resetWorld();
  const { default: logout } = await import('../api/auth-logout.js');
  const res = mockRes();
  await logout({ method: 'POST', headers: { cookie: cookieFor('owner@propbetedge.test') } }, res);
  assert.ok(res.headers['set-cookie'].some(c => c.startsWith(`${auth.SESSION_COOKIE}=;`) && /Max-Age=0/.test(c)));
  assert.equal((await call('gw.js', { query: { __gw_path: 'api/picks/pass', event_id: 'e1' } })).status, 401, 'no cookie after sign-out: no access');
});

test('gw forwards only allow-listed read routes', async () => {
  for (const ok of ['api/odds', 'api/odds/board', 'api/odds/prop-coverage', 'api/best-line', 'api/changes', 'api/picks/pass', 'api/season', 'api/replay/enrich']) {
    assert.equal(forwardablePath(ok), `/${ok}`, ok);
  }
  for (const bad of ['api/odds/ingest', 'api/odds/snapshot', 'api/current/refresh', 'api/current/diag', 'api/intel/run', 'api/news', 'api/historical',
    'api/odds/../current/refresh', 'api/odds%2F..%2Fcurrent%2Frefresh', 'api//odds', 'api/odds?x=1', '', 'https://evil.test/api/odds']) {
    assert.equal(forwardablePath(bad), null, bad);
  }
  resetWorld();
  LEDGER.set('pro@propbetedge.test', [recurring('pro@propbetedge.test')]);
  const post = await call('gw.js', { method: 'POST', cookie: cookieFor('pro@propbetedge.test'), query: { __gw_path: 'api/odds' } });
  assert.equal(post.status, 405);
  const admin = await call('gw.js', { cookie: cookieFor('pro@propbetedge.test'), query: { __gw_path: 'api/odds/ingest' } });
  assert.equal(admin.status, 404);
  assert.equal(calls.gateway.length, 0);
});

test('grants are cached briefly for data routes; denials never are, and a fresh check revokes', async () => {
  resetWorld();
  const email = 'cache@propbetedge.test';
  LEDGER.set(email, [recurring(email)]);
  const q = { __gw_path: 'api/picks/pass', event_id: 'e1' };
  assert.equal((await call('gw.js', { cookie: cookieFor(email), query: q })).status, 200);
  assert.equal((await call('gw.js', { cookie: cookieFor(email), query: q })).status, 200);
  assert.equal(calls.supabase.length, 1, 'second data read reused the grant');

  LEDGER.set(email, [recurring(email, { status: 'canceled' })]);
  const { default: sessionRoute } = await import('../api/auth-session.js');
  const s = mockRes();
  await sessionRoute({ method: 'GET', headers: { cookie: cookieFor(email) } }, s);
  assert.equal(JSON.parse(s.body).access, 'no_entitlement', 'auth-session always reads the ledger fresh');
  assert.equal((await call('gw.js', { cookie: cookieFor(email), query: q })).status, 403, 'the denial cleared the cached grant');

  resetWorld();
  assert.equal((await call('gw.js', { cookie: cookieFor(email), query: q })).status, 403);
  LEDGER.set(email, [recurring(email)]);
  assert.equal((await call('gw.js', { cookie: cookieFor(email), query: q })).status, 200, 'a denial is never cached: a new purchase opens immediately');
});

/* ============================================================ gateway lock */

test('gateway lock: enforcement refuses callers without the server token and strips it upstream', async () => {
  const gateway = (await import('../workers/nfl-gateway/index.js')).default;
  const { gatewayAccess } = await import('../workers/nfl-gateway/index.js');
  const seen = [];
  const binding = { fetch: async req => { seen.push(req.headers.get('x-pbe-gateway-token')); return json({ ok: true }); } };
  const env = { ENV: 'production', REQUIRE_GATEWAY_TOKEN: 'true', NFL_GATEWAY_TOKEN: 'gw-secret', NFL_ODDS: binding, NFL_INTEL: binding, NFL_CURRENT: binding, NFL_PICKS: binding };
  const req = (path, token) => new Request(`https://nfl-api.propbetedge.ai${path}`, { headers: token ? { 'x-pbe-gateway-token': token } : {} });

  assert.equal((await gateway.fetch(req('/api/odds/board?event_id=e1'), env)).status, 401);
  assert.equal((await gateway.fetch(req('/api/best-line', 'wrong'), env)).status, 401);
  assert.equal((await gateway.fetch(req('/api/picks/pass?event_id=e1', 'gw-secre'), env)).status, 401);
  assert.equal(seen.length, 0, 'no upstream Worker was reached');
  assert.equal((await gateway.fetch(req('/api/health'), env)).status, 200, 'health stays public');

  const ok = await gateway.fetch(req('/api/odds/board?event_id=e1', 'gw-secret'), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, [null], 'the token authorizes the hop and is not forwarded');

  const unconfigured = await gateway.fetch(req('/api/best-line', 'anything'), { ...env, NFL_GATEWAY_TOKEN: '' });
  assert.equal(unconfigured.status, 503, 'enforcement on without a secret fails closed');
  assert.equal(gatewayAccess(req('/api/best-line'), { REQUIRE_GATEWAY_TOKEN: 'false' }), null, 'staged rollout: off until step 4');
});
