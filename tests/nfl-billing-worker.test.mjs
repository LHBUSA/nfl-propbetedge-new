/* NFL billing Worker — Stripe webhook -> nfl_subscriptions, end to end.
 *
 * The real Worker handler runs in-process against an in-memory PostgREST that
 * enforces the production constraints (unique stripe_subscription_id, unique
 * checkout session id, event-ledger primary key, delivery-key primary key).
 * Every event is signed exactly the way Stripe signs it. Payloads are shaped
 * like a Founding Season Payment Link purchase (metadata acquired_sport=nfl,
 * product=propbetedge_nfl, price_id, plan) on a current Stripe API version,
 * where current_period_end lives on the subscription item.
 *
 * The acceptance bar for every delivery order: the row a customer ends up with
 * carries their normalized email, the NFL price, sub_ / cus_ ids, status
 * active and a future current_period_end — the fields the NFL entitlement
 * predicate requires. A null period end is a failed purchase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../workers/nfl-billing/src/index.js';

const SECRET = 'whsec_test_nfl_billing';
const NOW = Math.floor(Date.now() / 1000);
const WEEKLY = 'price_1UEWAOF3CaVzg4ORjkWpwOz9';
const MONTHLY = 'price_1UEWAXF3CaVzg4ORGlsgboLq';
const LEGACY_WEEKLY = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';
const MLB_PRICE = 'price_1MLBPropBetEdgeMonthly';

/* ------------------------------------------------------------ fake PostgREST */
function database() {
  const tables = { nfl_subscriptions: [], nfl_stripe_webhook_events: [], nfl_access_email_deliveries: [] };
  const unique = { nfl_subscriptions: ['stripe_subscription_id', 'stripe_checkout_session_id'], nfl_stripe_webhook_events: ['event_id'], nfl_access_email_deliveries: ['delivery_key'] };
  const log = [];
  let failWrites = false;
  let nextId = 1;
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const filtersOf = params => [...params.entries()].filter(([k]) => !['select', 'limit', 'order', 'on_conflict'].includes(k))
    .map(([k, v]) => { const m = /^eq\.(.*)$/.exec(v); if (!m) throw new Error(`unsupported filter ${k}=${v}`); return [k, decodeURIComponent(m[1])]; });
  const match = (row, filters) => filters.every(([k, v]) => String(row[k]) === v);
  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== 'supabase.test') throw new Error(`unexpected fetch ${url}`);
    const table = url.pathname.replace('/rest/v1/', '');
    const rows = tables[table];
    if (!rows) return reply(404, { message: 'no table' });
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    log.push({ method, table, auth: headers.get('authorization'), apikey: headers.get('apikey') });
    const filters = filtersOf(url.searchParams);
    if (method === 'GET') {
      const select = (url.searchParams.get('select') || '*').split(',');
      const limit = Number(url.searchParams.get('limit') || 1000);
      return reply(200, rows.filter(r => match(r, filters)).slice(0, limit).map(r => (select[0] === '*' ? { ...r } : Object.fromEntries(select.map(c => [c, r[c] ?? null])))));
    }
    if (failWrites) return reply(503, { message: 'database write unavailable' });
    if (method === 'POST') {
      const record = JSON.parse(init.body);
      for (const col of unique[table]) {
        if (record[col] != null && rows.some(r => r[col] === record[col])) {
          if (/ignore-duplicates/.test(headers.get('prefer') || '')) return reply(201);
          return reply(409, { code: '23505', message: `duplicate key value violates unique constraint (${col})` });
        }
      }
      rows.push({ id: String(nextId++), created_at: new Date().toISOString(), ...record });
      return reply(201);
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      for (const r of rows.filter(r => match(r, filters))) Object.assign(r, patch);
      return reply(204);
    }
    if (method === 'DELETE') {
      tables[table] = rows.filter(r => !match(r, filters));
      return reply(204);
    }
    return reply(405);
  }
  return { tables, log, fetch, set failWrites(v) { failWrites = v; } };
}

