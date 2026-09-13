/* Purchase -> subscription -> paid access, across both halves of NFL billing.
 *
 * Stripe-signed events for a Founding Season Payment Link purchase go through
 * the REAL billing Worker (workers/nfl-billing) into one in-memory
 * nfl_subscriptions ledger. The SAME ledger then backs the REAL access layer:
 * /api/auth-session and the paid same-origin route /api/gw, for a session
 * cookie minted for the purchaser's email exactly as the auth Worker does.
 *
 * Proves: a real purchase (any delivery order) opens the product for that
 * email only; sign-in alone does not; cancellation closes it again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';

Object.assign(process.env, {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.service.role',
  NFL_SESSION_SIGNING_SECRET: 'purchase-to-access-session-secret',
  NFL_GATEWAY: 'https://gateway.test',
  NFL_GATEWAY_TOKEN: 'gateway-token',
});

const billing = (await import('../workers/nfl-billing/src/index.js')).default;
const auth = await import('../api/_nfl-auth.js');
const { default: gw } = await import('../api/gw.js');
const { default: authSession } = await import('../api/auth-session.js');

const STRIPE_SECRET = 'whsec_purchase_to_access';
const WEEKLY = 'price_1UEWAOF3CaVzg4ORjkWpwOz9';
const NOW = Math.floor(Date.now() / 1000);

/* one ledger shared by billing writes and access reads */
const rows = { nfl_subscriptions: [], nfl_stripe_webhook_events: [], nfl_access_email_deliveries: [] };
let nextId = 1;
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'gateway.test') return json(200, { ok: true, path: url.pathname });
  if (url.host !== 'supabase.test') throw new Error(`unexpected fetch ${url}`);
  const table = url.pathname.replace('/rest/v1/', '');
  const list = rows[table];
  const method = (init.method || 'GET').toUpperCase();
  const filters = [...url.searchParams.entries()].filter(([k]) => !['select', 'limit', 'order'].includes(k)).map(([k, v]) => {
    const [op, ...rest] = v.split('.'); return [k, op, decodeURIComponent(rest.join('.')).replace(/\\([%_*\\])/g, '$1')];
  });
  const match = r => filters.every(([k, op, v]) => (op === 'ilike' ? String(r[k] || '').toLowerCase() === v.toLowerCase() : String(r[k]) === v));
  if (method === 'GET') return json(200, list.filter(match).map(r => ({ ...r })));
  if (method === 'POST') {
    const rec = JSON.parse(init.body);
    const key = { nfl_subscriptions: 'stripe_subscription_id', nfl_stripe_webhook_events: 'event_id', nfl_access_email_deliveries: 'delivery_key' }[table];
    if (rec[key] != null && list.some(r => r[key] === rec[key])) return /ignore-duplicates/.test(new Headers(init.headers).get('prefer') || '') ? json(201) : json(409, { code: '23505' });
    list.push({ id: String(nextId++), created_at: new Date().toISOString(), ...rec });
    return json(201);
  }
  if (method === 'PATCH') { const p = JSON.parse(init.body); list.filter(match).forEach(r => Object.assign(r, p)); return json(204); }
  if (method === 'DELETE') { rows[table] = list.filter(r => !match(r)); return json(204); }
  return json(405);
};

const emails = [];
const billingEnv = {
  STRIPE_WEBHOOK_SECRET: STRIPE_SECRET, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL: 'https://supabase.test',
  AUTH: { fetch: async (_url, init) => { emails.push(JSON.parse(init.body)); return json(200, { ok: true }); } },
};
async function stripeDeliver(event) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(STRIPE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`))).toString('hex');
  const res = await billing.fetch(new Request('https://billing.test/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: raw }), billingEnv);
  assert.equal(res.status, 200, `${event.type}: ${await res.clone().text()}`);
  return res.json();
}

const b64u = v => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function cookieFor(email) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ email, type: 'session', iat: NOW, exp: NOW + 3600, jti: 't' }))}`;
  return `${auth.SESSION_COOKIE}=${data}.${b64u(createHmac('sha256', `${auth.HMAC_NAMESPACE}:${process.env.NFL_SESSION_SIGNING_SECRET}`).update(data).digest())}`;
}
function res() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = JSON.stringify(b); return this; }, end(b = '') { this.body = String(b); return this; } };
}
async function access(email) {
  auth.clearEntitlementCache();
  const s = res(); await authSession({ method: 'GET', headers: { cookie: cookieFor(email) } }, s);
  const d = res(); await gw({ method: 'GET', query: { __gw_path: 'api/best-line' }, headers: { cookie: cookieFor(email) } }, d);
  return { session: JSON.parse(s.body), data: d.statusCode };
}

