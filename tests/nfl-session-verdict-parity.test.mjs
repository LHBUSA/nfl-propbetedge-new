/* ONE NFL SESSION AUTHORITY. The Vercel verifier (api/_nfl-auth.js
 * getNflSession) and the auth Worker's internal verdict
 * (workers/nfl-auth/src/index-v5.js sessionVerdictFor, served at
 * /internal/v1/session-verdict to Cloudflare read APIs) must reach the same
 * answer for every identity. Both run the real code; only the NFL ledger
 * (Supabase) and the shared billing ledger are faked, at the network edge. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const SECRET = 'verdict-parity-signing-secret';
const SUPABASE = 'https://supabase.verdict.test';
const BILLING = 'https://billing.verdict.test';
const READ_TOKEN = 'verdict-billing-read-token';
const INTERNAL = 'verdict-internal-token-0123456789abcdef-0123456789';
Object.assign(process.env, {
  SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'verdict-service-role', NFL_SESSION_SIGNING_SECRET: SECRET,
  NFL_OWNER_EMAILS: 'owner@verdict.test', PBE_BILLING_URL: BILLING, PBE_ENTITLEMENT_READ_TOKEN: READ_TOKEN,
});
const { getNflSession, SESSION_COOKIE, LEGACY_SESSION_COOKIE, HMAC_NAMESPACE } = await import('../api/_nfl-auth.js');
const { NFL_PRICES } = await import('../api/_nfl-entitlement.js');
const { default: worker, sessionVerdictFor, INTERNAL_VERDICT_PATH } = await import('../workers/nfl-auth/src/index-v5.js');

const DAY = 86400000, iso = ms => new Date(ms).toISOString();
const row = (email, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: NFL_PRICES.foundingMonthly, stripe_subscription_id: 'sub_v', stripe_customer_id: 'cus_v', stripe_checkout_session_id: 'cs_live_v', current_period_end: iso(Date.now() + 5 * DAY), cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over });
const NFL = { 'pro@verdict.test': [row('pro@verdict.test')], 'both@verdict.test': [row('both@verdict.test')], 'expired@verdict.test': [row('expired@verdict.test', { current_period_end: iso(Date.now() - DAY) })] };
const aa = { entitled: true, product_key: 'pbe_all_access', access_source: 'all_access', subscription: { product_key: 'pbe_all_access', plan: 'monthly', status: 'active', current_period_end: iso(Date.now() + 20 * DAY), cancel_at_period_end: false } };
const BILL = { 'allaccess@verdict.test': aa, 'both@verdict.test': aa };
let ledgerDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin === SUPABASE) {
    if (ledgerDown) return new Response('{}', { status: 503 });
    const email = (/customer_email=ilike\.([^&]+)/.exec(decodeURIComponent(u.search))?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return new Response(JSON.stringify(NFL[email] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.origin === BILLING) {
    const body = JSON.parse(init.body || '{}');
    return new Response(JSON.stringify(BILL[String(body.email).toLowerCase()] || { entitled: false, product_key: 'pbe_all_access', access_source: null, subscription: null }), { status: 200 });
  }
  return realFetch(url, init);
};
const ENV = { NFL_SESSION_SIGNING_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: 'verdict-service-role', SUPABASE_URL: SUPABASE, NFL_OWNER_EMAILS: 'owner@verdict.test', PBE_BILLING_URL: BILLING, PBE_ENTITLEMENT_READ_TOKEN: READ_TOKEN, NFL_AUTH_INTERNAL_TOKEN: INTERNAL };

const b64u = v => Buffer.from(v).toString('base64url');
const mint = (payload, secret = SECRET) => { const d = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`; return `${d}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${secret}`).update(d).digest())}`; };
const now = () => Math.floor(Date.now() / 1000);
const session = email => mint({ type: 'session', email, iat: now(), exp: now() + 3600, jti: 'x' });

const CASES = {
  'no cookie': { cookie: null },
  owner: { cookie: `${SESSION_COOKIE}=${session('owner@verdict.test')}` },
  'NFL Pro': { cookie: `${SESSION_COOKIE}=${session('pro@verdict.test')}` },
  'All Access': { cookie: `${SESSION_COOKIE}=${session('allaccess@verdict.test')}` },
  'NFL + All Access': { cookie: `${SESSION_COOKIE}=${session('both@verdict.test')}` },
  'signed-in free': { cookie: `${SESSION_COOKIE}=${session('free@verdict.test')}` },
  'expired NFL plan': { cookie: `${SESSION_COOKIE}=${session('expired@verdict.test')}` },
  'forged signature': { cookie: `${SESSION_COOKIE}=${mint({ type: 'session', email: 'owner@verdict.test', exp: now() + 3600 }, 'attacker')}` },
  'expired token': { cookie: `${SESSION_COOKIE}=${mint({ type: 'session', email: 'pro@verdict.test', exp: now() - 5 })}` },
  'magic link as cookie': { cookie: `${SESSION_COOKIE}=${mint({ type: 'magic', email: 'owner@verdict.test', exp: now() + 600 })}` },
  'legacy cookie': { cookie: `${LEGACY_SESSION_COOKIE}=${session('pro@verdict.test')}` },
  'ledger down': { cookie: `${SESSION_COOKIE}=${session('pro@verdict.test')}`, down: true },
};

/* What a Cloudflare read API forwards: the session cookie values, current first. */
function tokensFrom(cookieHeader) {
  const values = name => String(cookieHeader || '').split(';').map(p => p.trim()).filter(p => p.startsWith(`${name}=`)).map(p => p.slice(name.length + 1)).filter(Boolean);
  return [...values(SESSION_COOKIE), ...values(LEGACY_SESSION_COOKIE)];
}
const norm = s => ({ access: s.access, pro: s.pro === true, valid: s.valid === true, stage: s.stage, role: s.role || null, degraded: s.degraded === true });