/* ------------------------------------------------------------ Stripe signing */
async function sign(raw, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`));
  return `t=${t},v1=${Buffer.from(mac).toString('hex')}`;
}

function harness({ key = 'eyJhbGciOiJIUzI1NiJ9.service.role' } = {}) {
  const db = database();
  const emails = [];
  const env = {
    STRIPE_WEBHOOK_SECRET: SECRET,
    SUPABASE_SERVICE_ROLE_KEY: key,
    SUPABASE_URL: 'https://supabase.test',
    AUTH: { fetch: async (url, init) => {
      if (String(url).endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      emails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } },
  };
  async function deliver(event, { secret = SECRET, t } = {}) {
    const raw = JSON.stringify(event);
    const real = globalThis.fetch; globalThis.fetch = db.fetch;
    try {
      const res = await worker.fetch(new Request('https://propbetedge-nfl-billing.test/webhook', { method: 'POST', headers: { 'stripe-signature': await sign(raw, secret, t), 'content-type': 'application/json' }, body: raw }), env);
      return { status: res.status, body: await res.json() };
    } finally { globalThis.fetch = real; }
  }
  async function health(query = '') {
    const real = globalThis.fetch; globalThis.fetch = db.fetch;
    try { const r = await worker.fetch(new Request(`https://propbetedge-nfl-billing.test/health${query}`), env); return r.json(); }
    finally { globalThis.fetch = real; }
  }
  return { db, emails, deliver, health, env };
}

/* ------------------------------------------------------- Payment Link purchase */
let seq = 0;
const evt = (type, object, created) => ({ id: `evt_test_${type.replace(/\W/g, '_')}_${++seq}`, object: 'event', type, created, livemode: false, data: { object } });

function purchase({ price = WEEKLY, email = 'Buyer.Test@PropBetEdge.test', plan = 'nfl_founding_weekly', periodDays = 7, t0 = NOW } = {}) {
  const sub = `sub_1Test${++seq}`;
  const cus = `cus_Test${seq}`;
  const periodEnd = t0 + periodDays * 86400;
  const item = { id: `si_${seq}`, price: { id: price, recurring: { interval: periodDays > 8 ? 'month' : 'week' } }, current_period_start: t0, current_period_end: periodEnd };
  const subscription = (status, extra = {}) => ({ id: sub, object: 'subscription', customer: cus, status, cancel_at_period_end: false, items: { data: [item] }, ...extra });
  const invoice = { id: `in_${seq}`, object: 'invoice', customer: cus, customer_email: email, parent: { subscription_details: { subscription: sub } }, lines: { data: [{ pricing: { price_details: { price } } }] } };
  const checkout = { id: `cs_live_${seq}`, object: 'checkout.session', mode: 'subscription', customer: cus, subscription: sub, payment_status: 'paid', status: 'complete', payment_link: price === MONTHLY ? 'plink_1UEWBIF3CaVzg4ORg7YW06bL' : 'plink_1UEWB9F3CaVzg4ORZYoCRQoI', customer_details: { email }, metadata: { acquired_sport: 'nfl', product: 'propbetedge_nfl', price_id: price, plan } };
  return {
    sub, cus, periodEnd, email,
    created: evt('customer.subscription.created', subscription('incomplete'), t0),
    updatedActive: evt('customer.subscription.updated', subscription('active'), t0),
    invoicePaid: evt('invoice.paid', invoice, t0 + 1),
    checkout: evt('checkout.session.completed', checkout, t0 + 2),
    subscription, invoice,
  };
}

