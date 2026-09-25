/* My Sunday: the session boundary (api/my-sunday.js) in front of the storage
 * Worker (workers/nfl-my-sunday), end to end, with the REAL session verifier
 * and entitlement path, the REAL migration on SQLite, and fakes only at the
 * network edge (the NFL ledger, the billing ledger, nfl-intel, nfl-odds).
 *
 * Covered: anonymous / forged-session denial; NFL Pro, All Access and Owner;
 * paywalled and unavailable verdicts; CSRF; private caching; cross-account
 * read / write / delete denial; identity claims ignored; idempotent saves
 * that never overwrite the snapshot; explicit import; alert matching,
 * deduplication, source failures and corrections; prop line vs price. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SECRET = 'my-sunday-signing-secret';
const SUPABASE = 'https://supabase.mysunday.test';
const BILLING = 'https://billing.mysunday.test';
const READ_TOKEN = 'mysunday-billing-read-token';
Object.assign(process.env, {
  SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'mysunday-service-role', NFL_SESSION_SIGNING_SECRET: SECRET,
  NFL_OWNER_EMAILS: 'owner@mysunday.test', PBE_BILLING_URL: BILLING, PBE_ENTITLEMENT_READ_TOKEN: READ_TOKEN
});
const { SESSION_COOKIE, HMAC_NAMESPACE } = await import('../api/_nfl-auth.js');
const { NFL_PRICES } = await import('../api/_nfl-entitlement.js');
const { default: boundary, ownerKey, csrfOk } = await import('../api/my-sunday.js');
const worker = await import('../workers/nfl-my-sunday/src/index.js');
const core = await import('../workers/nfl-my-sunday/src/core.js');

/* ---- ledgers at the network edge ------------------------------------------ */
const DAY = 86400000, iso = ms => new Date(ms).toISOString();
const NFL_LEDGER = { 'pro@mysunday.test': [{ customer_email: 'pro@mysunday.test', status: 'active', stripe_price_id: NFL_PRICES.foundingMonthly, stripe_subscription_id: 'sub_ms', stripe_customer_id: 'cus_ms', stripe_checkout_session_id: 'cs_live_ms', current_period_end: iso(Date.now() + 5 * DAY), cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z' }] };
const ALL_ACCESS = { 'allaccess@mysunday.test': { entitled: true, product_key: 'pbe_all_access', access_source: 'all_access', subscription: { product_key: 'pbe_all_access', plan: 'monthly', status: 'active', current_period_end: iso(Date.now() + 20 * DAY), cancel_at_period_end: false } } };
let ledgerDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin === SUPABASE) {
    if (ledgerDown) return new Response('{}', { status: 503 });
    const email = (/customer_email=ilike\.([^&]+)/.exec(decodeURIComponent(u.search))?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return new Response(JSON.stringify(NFL_LEDGER[email] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.origin === BILLING) {
    const body = JSON.parse(init.body || '{}');
    return new Response(JSON.stringify(ALL_ACCESS[String(body.email).toLowerCase()] || { entitled: false, product_key: 'pbe_all_access', access_source: null, subscription: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const b64u = v => Buffer.from(v).toString('base64url');
function mint(email, { secret = SECRET, exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ type: 'session', email, exp }))}`;
  return `${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${secret}`).update(data).digest())}`;
}

/* ---- D1 over SQLite, with the real migration --------------------------------- */
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../workers/nfl-my-sunday/migrations/0001_my_sunday.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }
  });
  return { prepare: sql => stmt(sql), raw: db };
}

const HOST = 'nfl.propbetedge.ai';
const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const OWNER_SECRET = 'owner-secret-for-tests-0123456789abcdef0123';
let INTEL = { sources: {}, changes: [] };
let BOARD = {};
function setup() {
  const DB = d1();
  const wenv = {
    DB, MY_SUNDAY_INTERNAL_TOKEN: TOKEN,
    NFL_INTEL: { fetch: async () => new Response(JSON.stringify(INTEL), { status: INTEL.__status || 200 }) },
    NFL_ODDS: { fetch: async req => { const id = new URL(req.url).searchParams.get('event_id'); return BOARD[id] ? new Response(JSON.stringify(BOARD[id])) : new Response('{}', { status: 503 }); } }
  };
  const calls = [];
  const env = { MY_SUNDAY_ENABLED: '1', MY_SUNDAY_ORIGIN: 'https://my-sunday.internal', MY_SUNDAY_INTERNAL_TOKEN: TOKEN, MY_SUNDAY_OWNER_SECRET: OWNER_SECRET };
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return worker.handle(new Request(url, init), wenv, { waitUntil: () => {} }); };
  async function call({ method = 'GET', op = '', email = null, cookie = null, body = undefined, headers = {} } = {}) {
    const h = { host: HOST, ...headers };
    if (cookie || email) h.cookie = `${SESSION_COOKIE}=${cookie || mint(email)}`;
    if (method === 'POST') Object.assign(h, { origin: `https://${HOST}`, 'content-type': 'application/json', 'x-pbe-csrf': '1', ...headers });
    const req = { method, headers: h, query: op ? { op } : {}, body };
    const res = { statusCode: 0, headers: {}, text: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.text = t; } };
    await boundary(req, res, { env, fetch: fetchImpl });
    let json = null; try { json = JSON.parse(res.text); } catch (_) {}
    return { status: res.statusCode, headers: res.headers, body: json };
  }
  return { call, DB, wenv, calls, env };
}

const player = (espn, label = 'Player') => ({ type: 'player', espn_id: espn, team: 'KC', season: 2026, label });
const prop = over => ({ type: 'prop', event_id: '401872953', odds_event_id: 'a'.repeat(32), espn_id: '3116406', market: 'player_reception_yds', side: 'over', line: 64.5, price: -115, book: 'DraftKings', captured_at: '2026-09-25T17:00:00Z', provider_player: 'Tyreek Hill', label: 'Tyreek Hill over 64.5 receiving yards', ...over });

/* ---- access ------------------------------------------------------------------- */

test('anonymous and forged sessions are denied before storage is touched', async () => {
  const { call, calls } = setup();
  const anon = await call();
  assert.equal(anon.status, 200, 'a signed-out read is device mode, not an error');
  assert.deepEqual([anon.body.synced, anon.body.items, anon.body.access], [false, [], 'anonymous']);
  for (const cookie of [mint('owner@mysunday.test', { secret: 'attacker-secret' }), mint('owner@mysunday.test', { exp: Math.floor(Date.now() / 1000) - 10 }), 'not.a.jwt']) {
    const r = await call({ cookie });
    assert.equal(r.body.synced, false, 'forged / expired / malformed cookie -> no synced data');
    assert.equal((await call({ method: 'POST', op: 'save', cookie, body: { item: player('1') } })).status, 401, 'and no write');
  }
  assert.equal((await call({ method: 'POST', op: 'save', body: { item: player('1') } })).status, 401);
  assert.equal(calls.length, 0, 'storage never touched');
});

test('NFL Pro, All Access and Owner are granted server-side; a paywalled email is not', async () => {
  const { call } = setup();
  for (const email of ['pro@mysunday.test', 'allaccess@mysunday.test', 'owner@mysunday.test']) {
    const r = await call({ email });
    assert.equal(r.status, 200, email);
    assert.deepEqual(r.body.items, []);
  }
  const free = await call({ email: 'free@mysunday.test' });
  assert.equal(free.body.synced, false, 'a paywalled email reads as device mode');
  const freeWrite = await call({ method: 'POST', op: 'save', email: 'free@mysunday.test', body: { item: player('2') } });
  assert.equal(freeWrite.status, 403);
  assert.equal(freeWrite.body.error, 'nfl_pro_required');
});

test('an entitlement check that cannot complete is 503, never a grant', async () => {
  const { call } = setup();
  ledgerDown = true;
  try { assert.equal((await call({ email: 'pro@mysunday.test' })).status, 503); }
  finally { ledgerDown = false; }
});

test('feature flag off: 404 and no session work at all', async () => {
  const { call, env } = setup();
  env.MY_SUNDAY_ENABLED = '0';
  const r = await call({ email: 'owner@mysunday.test' });
  assert.equal(r.status, 404); assert.equal(r.body.error, 'feature_disabled');
});

test('CSRF: writes need the custom header, JSON and this host as Origin', async () => {
  const { call } = setup();
  const body = { item: player('100') };
  assert.equal((await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body, headers: { 'x-pbe-csrf': '' } })).status, 403);
  assert.equal((await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 403);
  assert.equal((await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body, headers: { origin: `https://${HOST}.evil.example` } })).status, 403);
  assert.equal((await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body })).status, 201);
  assert.equal(csrfOk({ headers: { 'x-pbe-csrf': '1', 'content-type': 'application/json', host: HOST } }), false, 'no Origin -> refused');
});