let n = 0;
const evt = (type, object, created) => ({ id: `evt_p2a_${++n}`, object: 'event', type, created, data: { object } });
function purchase(email) {
  const sub = `sub_1P2A${++n}`, cus = `cus_P2A${n}`, end = NOW + 7 * 86400;
  const subscription = (status, extra = {}) => ({ id: sub, customer: cus, status, cancel_at_period_end: false, items: { data: [{ price: { id: WEEKLY }, current_period_end: end }] }, ...extra });
  return {
    sub, subscription,
    events: [
      evt('checkout.session.completed', { id: `cs_live_p2a${n}`, mode: 'subscription', customer: cus, subscription: sub, payment_status: 'paid', customer_details: { email }, metadata: { acquired_sport: 'nfl', product: 'propbetedge_nfl', price_id: WEEKLY, plan: 'nfl_founding_weekly' } }, NOW + 2),
      evt('invoice.paid', { id: `in_p2a${n}`, customer: cus, customer_email: email, parent: { subscription_details: { subscription: sub } }, lines: { data: [{ pricing: { price_details: { price: WEEKLY } } }] } }, NOW + 1),
      evt('customer.subscription.created', subscription('incomplete'), NOW),
      evt('customer.subscription.updated', subscription('active'), NOW),
    ],
  };
}

test('a Founding weekly purchase, delivered checkout-first, opens paid access for exactly that email', async () => {
  const buyer = 'New.Subscriber@PropBetEdge.test';
  const before = await access(buyer.toLowerCase());
  assert.equal(before.session.access, 'no_entitlement', 'sign-in before purchase grants nothing');
  assert.equal(before.data, 403);

  const p = purchase(buyer);
  for (const e of p.events) await stripeDeliver(e);

  const after = await access(buyer.toLowerCase());
  assert.equal(after.session.access, 'granted');
  assert.equal(after.session.pro, true);
  assert.equal(after.session.entitlement.plan, 'founding_weekly');
  assert.ok(Date.parse(after.session.entitlement.expires_at) > Date.now());
  assert.equal(after.data, 200, 'paid NFL API opens');
  assert.deepEqual(emails, [{ email: buyer.toLowerCase(), purpose: 'purchase' }], 'one access email to the purchaser');

  const stranger = await access('someone.else@propbetedge.test');
  assert.equal(stranger.session.access, 'no_entitlement');
  assert.equal(stranger.data, 403);
});

test('a duplicate Stripe resend changes nothing and access stays granted', async () => {
  const buyer = 'resend.check@propbetedge.test';
  const p = purchase(buyer);
  for (const e of p.events) await stripeDeliver(e);
  const snapshot = JSON.stringify(rows);
  assert.deepEqual(await stripeDeliver(p.events[0]), { received: true, duplicate: true });
  assert.equal(JSON.stringify(rows), snapshot);
  assert.equal((await access(buyer)).session.access, 'granted');
});

test('cancellation from Stripe closes paid access again', async () => {
  const buyer = 'will.cancel@propbetedge.test';
  const p = purchase(buyer);
  for (const e of p.events) await stripeDeliver(e);
  assert.equal((await access(buyer)).data, 200);
  await stripeDeliver(evt('customer.subscription.deleted', p.subscription('canceled'), NOW + 500));
  const after = await access(buyer);
  assert.equal(after.session.access, 'no_entitlement');
  assert.equal(after.session.entitlement.reason, 'canceled');
  assert.equal(after.data, 403);
});
