/* NFL access v2 — additive Pro access on the 4c24d00 baseline.
 *
 * 1. The public application never waits on, or is hidden by, access.
 * 2. Pro is decided server-side by one pure predicate (api/_nfl-entitlement.js)
 *    or the verified owner, and every other answer is explicit.
 * 3. Premium routes refuse without Pro: 401 signed out, 403 no purchase,
 *    503 when the check cannot answer. The owner passes.
 *
 *   node --test tests/nfl-access-v2.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.NFL_SESSION_SIGNING_SECRET = 'access-v2-signing-secret';
process.env.NFL_OWNER_EMAILS = 'owner@propbetedge.test';
process.env.NFL_GATEWAY_TOKEN = 'access-v2-server-model-credential';

const auth = await import('../api/_nfl-auth.js');
const ent = await import('../api/_nfl-entitlement.js');
const { SESSION_COOKIE, HMAC_NAMESPACE, getNflSession } = auth;
const SECRET = process.env.NFL_SESSION_SIGNING_SECRET;
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const b64u = v => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (payload, secret = SECRET) => {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${secret}`).update(data).digest())}`;
};
const nowS = () => Math.floor(Date.now() / 1000);
const session = (email, over = {}, secret) => sign({ email, type: 'session', iat: nowS(), exp: nowS() + 86400, jti: 'x', ...over }, secret);
const cookieFor = email => `${SESSION_COOKIE}=${session(email)}`;
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

/* ledger rows as the billing Worker writes them */
const P = ent.NFL_PRICES;
const sub = (email, price, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: price, stripe_subscription_id: 'sub_1Test', stripe_customer_id: 'cus_Test', stripe_checkout_session_id: 'cs_live_Test', current_period_end: iso(Date.now() + 5 * DAY), cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over });
const LEDGER = {
  'weekly@qa.test': [sub('weekly@qa.test', P.foundingWeekly)],
  'monthly@qa.test': [sub('monthly@qa.test', P.foundingMonthly, { current_period_end: iso(Date.now() + 20 * DAY) })],
  'expired@qa.test': [sub('expired@qa.test', P.foundingWeekly, { current_period_end: iso(Date.now() - DAY) })],
  'canceled@qa.test': [sub('canceled@qa.test', P.foundingMonthly, { status: 'canceled' })],
  'pastdue@qa.test': [sub('pastdue@qa.test', P.foundingMonthly, { status: 'past_due' })],
  /* an NFL price with Stripe ids but no period end: never perpetual */
  'nullexp@qa.test': [sub('nullexp@qa.test', P.foundingMonthly, { current_period_end: null })],
  /* what 4c24d00 wrongly granted: an orphan active row and another sport's price */
  'nonsub@qa.test': [
    { customer_email: 'nonsub@qa.test', status: 'active', stripe_price_id: null, current_period_end: null, created_at: '2026-09-01T00:00:00Z' },
    sub('nonsub@qa.test', 'price_1MLBProWeekly'),
  ],
};