test('personal answers are private, uncached and vary on Cookie', async () => {
  const { call } = setup();
  const r = await call({ email: 'owner@mysunday.test' });
  assert.match(r.headers['cache-control'], /private/); assert.match(r.headers['cache-control'], /no-store/);
  assert.equal(r.headers.vary, 'Cookie');
  const denied = await call();
  assert.match(denied.headers['cache-control'], /no-store/);
  assert.equal(denied.headers.vary, 'Cookie');
});

/* ---- ownership ------------------------------------------------------------------ */

test('account A cannot read, overwrite or delete account B\'s items', async () => {
  const { call } = setup();
  await call({ method: 'POST', op: 'save', email: 'pro@mysunday.test', body: { item: player('111', 'Pro Player') } });
  await call({ method: 'POST', op: 'save', email: 'allaccess@mysunday.test', body: { item: player('222', 'AA Player') } });
  const a = await call({ email: 'pro@mysunday.test' });
  assert.deepEqual(a.body.items.map(i => i.label), ['Pro Player']);
  const del = await call({ method: 'POST', op: 'remove', email: 'pro@mysunday.test', body: { item_key: 'player:e222' } });
  assert.equal(del.body.deleted, false, 'deleting another account\'s key is a no-op');
  const b = await call({ email: 'allaccess@mysunday.test' });
  assert.deepEqual(b.body.items.map(i => i.label), ['AA Player']);
});