const rowFor = (h, sub) => h.db.tables.nfl_subscriptions.find(r => r.stripe_subscription_id === sub);
function assertEntitled(row, p, price) {
  assert.ok(row, 'row exists');
  assert.equal(row.customer_email, p.email.toLowerCase(), 'normalized purchaser email');
  assert.equal(row.stripe_price_id, price, 'recognized NFL price');
  assert.match(row.stripe_subscription_id, /^sub_/);
  assert.match(row.stripe_customer_id, /^cus_/);
  assert.ok(row.current_period_end, 'non-null current_period_end');
  assert.equal(Date.parse(row.current_period_end), p.periodEnd * 1000, 'period end is the subscription item period end');
  assert.ok(Date.parse(row.current_period_end) > Date.now(), 'period end in the future');
  assert.equal(row.status, 'active');
}

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [x, ...rest]));
}

/* ================================================================== tests */

test('Founding weekly purchase: every delivery order of the four purchase events ends entitled', async () => {
  const names = ['created', 'updatedActive', 'invoicePaid', 'checkout'];
  const orders = permutations(names);
  assert.equal(orders.length, 24);
  for (const order of orders) {
    const h = harness();
    const p = purchase();
    for (const name of order) {
      const r = await h.deliver(p[name]);
      assert.equal(r.status, 200, `${order.join('>')}: ${name} -> ${JSON.stringify(r.body)}`);
    }
    assertEntitled(rowFor(h, p.sub), p, WEEKLY);
    assert.equal(h.db.tables.nfl_subscriptions.length, 1, `${order.join('>')}: one row`);
    assert.equal(h.emails.length, 1, `${order.join('>')}: exactly one access email`);
    assert.deepEqual(h.emails[0], { email: p.email.toLowerCase(), purpose: 'purchase' });
    assert.equal(h.db.tables.nfl_stripe_webhook_events.length, 4);
  }
});

test('the pre-fix failure: checkout delivered before an earlier-created subscription.created no longer leaves a null period', async () => {
  const h = harness();
  const p = purchase();
  await h.deliver(p.checkout);                     // created t0+2, delivered first
  assert.equal(rowFor(h, p.sub).current_period_end, null, 'checkout alone cannot know the period');
  await h.deliver(p.created);                      // created t0, delivered second
  await h.deliver(p.updatedActive);
  assertEntitled(rowFor(h, p.sub), p, WEEKLY);
});

test('Founding monthly purchase ends entitled with a monthly period', async () => {
  const h = harness();
  const p = purchase({ price: MONTHLY, plan: 'nfl_founding_monthly', periodDays: 31 });
  for (const e of [p.invoicePaid, p.checkout, p.created, p.updatedActive]) assert.equal((await h.deliver(e)).status, 200);
  assertEntitled(rowFor(h, p.sub), p, MONTHLY);
});

test('duplicate resend is a signed 200 no-op: received + duplicate, nothing written, no second email', async () => {
  const h = harness();
  const p = purchase();
  for (const e of [p.created, p.updatedActive, p.invoicePaid, p.checkout]) await h.deliver(e);
  const before = JSON.stringify(h.db.tables);
  const writesBefore = h.db.log.filter(x => x.method !== 'GET').length;
  const r = await h.deliver(p.checkout);            // Stripe re-signs a resend with a new timestamp
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { received: true, duplicate: true });
  assert.equal(JSON.stringify(h.db.tables), before);
  assert.equal(h.db.log.filter(x => x.method !== 'GET').length, writesBefore, 'zero writes');
  assert.equal(h.emails.length, 1);
});

