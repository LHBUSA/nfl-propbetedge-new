/* Lapsed NFL sessions stay signed in (owner decision 2026-10-05, "keep
 * lapsed sessions"; benchmark bug B1).
 *
 * The fix lives ONLY in api/auth-session.js: a VERIFIED session whose verdict
 * is no_entitlement is no longer converted into an anonymous answer with a
 * purged cookie. Entitlement truth (api/_nfl-auth.js getNflSession) is
 * untouched, so every premium route still refuses the session.
 *
 *   1 active NFL entitlement  -> unchanged Pro
 *   2 All Access              -> unchanged (all_access)
 *   3 owner                   -> unchanged owner
 *   4 lapsed / not entitled   -> email kept, cookie kept, pro:false
 *   5 lapsed session          -> refused by EVERY protected NFL endpoint
 *   6 malformed / expired / forged cookie -> signed out, no identity (unchanged)
 *   7 explicit logout         -> clears the session
 *   8 entitlement lookup down -> degraded access check, never "lapsed"
 *
 *   node --test tests/nfl-lapsed-session.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const SECRET = 'lapsed-session-signing-secret';
const SUPABASE = 'https://supabase.lapsed.test';
const BILLING = 'https://billing.lapsed.test';
const READ_TOKEN = 'lapsed-billing-read-token';
Object.assign(process.env, {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: 'lapsed-service-role-key',
  NFL_SESSION_SIGNING_SECRET: SECRET,
  NFL_OWNER_EMAILS: 'owner@lapsed.test',
  NFL_GATEWAY_TOKEN: 'lapsed-model-credential',
  PBE_BILLING_URL: BILLING,
  PBE_ENTITLEMENT_READ_TOKEN: READ_TOKEN,
});

const ent = await import('../api/_nfl-entitlement.js');
const { SESSION_COOKIE, HMAC_NAMESPACE } = await import('../api/_nfl-auth.js');
const { default: authSession } = await import('../api/auth-session.js');
const { default: authLogout } = await import('../api/auth-logout.js');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const P = ent.NFL_PRICES;
const recurring = (email, price, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: price, stripe_subscription_id: 'sub_1Lapsed', stripe_customer_id: 'cus_Lapsed', stripe_checkout_session_id: 'cs_live_Lapsed', current_period_end: iso(Date.now() + 5 * DAY), cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over });
const LEDGER = {
  'monthly@lapsed.test': [recurring('monthly@lapsed.test', P.foundingMonthly, { current_period_end: iso(Date.now() + 20 * DAY) })],
  'expired@lapsed.test': [recurring('expired@lapsed.test', P.foundingWeekly, { current_period_end: iso(Date.now() - DAY) })],
  'canceled@lapsed.test': [recurring('canceled@lapsed.test', P.foundingMonthly, { status: 'canceled' })],
  'never@lapsed.test': [],
  'platinum@lapsed.test': [],
  'owner@lapsed.test': [],
};
const ALL_ACCESS = {
  'platinum@lapsed.test': { entitled: true, product_key: 'pbe_all_access', access_source: 'all_access', subscription: { product_key: 'pbe_all_access', plan: 'monthly', status: 'active', current_period_end: iso(Date.now() + 20 * DAY), cancel_at_period_end: false } },
};

let ledgerMode = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin === SUPABASE && u.pathname === '/rest/v1/nfl_subscriptions') {
    if (ledgerMode === 'down') return new Response('{"message":"down"}', { status: 503 });
    const email = (/customer_email=ilike\.([^&]+)/.exec(decodeURIComponent(u.search))?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return new Response(JSON.stringify(LEDGER[email] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.origin === SUPABASE) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.origin === BILLING) {
    const body = JSON.parse(init.body || '{}');
    const answer = ALL_ACCESS[String(body.email).toLowerCase()] || { entitled: false, product_key: 'pbe_all_access', access_source: null, subscription: null };
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.host === 'nfl-api.propbetedge.ai') return new Response('{"model":"PAID_MODEL_VALUE"}', { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : v).toString('base64url');
function mint(payload, secret = SECRET) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${secret}`).update(data).digest())}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const cookieFor = (email, over = {}) => `${SESSION_COOKIE}=${mint({ email, type: 'session', iat: nowS(), exp: nowS() + 86400, jti: crypto.randomUUID(), ...over })}`;
function mockRes() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = JSON.stringify(b); return this; }, send(b) { this.body = typeof b === 'string' ? b : JSON.stringify(b); return this; }, end(b) { this.body = String(b ?? ''); return this; }, redirect(c, l) { this.statusCode = c; this.headers.location = l; return this; } };
}
async function session(cookie) {
  const res = mockRes();
  await authSession({ method: 'GET', headers: cookie ? { cookie } : {} }, res);
  return { res, body: JSON.parse(res.body) };
}
const purged = (res) => [].concat(res.headers['set-cookie'] || []).some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/.test(c));

/* ------------------------------------------------------------ 1-3 entitled answers unchanged */
test('1. valid session + active NFL entitlement -> unchanged Pro answer, cookie kept', async () => {
  const { res, body } = await session(cookieFor('monthly@lapsed.test'));
  assert.equal(res.statusCode, 200);
  assert.equal(body.valid, true); assert.equal(body.pro, true); assert.equal(body.access, 'granted');
  assert.equal(body.user.email, 'monthly@lapsed.test'); assert.equal(body.membership.state, 'sport_pro');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('2. valid session + All Access -> unchanged all_access answer (shown as Platinum by the UI only)', async () => {
  const { res, body } = await session(cookieFor('platinum@lapsed.test'));
  assert.equal(body.pro, true); assert.equal(body.access, 'granted');
  assert.equal(body.membership.state, 'all_access'); assert.equal(body.membership.label, 'ALL ACCESS ACTIVE', 'the backend vocabulary is untouched');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('3. valid owner -> unchanged owner answer', async () => {
  const { res, body } = await session(cookieFor('owner@lapsed.test'));
  assert.equal(body.pro, true); assert.equal(body.role, 'owner'); assert.equal(body.membership.state, 'owner');
  assert.equal(res.headers['set-cookie'], undefined);
});

/* ------------------------------------------------------------ 4 the change */
test('4. valid session + no entitlement -> signed in: email kept, cookie NOT purged, pro:false, contract non-entitled membership', async () => {
  for (const [email, reason] of [['expired@lapsed.test', 'expired'], ['canceled@lapsed.test', 'canceled'], ['never@lapsed.test', 'no_subscription']]) {
    const { res, body } = await session(cookieFor(email));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      { valid: body.valid, pro: body.pro, access: body.access, paywalled: body.paywalled, user: body.user, entitlement: body.entitlement, subscription: body.subscription, degraded: body.degraded, session_cleared: body.session_cleared, role: body.role },
      { valid: true, pro: false, access: 'no_entitlement', paywalled: true, user: { email }, entitlement: { reason }, subscription: null, degraded: false, session_cleared: false, role: null },
      email,
    );
    assert.equal(body.membership.state, 'free'); assert.equal(body.membership.entitled, false); assert.equal(body.membership.email, email);
    assert.equal(purged(res), false, `${email}: the verified session cookie is kept`);
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

/* ------------------------------------------------------------ 5 premium still refused */
const PROTECTED = [
  ['pbe-picks', '../api/pbe-picks.js', { view: 'current' }],
  ['pbe-picks', '../api/pbe-picks.js', { view: 'validation-history' }],
  ['pbe-picks', '../api/pbe-picks.js', { view: 'decision', id: 'x' }],
  ['pbe-prop-picks', '../api/pbe-prop-picks.js', { view: 'current' }],
  ['pbe-touchdown-targets', '../api/pbe-touchdown-targets.js', { view: 'current' }],
  ['pbe-touchdown-targets', '../api/pbe-touchdown-targets.js', { view: 'week', season: '2026', week: '5' }],
  ['pro-model', '../api/pro-model.js', { event_id: '401772001' }],
];
test('5. a lapsed session cannot open ANY protected NFL endpoint (403 nfl_pro_required, no premium payload)', async () => {
  for (const email of ['expired@lapsed.test', 'never@lapsed.test']) {
    for (const [name, mod, query] of PROTECTED) {
      const { default: handler } = await import(mod);
      const res = mockRes();
      await handler({ method: 'GET', query, headers: { cookie: cookieFor(email) } }, res);
      assert.equal(res.statusCode, 403, `${name} ${JSON.stringify(query)} for ${email}: ${res.body.slice(0, 120)}`);
      assert.match(res.body, /nfl_pro_required/);
      assert.doesNotMatch(res.body, /PAID_MODEL_VALUE|model_prob|edge_pct|player_name/);
    }
    /* My Sunday: writes are refused; a read is the documented signed-out device-mode answer with no items. */
    const { default: mySunday } = await import('../api/my-sunday.js');
    const w = mockRes();
    await mySunday({ method: 'POST', query: { op: 'save' }, headers: { cookie: cookieFor(email), origin: 'https://nfl.propbetedge.ai', host: 'nfl.propbetedge.ai', 'x-pbe-csrf': '1', 'content-type': 'application/json' }, body: {} }, w, { env: { MY_SUNDAY_ENABLED: '1', MY_SUNDAY_ORIGIN: 'https://sunday.lapsed.test', MY_SUNDAY_TOKEN: 'x' } });
    assert.equal(w.statusCode, 403, `my-sunday write for ${email}: ${w.body.slice(0, 100)}`); assert.match(w.body, /nfl_pro_required/);
    const r = mockRes();
    await mySunday({ method: 'GET', query: {}, headers: { cookie: cookieFor(email) } }, r, { env: { MY_SUNDAY_ENABLED: '1', MY_SUNDAY_ORIGIN: 'https://sunday.lapsed.test', MY_SUNDAY_TOKEN: 'x' } });
    const rb = JSON.parse(r.body);
    assert.equal(rb.synced, false); assert.deepEqual(rb.items, []);
    /* Matchup intel: the premium tier is never served to a lapsed session. */
    const { default: matchup } = await import('../api/matchup-intel.js');
    const m = mockRes();
    await matchup({ method: 'GET', query: { event_id: '401772001' }, headers: { cookie: cookieFor(email) } }, m);
    assert.doesNotMatch(m.body, /"tier":"pro"|"pro":true/, `matchup-intel for ${email}`);
  }
  /* and the source contract: every one of these decides through getNflSession, never through /api/auth-session */
  const { readFileSync } = await import('node:fs');
  for (const f of ['pbe-picks', 'pbe-prop-picks', 'pbe-touchdown-targets', 'pro-model', 'matchup-intel', 'my-sunday']) {
    const src = readFileSync(new URL(`../api/${f}.js`, import.meta.url), 'utf8');
    assert.match(src, /getNflSession/, f); assert.doesNotMatch(src, /auth-session|paywalledAnswer/, f);
  }
});

/* ------------------------------------------------------------ 6-8 */
test('6. malformed / expired / forged cookies -> signed out with no identity (behaviour unchanged by this fix)', async () => {
  for (const [label, cookie] of [
    ['malformed', `${SESSION_COOKIE}=not-a-jwt`],
    ['expired', cookieFor('monthly@lapsed.test', { iat: nowS() - 7200, exp: nowS() - 3600 })],
    ['forged (wrong key)', `${SESSION_COOKIE}=${mint({ email: 'monthly@lapsed.test', type: 'session', iat: nowS(), exp: nowS() + 86400, jti: 'f' }, 'attacker-secret')}`],
  ]) {
    const { res, body } = await session(cookie);
    assert.equal(body.valid, false, label); assert.equal(body.pro, false, label); assert.equal(body.user, null, label);
    assert.notEqual(body.access, 'no_entitlement', `${label}: an unverifiable cookie is never a lapsed member`);
    /* auth-session has never issued Set-Cookie for an unverifiable cookie; the fix does not change that. */
    assert.equal(res.headers['set-cookie'], undefined, label);
  }
});

test('7. explicit logout still clears the NFL session cookie (host-only and .propbetedge.ai)', async () => {
  const res = mockRes();
  await authLogout({ method: 'POST', headers: { cookie: cookieFor('expired@lapsed.test'), origin: 'https://nfl.propbetedge.ai' } }, res);
  const set = [].concat(res.headers['set-cookie'] || []);
  assert.ok(set.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/.test(c) && !/Domain=/.test(c)), 'host-only cleared');
  assert.ok(set.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Domain=\.propbetedge\.ai/.test(c)), 'domain cookie cleared');
});

test('8. entitlement lookup failure stays degraded (access check), never the lapsed state', async () => {
  ledgerMode = 'down';
  try {
    const { res, body } = await session(cookieFor('monthly@lapsed.test'));
    assert.equal(body.pro, false); assert.equal(body.degraded, true); assert.equal(body.access, 'unavailable');
    assert.notEqual(body.access, 'no_entitlement'); assert.notEqual(body.paywalled, true);
    assert.equal(purged(res), false, 'an outage never signs a member out');
  } finally { ledgerMode = 'ok'; }
});