test('identity claims in the body are ignored: the session decides the owner', async () => {
  const { call, DB } = setup();
  const victim = ownerKey('allaccess@mysunday.test', OWNER_SECRET);
  await call({ method: 'POST', op: 'save', email: 'pro@mysunday.test', body: { item: player('333'), owner: victim, owner_key: victim, email: 'allaccess@mysunday.test' } });
  const rows = DB.raw.prepare('SELECT owner_key FROM saved_items').all();
  assert.deepEqual(rows.map(r => r.owner_key), [ownerKey('pro@mysunday.test', OWNER_SECRET)]);
  assert.equal((await call({ email: 'allaccess@mysunday.test' })).body.items.length, 0);
});

test('the storage Worker refuses anything without the internal token and an owner key', async () => {
  const { wenv } = setup();
  const r1 = await worker.handle(new Request('https://w/v1/items', { headers: { 'x-pbe-owner': 'a'.repeat(64) } }), wenv, {});
  assert.equal(r1.status, 401);
  const r2 = await worker.handle(new Request('https://w/v1/items', { headers: { authorization: `Bearer ${TOKEN}` } }), wenv, {});
  assert.equal(r2.status, 400);
  const r3 = await worker.handle(new Request('https://w/v1/items', { headers: { authorization: `Bearer ${TOKEN}x`, 'x-pbe-owner': 'a'.repeat(64) } }), wenv, {});
  assert.equal(r3.status, 401);
});

