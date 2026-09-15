/* Checkout access-email delivery contract (2026-09-15, after the SEV-1 gate).
 *
 * The public POST /v1/auth/request now answers the same generic 200 for every
 * email and decides in the background, so its 200 proves nothing. A backend
 * that records "access email sent" must use the auth Worker's server-to-server
 * route, which re-checks NFL entitlement and returns the true result:
 *   sent | already_sent | in_progress | not_entitled | ledger_unavailable |
 *   resend_failed
 * api/checkout-complete.js stamps access_email_sent_at only for sent /
 * already_sent. Everything here runs the real Worker, its real Durable Object
 * class, and the real checkout-complete core against a controlled ledger,
 * Resend and Stripe.
 *
 *   node --test tests/nfl-purchase-delivery.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const APP = 'https://nfl.propbetedge.ai';
const SUPABASE = 'https://supabase.delivery.test';
const TOKEN = 'internal-delivery-test-token-0123456789abcdef0123';

const { default: worker, MagicLinkLedger, GENERIC_REQUEST_MESSAGE, INTERNAL_DELIVERY_PATH } = await import('../workers/nfl-auth/src/index-v5.js');
const { completeCheckout, requestPurchaseDelivery, deliveryKeyOf } = await import('../api/checkout-complete.js');
const { NFL_PRICES: P } = await import('../api/_nfl-entitlement.js');
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/* ------------------------------------------------------------ controlled edges */
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const nflRow = (email, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: P.foundingMonthly, stripe_subscription_id: 'sub_1Delivery', stripe_customer_id: 'cus_Delivery', stripe_checkout_session_id: 'cs_live_Delivery', current_period_end: iso(Date.now() + 20 * DAY), cancel_at_period_end: false, created_at: '2026-09-15T00:00:00Z', ...over });

const LEDGER = {};
let ledgerMode = 'ok';
let ledgerReads = 0;
let onLedgerRead = null;
let resendMode = 'ok';
let resendGate = null;
const emails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin === SUPABASE && u.pathname === '/rest/v1/nfl_subscriptions') {
    ledgerReads += 1;
    onLedgerRead?.(ledgerReads);
    if (ledgerMode === 'down') return new Response('{"message":"down"}', { status: 503 });
    const email = (/customer_email=ilike\.([^&]+)/.exec(decodeURIComponent(u.search))?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return new Response(JSON.stringify(LEDGER[email] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.host === 'api.resend.com') {
    if (resendGate) await resendGate;
    if (resendMode === 'fail') return new Response('{"message":"provider down"}', { status: 500 });
    if (resendMode === 'network') throw new TypeError('fetch failed');
    const body = JSON.parse(init.body);
    emails.push(body);
    return new Response(JSON.stringify({ id: `re_delivery_${emails.length}` }), { status: 200 });
  }
  return realFetch(url, init);
};

function ledgerNamespace() {
  const objects = new Map();
  return {
    objects,
    idFromName: name => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const store = new Map();
        let queue = Promise.resolve();
        const obj = new MagicLinkLedger({ storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, v); }, delete: async k => store.delete(k), setAlarm: async () => {}, deleteAll: async () => store.clear() } });
        objects.set(id.name, { fetch: (u, i) => (queue = queue.then(() => obj.fetch(new Request(u, i)))) });
      }
      return objects.get(id.name);
    },
  };
}

const baseEnv = () => ({
  NFL_SESSION_SIGNING_SECRET: 'delivery-signing-secret', SUPABASE_SERVICE_ROLE_KEY: 'delivery-service-key', SUPABASE_URL: SUPABASE,
  RESEND_API_KEY: 're_delivery', APP_ORIGIN: APP, NFL_OWNER_EMAILS: 'owner@delivery.test', MAGIC_LINKS: ledgerNamespace(),
  NFL_AUTH_INTERNAL_TOKEN: TOKEN, NFL_AUTH_DELIVERY_RECHECK_MS: '1,1',
});
function reset() { emails.length = 0; ledgerReads = 0; ledgerMode = 'ok'; resendMode = 'ok'; resendGate = null; onLedgerRead = null; for (const k of Object.keys(LEDGER)) delete LEDGER[k]; }