test('signature: wrong secret, tampered body, missing header and a stale timestamp are rejected before any database access', async () => {
  const h = harness();
  const p = purchase();
  assert.equal((await h.deliver(p.checkout, { secret: 'whsec_wrong' })).status, 400);
  assert.equal((await h.deliver(p.checkout, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
  const raw = JSON.stringify(p.checkout);
  const real = globalThis.fetch; globalThis.fetch = h.db.fetch;
  try {
    const tampered = await worker.fetch(new Request('https://x/webhook', { method: 'POST', headers: { 'stripe-signature': await sign(raw) }, body: raw.replace('paid', 'unpaid') }), h.env);
    assert.equal(tampered.status, 400);
    const missing = await worker.fetch(new Request('https://x/webhook', { method: 'POST', body: raw }), h.env);
    assert.equal(missing.status, 400);
  } finally { globalThis.fetch = real; }
  assert.equal(h.db.log.length, 0, 'no database call for any rejected delivery');
});

test('renewal advances the period; an out-of-order older update cannot roll it back', async () => {
  const h = harness();
  const p = purchase({ t0: NOW - 6 * 86400 });
  for (const e of [p.created, p.updatedActive, p.invoicePaid, p.checkout]) await h.deliver(e);
  const renewedEnd = p.periodEnd + 7 * 86400;
  const renewed = p.subscription('active', { items: { data: [{ price: { id: WEEKLY }, current_period_end: renewedEnd }] } });
  await h.deliver(evt('customer.subscription.updated', renewed, NOW + 10));
  await h.deliver(evt('invoice.paid', p.invoice, NOW + 11));
  assert.equal(Date.parse(rowFor(h, p.sub).current_period_end), renewedEnd * 1000);
  const r = await h.deliver(evt('customer.subscription.updated', p.subscription('active'), NOW + 5));
  assert.equal(r.body.reason, 'stale');
  assert.equal(Date.parse(rowFor(h, p.sub).current_period_end), renewedEnd * 1000);
  assert.equal(h.emails.length, 1, 'renewal does not resend the access email');
});

test('payment failure and recovery follow subscription status, whatever order the invoices arrive in', async () => {
  const h = harness();
  const p = purchase();
  for (const e of [p.created, p.updatedActive, p.invoicePaid, p.checkout]) await h.deliver(e);
  await h.deliver(evt('invoice.payment_failed', p.invoice, NOW + 100));
  assert.equal(rowFor(h, p.sub).status, 'active', 'an invoice alone never flips access');
  await h.deliver(evt('customer.subscription.updated', p.subscription('past_due'), NOW + 101));
  assert.equal(rowFor(h, p.sub).status, 'past_due');
  await h.deliver(evt('customer.subscription.updated', p.subscription('active'), NOW + 200));
  await h.deliver(evt('invoice.payment_failed', p.invoice, NOW + 150));   // late, older failure
  assert.equal(rowFor(h, p.sub).status, 'active');
});

test('cancellation: at period end, then deleted -> canceled; a late checkout cannot resurrect it', async () => {
  const h = harness();
  const p = purchase();
  for (const e of [p.created, p.updatedActive, p.invoicePaid]) await h.deliver(e);
  await h.deliver(evt('customer.subscription.updated', p.subscription('active', { cancel_at_period_end: true }), NOW + 50));
  assert.equal(rowFor(h, p.sub).cancel_at_period_end, true);
  await h.deliver(evt('customer.subscription.deleted', p.subscription('canceled'), NOW + 60));
  assert.equal(rowFor(h, p.sub).status, 'canceled');
  await h.deliver(p.checkout);                      // created t0+2, delivered after cancellation
  assert.equal(rowFor(h, p.sub).status, 'canceled', 'still canceled');
  assert.equal(rowFor(h, p.sub).customer_email, p.email.toLowerCase(), 'identity still linked');
});

test('same-second created/updated: a late .created never returns an active subscriber to incomplete', async () => {
  const h = harness();
  const p = purchase();
  await h.deliver(p.updatedActive);
  const r = await h.deliver(p.created);
  assert.equal(r.body.reason, 'stale_same_second');
  await h.deliver(p.checkout);
  assertEntitled(rowFor(h, p.sub), p, WEEKLY);
});

test('non-NFL traffic on the shared endpoint is recorded and ignored: MLB subscriptions, other checkouts, other invoices', async () => {
  const h = harness();
  const mlb = { id: 'sub_mlb1', customer: 'cus_mlb1', status: 'active', items: { data: [{ price: { id: MLB_PRICE }, current_period_end: NOW + 30 * 86400 }] } };
  const outcomes = [];
  outcomes.push(await h.deliver(evt('customer.subscription.created', mlb, NOW)));
  outcomes.push(await h.deliver(evt('checkout.session.completed', { id: 'cs_live_mlb', mode: 'subscription', subscription: 'sub_mlb1', customer: 'cus_mlb1', payment_status: 'paid', customer_details: { email: 'mlb@x.test' }, metadata: { acquired_sport: 'mlb' } }, NOW)));
  outcomes.push(await h.deliver(evt('invoice.paid', { id: 'in_mlb', customer_email: 'mlb@x.test', parent: { subscription_details: { subscription: 'sub_mlb1' } }, lines: { data: [{ pricing: { price_details: { price: MLB_PRICE } } }] } }, NOW)));
  assert.ok(outcomes.every(o => o.status === 200 && o.body.applied === false && o.body.reason === 'not_nfl'), JSON.stringify(outcomes));
  assert.equal(h.db.tables.nfl_subscriptions.length, 0);
  assert.equal(h.db.tables.nfl_stripe_webhook_events.length, 3, 'recorded, so Stripe does not retry them forever');
  assert.equal(h.emails.length, 0);
});

test('a retired legacy weekly price keeps working for existing customers; an unknown NFL price is refused loudly', async () => {
  const h = harness();
  const p = purchase({ price: LEGACY_WEEKLY, plan: 'nfl_weekly' });
  for (const e of [p.checkout, p.created, p.updatedActive]) await h.deliver(e);
  assertEntitled(rowFor(h, p.sub), p, LEGACY_WEEKLY);
  const bad = purchase({ price: 'price_1NotAnNflPrice' });
  const r = await h.deliver(bad.checkout);
  assert.equal(r.status, 500, 'Stripe retries; nothing half-written');
  assert.equal(rowFor(h, bad.sub), undefined);
  assert.ok(!h.db.tables.nfl_stripe_webhook_events.some(e => e.event_id === bad.checkout.id), 'a failed event is not marked done');
});

test('a database outage returns 500 and records nothing, so Stripe redelivers and the purchase lands', async () => {
  const h = harness();
  const p = purchase();
  h.db.failWrites = true;
  assert.equal((await h.deliver(p.created)).status, 500);
  assert.equal(h.db.tables.nfl_stripe_webhook_events.length, 0);
  h.db.failWrites = false;
  for (const e of [p.created, p.updatedActive, p.invoicePaid, p.checkout]) assert.equal((await h.deliver(e)).status, 200);
  assertEntitled(rowFor(h, p.sub), p, WEEKLY);
});

test('Supabase auth headers: a legacy JWT goes on apikey + Bearer, an sb_secret key on apikey only', async () => {
  for (const [key, bearer] of [['eyJhbGciOiJIUzI1NiJ9.legacy', true], ['sb_secret_modernkey', false]]) {
    const h = harness({ key });
    const p = purchase();
    await h.deliver(p.created);
    assert.ok(h.db.log.length > 0);
    assert.ok(h.db.log.every(x => x.apikey === key));
    assert.ok(h.db.log.every(x => (bearer ? x.auth === `Bearer ${key}` : x.auth === null)), key);
  }
});

test('health: configured flags, and ?deep=1 proves ledger + auth reachability without returning rows', async () => {
  const h = harness();
  const shallow = await h.health();
  assert.equal(shallow.ok, true);
  assert.equal(shallow.deep, undefined);
  const deep = await h.health('?deep=1');
  assert.deepEqual(deep.deep, { ledger: 'ok', auth: 'ok' });
  assert.equal(deep.ok, true);
  assert.ok(!JSON.stringify(deep).includes('evt_'), 'no ledger content');
  const broken = harness({ key: '' });
  broken.env.SUPABASE_SERVICE_ROLE_KEY = '';
  assert.equal((await broken.health()).ok, false);
});