test('the owner key never carries the email, and differs per account', () => {
  const k = ownerKey('owner@mysunday.test', OWNER_SECRET);
  assert.match(k, /^[a-f0-9]{64}$/);
  assert.ok(!k.includes('owner'));
  assert.notEqual(k, ownerKey('pro@mysunday.test', OWNER_SECRET));
  assert.equal(k, ownerKey('  OWNER@mysunday.test ', OWNER_SECRET), 'normalised email -> same owner');
});

/* ---- items ------------------------------------------------------------------------ */

test('repeated saves are idempotent and never overwrite the saved snapshot', async () => {
  const { call } = setup();
  const first = await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body: { item: prop() } });
  assert.equal(first.status, 201);
  const again = await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body: { item: prop({ line: 70.5, price: -140, captured_at: '2026-09-26T17:00:00Z' }) } });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.item.saved_line, 64.5, 'today\'s line never replaces what was saved');
  assert.equal(again.body.item.saved_price, -115);
  const list = await call({ email: 'owner@mysunday.test' });
  assert.equal(list.body.items.length, 1);
});

test('the item key is derived server-side; a client key is ignored', () => {
  const v = core.validateItem({ ...player('444'), item_key: 'game:1', type: 'player' });
  assert.equal(v.item.item_key, 'player:e444');
});

test('validation refuses malformed items', () => {
  const bad = [
    [{ type: 'nope', label: 'x' }, 'unknown_type'],
    [{ type: 'game', event_id: '12', label: 'x' }, 'bad_event_id'],
    [{ ...prop(), market: 'player_fantasy_points' }, 'bad_market'],
    [{ ...prop(), side: 'push' }, 'bad_side'],
    [{ ...prop(), price: 50 }, 'bad_price'],
    [{ ...prop(), line: 'abc' }, 'bad_line'],
    [{ ...prop(), captured_at: 'yesterday' }, 'bad_captured_at'],
    [{ ...player('1'), label: '' }, 'label_required'],
    [{ type: 'scenario', team: 'KC', season: 2026, label: 's', context: { scenario: { state: 'baseline', volume: 200, pass_rate: null, data_revision: 'r', calc_version: 'c' } } }, 'bad_scenario_volume']
  ];
  for (const [item, error] of bad) assert.equal(core.validateItem(item).error, error, error);
  assert.equal(core.validateItem({ ...player('1'), label: '<script>x</script>' }).item.label, 'scriptx/script', 'markup is stripped');
});

test('a scenario is saved with its inputs, data revision and calculation version', () => {
  const s = { state: 'trailing', volume: 66, pass_rate: 0.62, data_revision: '"0x8DF1B1251455441"', calc_version: 'game-script/1.0.0' };
  const v = core.validateItem({ type: 'scenario', team: 'KC', season: 2026, label: 'KC trailing script', context: { scenario: s, official: false } });
  assert.equal(v.ok, true);
  assert.match(v.item.item_key, /^scenario:KC:2026:[0-9a-f]{8}$/);
  assert.equal(v.item.context.scenario.calc_version, 'game-script/1.0.0');
  const other = core.validateItem({ type: 'scenario', team: 'KC', season: 2026, label: 'x', context: { scenario: { ...s, volume: 67 } } });
  assert.notEqual(other.item.item_key, v.item.item_key, 'different inputs are a different scenario');
});

test('explicit import: validated, capped, idempotent, reported item by item', async () => {
  const { call } = setup();
  await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body: { item: player('555') } });
  const r = await call({ method: 'POST', op: 'import', email: 'owner@mysunday.test', body: { items: [player('555'), player('556'), { type: 'bogus', label: 'x' }] } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.imported, r.body.already_saved, r.body.rejected], [1, 1, 1]);
  const tooMany = await call({ method: 'POST', op: 'import', email: 'owner@mysunday.test', body: { items: Array.from({ length: 51 }, (_, i) => player(String(1000 + i))) } });
  assert.equal(tooMany.status, 422);
});