let ledgerMode = 'ok';
const realFetch = globalThis.fetch;
const requested = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host === 'supabase.test' && u.pathname === '/rest/v1/nfl_subscriptions') {
    requested.push(decodeURIComponent(u.search));
    if (ledgerMode === 'down') return new Response('{"message":"down"}', { status: 503 });
    if (ledgerMode === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const email = (/customer_email=ilike\.([^&]+)/.exec(decodeURIComponent(u.search))?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return new Response(JSON.stringify(LEDGER[email] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.host === 'nfl-api.propbetedge.ai') return new Response('{"model":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};
const req = cookie => ({ method: 'GET', headers: { cookie: cookie || '' }, query: {} });

/* ------------------------------------------------------------ identities */
const IDENTITIES = [
  ['anonymous', '', { access: 'anonymous', pro: false, valid: false }],
  ['new unpaid user', cookieFor('newuser@qa.test'), { access: 'no_entitlement', pro: false, reason: 'no_subscription' }],
  ['signed-in non-subscriber (orphan + other sport)', cookieFor('nonsub@qa.test'), { access: 'no_entitlement', pro: false }],
  ['active weekly subscriber', cookieFor('weekly@qa.test'), { access: 'granted', pro: true, role: 'subscriber', plan: 'founding_weekly' }],
  ['active monthly subscriber', cookieFor('monthly@qa.test'), { access: 'granted', pro: true, role: 'subscriber', plan: 'founding_monthly' }],
  ['owner', cookieFor('owner@propbetedge.test'), { access: 'granted', pro: true, role: 'owner', reason: 'owner' }],
  ['expired subscriber', cookieFor('expired@qa.test'), { access: 'no_entitlement', pro: false, reason: 'expired' }],
  ['canceled subscriber', cookieFor('canceled@qa.test'), { access: 'no_entitlement', pro: false, reason: 'canceled' }],
  ['past-due subscriber', cookieFor('pastdue@qa.test'), { access: 'no_entitlement', pro: false, reason: 'payment_failed' }],
  ['NFL price with no period end', cookieFor('nullexp@qa.test'), { access: 'no_entitlement', pro: false, reason: 'null_expiry' }],
];
for (const [name, cookie, want] of IDENTITIES) {
  test(`session verdict: ${name}`, async () => {
    const s = await getNflSession(req(cookie));
    assert.equal(s.access, want.access);
    assert.equal(s.pro, want.pro);
    assert.equal(s.degraded, false);
    if ('valid' in want) assert.equal(s.valid, want.valid);
    if (want.role) assert.equal(s.role, want.role);
    if (want.reason) assert.equal(s.entitlement.reason, want.reason);
    if (want.plan) { assert.equal(s.entitlement.plan, want.plan); assert.equal(s.subscription.plan, want.plan); }
  });
}

test('the owner is granted without a ledger lookup, even while the ledger is down', async () => {
  requested.length = 0; ledgerMode = 'down';
  try {
    const s = await getNflSession(req(cookieFor('owner@propbetedge.test')));
    assert.equal(s.access, 'granted'); assert.equal(s.role, 'owner'); assert.equal(requested.length, 0);
  } finally { ledgerMode = 'ok'; }
});

test('owner access needs the server env: unset, the same verified email is an ordinary account', async () => {
  const saved = process.env.NFL_OWNER_EMAILS; delete process.env.NFL_OWNER_EMAILS;
  try {
    const s = await getNflSession(req(cookieFor('owner@propbetedge.test')));
    assert.equal(s.access, 'no_entitlement'); assert.equal(s.pro, false); assert.equal(s.role, null);
  } finally { process.env.NFL_OWNER_EMAILS = saved; }
});

test('nothing a browser sends makes it the owner or a subscriber', async () => {
  const forged = [
    `${SESSION_COOKIE}=${session('owner@propbetedge.test', {}, 'attacker-key')}`,          // wrong key
    `${SESSION_COOKIE}=${session('owner@propbetedge.test', { exp: nowS() - 5 })}`,          // expired
    `${SESSION_COOKIE}=${session('owner@propbetedge.test', { type: 'magic' })}`,            // magic token as session
    `${SESSION_COOKIE}=eyJhbGciOiJub25lIn0.${b64u(JSON.stringify({ email: 'owner@propbetedge.test', type: 'session', exp: nowS() + 999 }))}.`,
    'pbe_role=owner; subscribed=true; pbe_pro=1',
  ];
  for (const cookie of forged) {
    const r = { method: 'GET', headers: { cookie, 'x-pbe-role': 'owner', 'x-user-email': 'owner@propbetedge.test' }, query: { email: 'owner@propbetedge.test', role: 'owner' } };
    const s = await getNflSession(r);
    assert.equal(s.pro, false, cookie.slice(0, 40)); assert.notEqual(s.access, 'granted'); assert.equal(s.role, null);
  }
});

test('ledger outage and ledger timeout are `unavailable`, never granted and never "no subscription"', async () => {
  for (const mode of ['down', 'hang']) {
    ledgerMode = mode;
    const t0 = Date.now();
    try {
      const s = await getNflSession(req(cookieFor('monthly@qa.test')));
      assert.equal(s.access, 'unavailable', mode); assert.equal(s.pro, false); assert.equal(s.degraded, true);
      assert.ok(Date.now() - t0 < auth.ENTITLEMENT_TIMEOUT_MS + 1500, `${mode} answered within the timeout`);
    } finally { ledgerMode = 'ok'; }
  }
});

test('the ledger lookup escapes ilike wildcards; the match itself is exact', async () => {
  requested.length = 0;
  LEDGER['a_b@qa.test'] = [sub('axb@qa.test', P.foundingMonthly)];
  const s = await getNflSession(req(cookieFor('a_b@qa.test')));
  assert.match(requested[0], /customer_email=ilike\.a\\_b@qa\.test/);
  assert.equal(s.pro, false);
});

/* ------------------------------------------------------------ premium routes */
function mockRes() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = JSON.stringify(b); return this; }, send(b) { this.body = String(b); return this; }, end(b) { this.body = String(b ?? ''); return this; } };
}
test('premium: /api/pro-model 401 signed out, 403 no purchase, 503 unavailable, allowed for subscriber and owner', async () => {
  const { default: handler } = await import('../api/pro-model.js');
  const call = async cookie => { const res = mockRes(); await handler({ method: 'GET', headers: { cookie }, query: { event_id: 'e1' } }, res); return res.statusCode; };
  assert.equal(await call(''), 401);
  assert.equal(await call(cookieFor('newuser@qa.test')), 403);
  assert.equal(await call(cookieFor('expired@qa.test')), 403);
  assert.equal(await call(cookieFor('nonsub@qa.test')), 403);
  assert.equal(await call(cookieFor('weekly@qa.test')), 200);
  assert.equal(await call(cookieFor('owner@propbetedge.test')), 200);
  ledgerMode = 'down';
  try { assert.equal(await call(cookieFor('monthly@qa.test')), 503); } finally { ledgerMode = 'ok'; }
});

test('auth-session carries the access verdict, and its failure path is `unavailable`', async () => {
  const { default: handler } = await import('../api/auth-session.js');
  const res = mockRes(); await handler(req(cookieFor('owner@propbetedge.test')), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200); assert.equal(body.access, 'granted'); assert.equal(body.role, 'owner');
  assert.match(res.headers['cache-control'], /private/);
  assert.match(read('api/auth-session.js'), /status\(500\)\.json\(\{\s+valid: false,\s+pro: false,\s+access: 'unavailable'/);
});

test('entitlement prices match the billing Worker that writes the ledger', () => {
  const worker = read('workers/nfl-billing/src/index.js');
  for (const id of Object.values(P)) assert.ok(worker.includes(id), id);
});

/* ------------------------------------------------------------ the shell is never locked */
test('index.html loads the application exactly as 4c24d00 did: no access gate, no hidden shell', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
  assert.deepEqual(scripts, ['./app-core-v3.js', './archive/utils.js', './archive/teams.js', './archive/superbowls.js', './archive/hof.js', './archive/seasons.js', './archive/records.js',
    './archive/stats-2025.js', './archive/standings-2025.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', './paywall.js', './ui-v2.js', './prop-board-v3.js', './model-lab.js', './page-loader.js']);
  assert.equal(existsSync(new URL('../nfl-access-gate-v1.js', import.meta.url)), false);
  const styles = readdirSync(new URL('..', import.meta.url)).filter(f => /\.(css|html)$/.test(f)).map(f => read(f)).join('\n');
  assert.equal(/data-pbe-access/.test(styles), false, 'no stylesheet keys layout off the access verdict');
});

test('paywall.js: bounded session check, explicit failure state, never touches the application shell', () => {
  const src = read('paywall.js');
  assert.match(src, /const SESSION_TIMEOUT_MS = 8000;/);
  assert.match(src, /signal: controller\.signal/);
  assert.match(src, /state\.access = 'unavailable';/);
  assert.match(src, /if \(state\.user\) return;/, 'one owner for the signed-in check-failed screen (sports-shell-auth-state.js)');
  assert.equal(/\$\d|renew|trial/i.test(read('paywall-polish-v1.js').replace(/window\.PBEPricing[^`]*/g, '')), false, 'the polish pass never states a price or billing term of its own');
  assert.match(src, /state\.pro = Boolean\(valid && payload\?\.pro === true && access === 'granted'\);/);
  assert.equal(/\.shell|#view-container|setWall|is-wall|location\.reload/.test(src), false, 'access never hides, walls or reloads the app');
  assert.equal(/localStorage[^\n]*(pro|access|owner|role)/i.test(src), false, 'no client storage decides access');
});