const internalCall = (env, body, { token = TOKEN, method = 'POST', headers = {} } = {}) => worker.fetch(new Request(`https://auth.delivery.test${INTERNAL_DELIVERY_PATH}`, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  body: method === 'POST' || method === 'PUT' ? JSON.stringify(body) : undefined,
}), env);
async function deliverDirect(env, email, key) { const r = await internalCall(env, { email, delivery_key: key }); return { status: r.status, ...(await r.json()) }; }

async function publicRequest(env, email) {
  const pending = [];
  const r = await worker.fetch(new Request('https://auth.delivery.test/v1/auth/request', { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'signin' }) }), env, { waitUntil: p => pending.push(p) });
  const body = await r.json(); await Promise.all(pending);
  return { status: r.status, body };
}

/* A Stripe client over one Checkout Session, recording every metadata write. */
function fakeStripe(session) {
  const state = { session: structuredClone(session), updates: [], failUpdate: false };
  state.checkout = { sessions: {
    retrieve: async id => { assert.equal(id, state.session.id); return structuredClone(state.session); },
    update: async (id, { metadata }) => {
      if (state.failUpdate) throw new Error('stripe_unavailable');
      state.updates.push(metadata); state.session.metadata = { ...state.session.metadata, ...metadata }; return structuredClone(state.session);
    },
  } };
  return state;
}
const paidSession = (email, over = {}) => ({ id: 'cs_live_a1B2c3Delivery', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', subscription: 'sub_1Delivery', customer_details: { email }, metadata: { acquired_sport: 'nfl', product: 'propbetedge_nfl', price_id: P.foundingMonthly, plan: 'nfl_founding_monthly' }, ...over });

/* checkout-complete's real delivery client, pointed at the in-process Worker. */
const viaWorker = (env, opts = {}) => ({ email, deliveryKey }) => requestPurchaseDelivery({ email, deliveryKey, token: TOKEN, workerBase: 'https://auth.delivery.test', fetchImpl: (u, i) => worker.fetch(new Request(u, i), env), ...opts });
const returnOnce = (stripe, deliver) => completeCheckout({ sessionId: stripe.session.id, stripe, deliver });

/* ============================================================ public endpoint stays generic */
test('public request is unchanged: non-NFL email -> generic 200, zero email', async () => {
  reset(); const env = baseEnv();
  const r = await publicRequest(env, 'mlb-only@delivery.test');
  assert.equal(r.status, 200); assert.equal(r.body.message, GENERIC_REQUEST_MESSAGE); assert.equal(r.body.result, undefined);
  assert.equal(emails.length, 0);
});

test('public request is unchanged: NFL subscriber -> the same generic 200, one email', async () => {
  reset(); const env = baseEnv();
  LEDGER['sub@delivery.test'] = [nflRow('sub@delivery.test')];
  const r = await publicRequest(env, 'sub@delivery.test');
  assert.equal(r.status, 200); assert.equal(r.body.message, GENERIC_REQUEST_MESSAGE); assert.equal(r.body.result, undefined);
  assert.equal(emails.length, 1);
});

/* ============================================================ the privileged route */
test('browser cannot invoke internal delivery: no token, wrong token, Origin, preflight, GET, unconfigured -> bare 404', async () => {
  reset(); LEDGER['sub@delivery.test'] = [nflRow('sub@delivery.test')];
  const env = baseEnv();
  const body = { email: 'sub@delivery.test', delivery_key: 'checkout:cs_live_Browser1' };
  const attempts = [
    ['no token', await internalCall(env, body, { token: '' })],
    ['wrong token', await internalCall(env, body, { token: `${TOKEN}x` })],
    ['token in a cookie-style header only', await internalCall(env, body, { token: '', headers: { 'x-internal-token': TOKEN } })],
    ['right token from a browser page (Origin)', await internalCall(env, body, { headers: { origin: APP } })],
    ['right token, foreign Origin', await internalCall(env, body, { headers: { origin: 'https://evil.test' } })],
    ['CORS preflight', await worker.fetch(new Request(`https://auth.delivery.test${INTERNAL_DELIVERY_PATH}`, { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': 'POST' } }), env)],
    ['GET', await internalCall(env, null, { method: 'GET' })],
    ['Worker without a configured token', await internalCall({ ...env, NFL_AUTH_INTERNAL_TOKEN: '' }, body, { token: '' })],
    ['Worker with a short token', await internalCall({ ...env, NFL_AUTH_INTERNAL_TOKEN: 'short' }, body, { token: 'short' })],
  ];
  for (const [name, r] of attempts) {
    assert.equal(r.status, 404, name);
    assert.equal(r.headers.get('access-control-allow-origin'), null, `${name}: no CORS grant`);
    assert.deepEqual(await r.json(), { error: 'not_found' }, `${name}: no result leaks`);
  }
  assert.equal(emails.length, 0);
});

test('the internal token never ships to the browser', () => {
  const served = readdirSync(new URL('..', import.meta.url)).filter(f => /\.(js|html|css|json)$/.test(f));
  for (const f of served) {
    const src = read(f);
    assert.equal(/NFL_AUTH_INTERNAL_TOKEN|internal\/v1\/purchase-delivery/.test(src), false, f);
  }
  const code = f => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\/v1\/auth\/request/.test(code('api/checkout-complete.js')), false, 'checkout-complete never uses the public request');
  assert.equal(/\/v1\/auth\/request/.test(code('workers/nfl-billing/src/index.js')), false, 'billing never uses the public request');
});

test('internal delivery: entitled -> sent (one email); the same key again -> already_sent, no email', async () => {
  reset(); LEDGER['sub@delivery.test'] = [nflRow('sub@delivery.test')];
  const env = baseEnv();
  const first = await deliverDirect(env, 'Sub@Delivery.test', 'subscription:sub_1Delivery');
  assert.equal(first.result, 'sent'); assert.ok(first.sent_at); assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['sub@delivery.test']); assert.equal(emails[0].subject, 'PropBetEdge NFL Pro — your access is ready');
  const again = await deliverDirect(env, 'sub@delivery.test', 'subscription:sub_1Delivery');
  assert.equal(again.result, 'already_sent'); assert.equal(again.sent_at, first.sent_at); assert.equal(emails.length, 1);
});

test('internal delivery: not entitled -> bounded re-check, then not_entitled, no email, key stays retryable', async () => {
  reset(); const env = baseEnv();
  const r = await deliverDirect(env, 'mlb-only@delivery.test', 'checkout:cs_live_Mlb1');
  assert.equal(r.result, 'not_entitled'); assert.equal(ledgerReads, 3, 'one check plus exactly two re-checks'); assert.equal(emails.length, 0);
  LEDGER['mlb-only@delivery.test'] = [nflRow('mlb-only@delivery.test')];
  assert.equal((await deliverDirect(env, 'mlb-only@delivery.test', 'checkout:cs_live_Mlb1')).result, 'sent', 'a refused key was released');
});

test('internal delivery: other-sport rows, expired and canceled NFL are not_entitled', async () => {
  reset(); const env = baseEnv();
  LEDGER['nba@delivery.test'] = [nflRow('nba@delivery.test', { stripe_price_id: 'price_1NBAProMonthly' })];
  LEDGER['expired@delivery.test'] = [nflRow('expired@delivery.test', { current_period_end: iso(Date.now() - DAY) })];
  LEDGER['canceled@delivery.test'] = [nflRow('canceled@delivery.test', { status: 'canceled' })];
  for (const email of Object.keys(LEDGER)) assert.equal((await deliverDirect(env, email, `checkout:cs_live_${email.split('@')[0]}`)).result, 'not_entitled', email);
  assert.equal(emails.length, 0);
});

test('internal delivery: ledger outage -> ledger_unavailable, no email, no re-check loop', async () => {
  reset(); ledgerMode = 'down'; const env = baseEnv();
  const r = await deliverDirect(env, 'sub@delivery.test', 'checkout:cs_live_Down1');
  assert.equal(r.result, 'ledger_unavailable'); assert.equal(ledgerReads, 1); assert.equal(emails.length, 0);
});

test('internal delivery: Resend failure (HTTP or network) -> resend_failed; the retry sends once', async () => {
  for (const mode of ['fail', 'network']) {
    reset(); LEDGER['sub@delivery.test'] = [nflRow('sub@delivery.test')]; const env = baseEnv();
    resendMode = mode;
    assert.equal((await deliverDirect(env, 'sub@delivery.test', 'checkout:cs_live_Resend1')).result, 'resend_failed', mode);
    resendMode = 'ok';
    assert.equal((await deliverDirect(env, 'sub@delivery.test', 'checkout:cs_live_Resend1')).result, 'sent', mode);
    assert.equal((await deliverDirect(env, 'sub@delivery.test', 'checkout:cs_live_Resend1')).result, 'already_sent', mode);
    assert.equal(emails.length, 1, mode);
  }
});

test('internal delivery: two backends at once (checkout return + webhook) -> one sends, one in_progress, one email', async () => {
  reset(); LEDGER['sub@delivery.test'] = [nflRow('sub@delivery.test')]; const env = baseEnv();
  let release; resendGate = new Promise(r => { release = r; });
  const a = deliverDirect(env, 'sub@delivery.test', 'subscription:sub_1Race');
  await new Promise(r => setTimeout(r, 20));
  const b = await deliverDirect(env, 'sub@delivery.test', 'subscription:sub_1Race');
  release(); resendGate = null;
  assert.equal(b.result, 'in_progress'); assert.equal((await a).result, 'sent'); assert.equal(emails.length, 1);
});

test('internal delivery: malformed requests are refused with no email', async () => {
  reset(); LEDGER['sub@delivery.test'] = [nflRow('sub@delivery.test')]; const env = baseEnv();
  for (const body of [{ email: 'sub@delivery.test' }, { email: 'sub@delivery.test', delivery_key: 'email:sub@delivery.test' }, { email: 'not-an-email', delivery_key: 'checkout:cs_live_X1' }]) {
    const r = await internalCall(env, body);
    assert.equal(r.status, 400); assert.equal((await r.json()).result, 'invalid_request');
  }
  assert.equal(emails.length, 0);
});

/* ============================================================ checkout-complete */
test('checkout-complete: verified paid checkout + entitlement -> internal result sent, stamped exactly once', async () => {
  reset(); LEDGER['buyer@delivery.test'] = [nflRow('buyer@delivery.test')]; const env = baseEnv();
  const stripe = fakeStripe(paidSession('Buyer@Delivery.test'));
  const out = await returnOnce(stripe, viaWorker(env));
  assert.equal(out.result, 'sent'); assert.equal(out.access, 'sent');
  assert.match(out.location, /checkout=success.*access_email=sent$/);
  assert.equal(emails.length, 1); assert.equal(stripe.updates.length, 1);
  assert.ok(stripe.updates[0].access_email_sent_at); assert.equal(stripe.updates[0].access_email_provider, 'resend');
  assert.equal(stripe.updates[0].acquired_sport, 'nfl', 'existing metadata is preserved');
});

test('checkout-complete: entitlement row not landed -> bounded re-check, pending, NOT stamped; the retry after it lands sends and stamps once', async () => {
  reset(); const env = baseEnv();
  const stripe = fakeStripe(paidSession('late@delivery.test'));
  const first = await returnOnce(stripe, viaWorker(env));
  assert.equal(first.result, 'not_entitled'); assert.equal(first.access, 'pending');
  assert.match(first.location, /access_email=pending$/);
  assert.equal(ledgerReads, 3); assert.equal(emails.length, 0); assert.equal(stripe.updates.length, 0, 'never falsely stamps sent');

  LEDGER['late@delivery.test'] = [nflRow('late@delivery.test')];
  const retry = await returnOnce(stripe, viaWorker(env));
  assert.equal(retry.access, 'sent'); assert.equal(emails.length, 1); assert.equal(stripe.updates.length, 1);
  const third = await returnOnce(stripe, viaWorker(env));
  assert.equal(third.access, 'already_sent'); assert.equal(emails.length, 1); assert.equal(stripe.updates.length, 1);
});

test('checkout-complete: the webhook row landing during the re-check window still sends in the same return', async () => {
  reset(); const env = baseEnv();
  onLedgerRead = n => { if (n === 2) LEDGER['racing@delivery.test'] = [nflRow('racing@delivery.test')]; };
  const stripe = fakeStripe(paidSession('racing@delivery.test'));
  const out = await returnOnce(stripe, viaWorker(env));
  assert.equal(out.access, 'sent'); assert.equal(emails.length, 1); assert.equal(stripe.updates.length, 1);
});

test('checkout-complete: Resend failure -> failed, no access_email_sent_at; retry sends and stamps once', async () => {
  reset(); LEDGER['buyer@delivery.test'] = [nflRow('buyer@delivery.test')]; const env = baseEnv();
  const stripe = fakeStripe(paidSession('buyer@delivery.test'));
  resendMode = 'fail';
  const failed = await returnOnce(stripe, viaWorker(env));
  assert.equal(failed.result, 'resend_failed'); assert.equal(failed.access, 'failed'); assert.match(failed.location, /access_email=failed$/);
  assert.equal(stripe.updates.length, 0); assert.equal(stripe.session.metadata.access_email_sent_at, undefined);
  resendMode = 'ok';
  const retry = await returnOnce(stripe, viaWorker(env));
  assert.equal(retry.access, 'sent'); assert.equal(emails.length, 1); assert.equal(stripe.updates.length, 1);
});

test('checkout-complete: ledger outage -> failed, no access_email_sent_at, no email', async () => {
  reset(); ledgerMode = 'down'; const env = baseEnv();
  const stripe = fakeStripe(paidSession('buyer@delivery.test'));
  const out = await returnOnce(stripe, viaWorker(env));
  assert.equal(out.result, 'ledger_unavailable'); assert.equal(out.access, 'failed');
  assert.equal(stripe.updates.length, 0); assert.equal(emails.length, 0);
});

test('checkout-complete: a duplicate return after a confirmed send neither emails nor re-stamps', async () => {
  reset(); LEDGER['buyer@delivery.test'] = [nflRow('buyer@delivery.test')]; const env = baseEnv();
  const stripe = fakeStripe(paidSession('buyer@delivery.test'));
  await returnOnce(stripe, viaWorker(env));
  let delivered = 0;
  const counting = viaWorker(env);
  for (let i = 0; i < 3; i++) {
    const again = await returnOnce(stripe, args => { delivered += 1; return counting(args); });
    assert.equal(again.access, 'already_sent');
  }
  assert.equal(delivered, 0, 'a stamped session never calls delivery again');
  assert.equal(emails.length, 1); assert.equal(stripe.updates.length, 1);
});

test('checkout-complete: sent but the Stripe stamp failed -> the next return stamps from the Worker record, still one email', async () => {
  reset(); LEDGER['buyer@delivery.test'] = [nflRow('buyer@delivery.test')]; const env = baseEnv();
  const stripe = fakeStripe(paidSession('buyer@delivery.test'));
  stripe.failUpdate = true;
  assert.equal((await returnOnce(stripe, viaWorker(env))).access, 'sent');
  stripe.failUpdate = false;
  const next = await returnOnce(stripe, viaWorker(env));
  assert.equal(next.result, 'already_sent'); assert.equal(stripe.updates.length, 1); assert.equal(emails.length, 1);
});

test('checkout-complete and the billing webhook share one delivery key per subscription', async () => {
  reset(); LEDGER['buyer@delivery.test'] = [nflRow('buyer@delivery.test')]; const env = baseEnv();
  assert.equal(deliveryKeyOf({ subscription: 'sub_1Delivery' }, 'cs_live_x'), 'subscription:sub_1Delivery');
  assert.equal(deliveryKeyOf({ subscription: { id: 'sub_1Delivery' } }, 'cs_live_x'), 'subscription:sub_1Delivery');
  assert.equal(deliveryKeyOf({ mode: 'payment' }, 'cs_live_pass1'), 'checkout:cs_live_pass1');
  /* the webhook already sent for this subscription */
  assert.equal((await deliverDirect(env, 'buyer@delivery.test', 'subscription:sub_1Delivery')).result, 'sent');
  const stripe = fakeStripe(paidSession('buyer@delivery.test'));
  const out = await returnOnce(stripe, viaWorker(env));
  assert.equal(out.result, 'already_sent'); assert.equal(out.access, 'sent'); assert.equal(stripe.updates.length, 1); assert.equal(emails.length, 1);
});

test('checkout-complete: unconfigured token, timeout and network failure never stamp and never fall back to the public request', async () => {
  reset(); LEDGER['buyer@delivery.test'] = [nflRow('buyer@delivery.test')];
  const calls = [];
  const cases = [
    ['internal_unconfigured', args => requestPurchaseDelivery({ ...args, token: '', fetchImpl: (u, i) => { calls.push(u); return realFetch(u, i); } })],
    ['internal_timeout', args => requestPurchaseDelivery({ ...args, token: TOKEN, timeoutMs: 30, fetchImpl: (u, i) => { calls.push(u); return new Promise((_, reject) => i.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); } })],
    ['internal_network', args => requestPurchaseDelivery({ ...args, token: TOKEN, fetchImpl: async u => { calls.push(u); throw new TypeError('fetch failed'); } })],
  ];
  for (const [want, deliver] of cases) {
    const stripe = fakeStripe(paidSession('buyer@delivery.test'));
    const out = await returnOnce(stripe, deliver);
    assert.equal(out.result, want); assert.equal(out.access, 'failed'); assert.equal(stripe.updates.length, 0, want);
  }
  assert.ok(calls.every(u => String(u).endsWith(INTERNAL_DELIVERY_PATH)), 'only the internal route is ever called');
  assert.equal(emails.length, 0);
});

test('checkout-complete: unpaid or non-NFL sessions deliver nothing', async () => {
  reset(); LEDGER['buyer@delivery.test'] = [nflRow('buyer@delivery.test')];
  let delivered = 0;
  for (const over of [{ payment_status: 'unpaid' }, { status: 'open' }, { metadata: { acquired_sport: 'mlb', product: 'propbetedge_mlb' } }]) {
    const stripe = fakeStripe(paidSession('buyer@delivery.test', over));
    const out = await returnOnce(stripe, async () => { delivered += 1; return 'sent'; });
    assert.match(out.location, /checkout=not_complete$/); assert.equal(stripe.updates.length, 0);
  }
  assert.equal(delivered, 0);
});

/* ============================================================ buyer-facing copy */
test('paywall: checkout return copy follows the confirmed result, and a notice survives the funnel re-render', () => {
  const paywall = read('paywall.js');
  const funnel = read('paywall-funnel-v2.js');
  assert.match(paywall, /delivery === 'sent' \|\| delivery === 'already_sent'/);
  assert.match(paywall, /request your secure access link/);
  assert.match(paywall, /auth === 'not_authorized'[\s\S]{0,80}notice\(/);
  assert.match(funnel, /window\.PBEPro\?\.paintNotice\?\.\(\)/);
  assert.equal(/activating now/.test(funnel), false, 'the funnel no longer claims access is activating regardless of delivery');
});