test('remove deletes the item and its alerts, for this owner only', async () => {
  const { call, DB } = setup();
  await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body: { item: player('666') } });
  DB.raw.prepare("INSERT INTO alerts VALUES (?1,'x','player:e666','AVAILABILITY','{}','2026-09-25T00:00:00Z','2026-09-25T00:00:00Z',NULL)").run(ownerKey('owner@mysunday.test', OWNER_SECRET));
  const r = await call({ method: 'POST', op: 'remove', email: 'owner@mysunday.test', body: { item_key: 'player:e666' } });
  assert.equal(r.body.deleted, true);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM alerts').get().n, 0);
});

/* ---- alerts ---------------------------------------------------------------------------- */

const INJ = (id, espn, status, when, transition = null) => ({ id, kind: 'INJURY_STATUS', status, observed_at: when, headline: `Player — ${status}`, source: { label: 'ESPN injury report' }, player: { espn_id: espn }, game: { id: '401872953', matchup: 'LAC @ BUF' }, transition });
const SOURCES_OK = { injuries: { available: true }, scoreboard: { available: true }, market: { available: true } };

test('availability alerts: only changes after the save, deduplicated across refreshes', async () => {
  const { call, wenv, DB } = setup();
  await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body: { item: player('777', 'Saved Player') } });
  const savedAt = DB.raw.prepare('SELECT saved_at FROM saved_items').get().saved_at;
  const later = new Date(Date.parse(savedAt) + 60000).toISOString();
  const earlier = new Date(Date.parse(savedAt) - 60000).toISOString();
  INTEL = { sources: SOURCES_OK, changes: [INJ('inj:1:OUT', '777', 'OUT', later, { from: 'QUESTIONABLE', to: 'OUT', observed_at: later }), INJ('inj:0:Q', '777', 'QUESTIONABLE', earlier)] };
  await worker.refreshAlerts(wenv);
  await worker.refreshAlerts(wenv);
  const list = await call({ email: 'owner@mysunday.test' });
  assert.equal(list.body.alerts.length, 1, 'one change, two refreshes -> one alert; the pre-save designation -> none');
  const a = list.body.alerts[0];
  assert.equal(a.kind, 'AVAILABILITY');
  assert.deepEqual([a.payload.previous, a.payload.current], ['QUESTIONABLE', 'OUT']);
  assert.equal(a.item_key, 'player:e777');
  assert.ok(a.observed_at && a.payload.source);
});

test('a failed source read is not a change, and never erases alerts already recorded', async () => {
  const { call, wenv, DB } = setup();
  await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body: { item: player('888') } });
  const savedAt = DB.raw.prepare('SELECT saved_at FROM saved_items').get().saved_at;
  const later = new Date(Date.parse(savedAt) + 60000).toISOString();
  INTEL = { sources: SOURCES_OK, changes: [INJ('inj:8:OUT', '888', 'OUT', later)] };
  await worker.refreshAlerts(wenv);
  INTEL = { __status: 503 };
  const s = await worker.refreshAlerts(wenv);
  assert.equal(s.intel.ok, false);
  INTEL = { sources: { ...SOURCES_OK, injuries: { available: false } }, changes: [INJ('inj:8:ACTIVE', '888', 'ACTIVE', later)] };
  await worker.refreshAlerts(wenv);
  const list = await call({ email: 'owner@mysunday.test' });
  assert.deepEqual(list.body.alerts.map(a => a.alert_id), ['inj:8:OUT'], 'the unavailable lane added nothing and removed nothing');
  INTEL = { __status: 503 };
  await worker.refreshAlerts(wenv);
  const st = await call({ email: 'owner@mysunday.test' });
  assert.equal(st.body.alerts_state, 'SOURCE_UNAVAILABLE');
});