for (const [name, c] of Object.entries(CASES)) {
  test(`parity: ${name}`, async () => {
    ledgerDown = Boolean(c.down);
    try {
      const vercel = await getNflSession({ headers: c.cookie ? { cookie: c.cookie } : {} });
      const cf = await sessionVerdictFor(ENV, tokensFrom(c.cookie));
      assert.deepEqual(norm(cf), norm(vercel), name);
      assert.equal(cf.signed_in, Boolean(vercel.user?.email), 'signed_in means a verified email, as verifiedEmail() does');
      assert.ok(!('email' in cf) && !('user' in cf), 'the verdict carries no identity');
    } finally { ledgerDown = false; }
  });
}

test('the internal route answers a server with the token, and nobody else', async () => {
  const call = (headers = {}, method = 'POST', body = { tokens: [session('owner@verdict.test')] }) => worker.fetch(new Request(`https://auth.internal${INTERNAL_VERDICT_PATH}`, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }), ENV, {});
  const ok = await call({ authorization: `Bearer ${INTERNAL}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(norm(await ok.json()), { access: 'granted', pro: true, valid: true, stage: 'owner_verified', role: 'owner', degraded: false });
  for (const [label, r] of [
    ['no token', await call()],
    ['wrong token', await call({ authorization: 'Bearer nope' })],
    ['browser origin', await call({ authorization: `Bearer ${INTERNAL}`, origin: 'https://nfl.propbetedge.ai' })],
    ['GET', await call({ authorization: `Bearer ${INTERNAL}` }, 'GET')],
  ]) { assert.equal(r.status, 404, label); assert.equal(r.headers.get('access-control-allow-origin'), null, `${label}: no CORS`); }
  const noSecret = await worker.fetch(new Request(`https://auth.internal${INTERNAL_VERDICT_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL}` }, body: '{}' }), { ...ENV, NFL_AUTH_INTERNAL_TOKEN: '' }, {});
  assert.equal(noSecret.status, 404, 'an unconfigured token disables the route');
});