test('a corrected designation is a new alert; the earlier one keeps its meaning', async () => {
  const { call, wenv, DB } = setup();
  await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body: { item: player('999') } });
  const savedAt = Date.parse(DB.raw.prepare('SELECT saved_at FROM saved_items').get().saved_at);
  INTEL = { sources: SOURCES_OK, changes: [INJ('inj:9:OUT', '999', 'OUT', new Date(savedAt + 1000).toISOString())] };
  await worker.refreshAlerts(wenv);
  INTEL = { sources: SOURCES_OK, changes: [INJ('inj:9:QUESTIONABLE', '999', 'QUESTIONABLE', new Date(savedAt + 5000).toISOString(), { from: 'OUT', to: 'QUESTIONABLE', observed_at: new Date(savedAt + 5000).toISOString() })] };
  await worker.refreshAlerts(wenv);
  const list = await call({ email: 'owner@mysunday.test' });
  assert.deepEqual(list.body.alerts.map(a => [a.payload.previous, a.payload.current]), [['OUT', 'QUESTIONABLE'], [null, 'OUT']]);
});

test('game alerts: status changes and consensus market moves keep line and price apart', () => {
  const saved = { item_type: 'game', item_key: 'game:401872953', event_id: '401872953', saved_at: '2026-09-25T00:00:00Z' };
  const payload = { sources: SOURCES_OK, changes: [
    { id: 'gs:1', kind: 'GAME_STATUS', status: 'POSTPONED', observed_at: '2026-09-26T00:00:00Z', headline: 'LAC @ BUF postponed', game: { id: '401872953' } },
    { id: 'mkt:1', kind: 'MARKET_MOVE', observed_at: '2026-09-25T17:00:00Z', headline: 'BUF spread -7.5 → -7', game: { id: '401872953' }, market: { market: 'spread', selection: 'BUF', from: { line: -7.5, price: -105, captured_at: '2026-09-24T12:00:00Z' }, to: { line: -7, price: -112, captured_at: '2026-09-25T17:00:00Z' } } },
    { id: 'mkt:2', kind: 'MARKET_MOVE', observed_at: '2026-09-25T18:00:00Z', headline: 'total juice', game: { id: '401872953' }, market: { market: 'total', selection: 'OVER', from: { line: 44.5, price: -110, captured_at: 'a' }, to: { line: 44.5, price: -125, captured_at: '2026-09-25T18:00:00Z' } } },
    { id: 'mkt:3', kind: 'MARKET_MOVE', observed_at: '2026-09-25T18:00:00Z', headline: 'other game', game: { id: '401872999' }, market: { from: {}, to: { captured_at: '2026-09-25T18:00:00Z' } } }
  ] };
  const out = core.matchIntel([saved], payload);
  assert.deepEqual(out.map(a => [a.kind, a.payload.movement || a.payload.current]), [['GAME_STATUS', 'POSTPONED'], ['MARKET_MOVE', 'line_and_price'], ['MARKET_MOVE', 'price']]);
  assert.equal(core.matchIntel([saved], { ...payload, sources: { ...SOURCES_OK, market: { available: false }, scoreboard: { available: false } } }).length, 0);
});

test('prop alerts compare the same book, side and market; a vanished quote is not a change', () => {
  const v = core.validateItem(prop());
  const saved = { ...v.item, saved_at: '2026-09-25T17:30:00Z' };
  const board = quotes => ({ captured_at: '2026-09-26T13:00:00Z', quotes });
  const Q = (book, side, point, price, market = 'player_reception_yds', player = 'Tyreek Hill') => ({ player, book, direction: side, point, price, market });
  assert.equal(core.propAlert(saved, board([Q('DraftKings', 'Over', 66.5, -110)])).kind, 'PROP_LINE');
  assert.equal(core.propAlert(saved, board([Q('DraftKings', 'Over', 64.5, -135)])).kind, 'PROP_PRICE');
  assert.equal(core.propAlert(saved, board([Q('DraftKings', 'Over', 64.5, -120)])), null, '5 cents is not meaningful');
  assert.equal(core.propAlert(saved, board([Q('FanDuel', 'Over', 70.5, -110)])), null, 'another book is not equivalent');
  assert.equal(core.propAlert(saved, board([Q('DraftKings', 'Under', 70.5, -110)])), null, 'another side is not equivalent');
  assert.equal(core.propAlert(saved, board([])), null, 'no quote now is not a move');
  assert.equal(core.propAlert(saved, { captured_at: '2026-09-25T17:00:00Z', quotes: [Q('DraftKings', 'Over', 70.5, -110)] }), null, 'a snapshot older than the save is not news');
  const a = core.propAlert(saved, board([Q('DraftKings', 'Over', 66.5, -110)]));
  assert.equal(a.alert_id, core.propAlert(saved, board([Q('DraftKings', 'Over', 66.5, -110)])).alert_id, 'same observation -> same dedupe id');
  assert.deepEqual([a.payload.line_from, a.payload.line_to, a.payload.price_from, a.payload.price_to], [64.5, 66.5, -115, -110]);
});

test('American price distance crosses even money correctly', () => {
  assert.equal(core.priceDistance(-110, 110), 20);
  assert.equal(core.priceDistance(-115, -130), 15);
  assert.equal(core.priceDistance(120, 150), 30);
});

test('prop alerts through the shared refresh: one board read per event, for everyone', async () => {
  const { call, wenv, DB } = setup();
  let reads = 0;
  const orig = wenv.NFL_ODDS.fetch;
  wenv.NFL_ODDS.fetch = async req => { reads++; return orig(req); };
  await call({ method: 'POST', op: 'save', email: 'owner@mysunday.test', body: { item: prop() } });
  await call({ method: 'POST', op: 'save', email: 'pro@mysunday.test', body: { item: prop() } });
  BOARD = { ['a'.repeat(32)]: { captured_at: new Date(Date.now() + 60000).toISOString(), quotes: [{ player: 'Tyreek Hill', book: 'DraftKings', direction: 'Over', point: 68.5, price: -110, market: 'player_reception_yds' }] } };
  INTEL = { sources: SOURCES_OK, changes: [] };
  await worker.refreshAlerts(wenv);
  assert.equal(reads, 1, 'two readers saved the same prop; the board was read once');
  for (const email of ['owner@mysunday.test', 'pro@mysunday.test']) {
    const list = await call({ email });
    assert.deepEqual(list.body.alerts.map(a => a.kind), ['PROP_LINE'], email);
  }
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM alerts').get().n, 2);
});

test('mark read is scoped to the owner', async () => {
  const { call, DB } = setup();
  const a = ownerKey('owner@mysunday.test', OWNER_SECRET), b = ownerKey('pro@mysunday.test', OWNER_SECRET);
  for (const o of [a, b]) DB.raw.prepare("INSERT INTO alerts VALUES (?1,'shared-id','player:e1','AVAILABILITY','{}','2026-09-25T00:00:00Z','2026-09-25T00:00:00Z',NULL)").run(o);
  const r = await call({ method: 'POST', op: 'read', email: 'owner@mysunday.test', body: { ids: ['shared-id'] } });
  assert.equal(r.body.marked, 1);
  assert.equal(DB.raw.prepare('SELECT read_at FROM alerts WHERE owner_key = ?1').get(b).read_at, null);
});

test('official records are out of reach: My Sunday code names no pick or grading table', () => {
  const src = [readFileSync(new URL('../api/my-sunday.js', import.meta.url), 'utf8'), readFileSync(new URL('../workers/nfl-my-sunday/src/index.js', import.meta.url), 'utf8'), readFileSync(new URL('../workers/nfl-my-sunday/src/core.js', import.meta.url), 'utf8'), readFileSync(new URL('../workers/nfl-my-sunday/migrations/0001_my_sunday.sql', import.meta.url), 'utf8')].join('\n');
  for (const t of ['nfl_prop_picks', 'nfl_game_picks', 'nfl_picks', 'track_record', 'grader', 'SUPABASE_SERVICE_ROLE_KEY', 'supabase.co']) assert.ok(!src.includes(t), t);
  const wrangler = readFileSync(new URL('../workers/nfl-my-sunday/wrangler.toml', import.meta.url), 'utf8');
  assert.ok(!/NFL_PICKS|nfl-picks|nfl-game-grader|nfl-prop-picks/.test(wrangler), 'no binding to the official engines');
});
