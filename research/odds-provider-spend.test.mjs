/* ODDS PROVIDER SPEND GATE
 *
 * The rule under test: USER TRAFFIC MUST NEVER DETERMINE OUR ODDS PROVIDER
 * SPEND. The nfl-odds worker is driven in-process with an in-memory KV and a
 * stubbed global fetch that counts every request to api.the-odds-api.com.
 *
 *   · one ingest = exactly 1 featured request + 1 request per event inside
 *     the player-market window, and nothing else
 *   · 100 sequential GETs to /api/odds, /api/odds/board and /api/home-market
 *     (the Vercel handler, with its gateway calls routed into the worker)
 *     make ZERO provider requests
 *   · reads expose LAST_VERIFIED_MARKET + captured_at, never LIVE
 *   · a failed scheduled ingest leaves the last verified batch in place and
 *     marks ingest.status LATEST_INGEST_UNAVAILABLE
 *   · the cron trigger only ingests at 08:00 / 13:00 / 18:00 New York time,
 *     in both EDT and EST
 *
 * Fixtures are today's real provider responses (research/fixtures/odds),
 * usage counters redacted. No real provider call is made here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { ingest, etHour } from '../workers/nfl-odds/src/index.js';
import homeMarket from '../api/home-market.js';

const FEATURED = JSON.parse(readFileSync(new URL('./fixtures/odds/featured-2026-09-06.json', import.meta.url), 'utf8'));
const BOARD = JSON.parse(readFileSync(new URL('./fixtures/odds/board-NE-SEA-player_pass_yds-2026-09-06.json', import.meta.url), 'utf8'));
const NE_SEA = '8c94552d022acec4a0458d70c19d3da9';
/* the fixture slate is Week 1; pin "now" inside it so the window logic is deterministic */
const NOW = new Date('2026-09-06T20:00:00Z');

/* the raw provider shape for one event's player markets, rebuilt from the
   flattened board fixture so the ingest exercises normalizeEvents */
function providerEventBody(eventId) {
  const ev = FEATURED.events.find((e) => e.id === eventId);
  const books = new Map();
  for (const q of BOARD.quotes) {
    if (!books.has(q.book_key)) books.set(q.book_key, { key: q.book_key, title: q.book, last_update: q.last_update, markets: new Map() });
    const b = books.get(q.book_key);
    if (!b.markets.has(q.market)) b.markets.set(q.market, { key: q.market, last_update: q.last_update, outcomes: [] });
    b.markets.get(q.market).outcomes.push({ name: q.direction === 'OVER' ? 'Over' : 'Under', description: q.player, price: q.price, point: q.point });
  }
  return { id: ev.id, sport_key: ev.sport_key, commence_time: ev.commence_time, home_team: ev.home_team, away_team: ev.away_team,
    bookmakers: [...books.values()].map((b) => ({ ...b, markets: [...b.markets.values()] })) };
}

function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(key, opts) { const v = store.get(key); if (v === undefined) return null; return (opts === 'json' || opts?.type === 'json') ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, String(value)); },
  };
}
function providerStub({ fail = false } = {}) {
  const calls = [];
  const usage = { used: 0 };
  return {
    calls,
    fetch: async (url) => {
      const u = String(url);
      if (!u.startsWith('https://api.the-odds-api.com/')) throw new Error(`unexpected non-provider fetch ${u}`);
      calls.push(u.replace(/apiKey=[^&]+/, 'apiKey=REDACTED'));
      const respond = (status, body, cost) => { usage.used += cost; return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-requests-used': String(usage.used), 'x-requests-remaining': String(100000 - usage.used), 'x-requests-last': String(cost) } }); };
      if (fail) return respond(401, { message: 'Usage quota has been reached', error_code: 'OUT_OF_USAGE_CREDITS' }, 0);
      const m = /\/events\/([^/]+)\/odds\?/.exec(u);
      if (m) return respond(200, providerEventBody(decodeURIComponent(m[1])), (new URL(u).searchParams.get('markets') || '').split(',').length);
      if (/\/sports\/americanfootball_nfl\/odds\?/.test(u)) return respond(200, FEATURED.events, 3);
      return respond(404, { message: 'no' }, 0);
    },
  };
}
const env = (kv) => ({ NFL_KV: kv, ODDS_API_KEY: 'test-key-not-real', ODDS_ADMIN_TOKEN: 'admin-test-token', INGEST_PROP_WINDOW_DAYS: '7' });
const req = (path, init) => new Request(`https://nfl-odds.internal${path}`, init);
async function seeded() {
  const kv = memoryKV(); const p = providerStub(); const real = globalThis.fetch; globalThis.fetch = p.fetch;
  try { const r = await ingest(env(kv), { trigger: 'test', now: NOW }); return { kv, ingestResult: r, ingestCalls: p.calls }; } finally { globalThis.fetch = real; }
}

test('one ingest = 1 featured request + 1 request per event in the window', async () => {
  const { ingestResult, ingestCalls, kv } = await seeded();
  const inWindow = FEATURED.events.filter((e) => { const t = Date.parse(e.commence_time); return t >= NOW.getTime() - 6 * 3600000 && t <= NOW.getTime() + 7 * 86400000; });
  assert.equal(ingestResult.status, 'ok');
  assert.equal(ingestCalls.filter((u) => /\/sports\/americanfootball_nfl\/odds\?/.test(u)).length, 1, 'exactly one featured slate request');
  assert.equal(ingestCalls.filter((u) => /\/events\/[^/]+\/odds\?/.test(u)).length, inWindow.length, 'one player-market request per in-window event');
  assert.equal(ingestCalls.length, 1 + inWindow.length);
  assert.ok(ingestCalls.every((u) => u.includes('apiKey=REDACTED')), 'stub saw a key and redacted it; the worker never logs it');
  const meta = await kv.get('odds:v1:meta', 'json');
  assert.equal(meta.counts.events, FEATURED.events.length);
  assert.equal(meta.counts.boards, inWindow.length);
  assert.equal(meta.credits_spent, 3 + inWindow.length * meta.player_markets.length);
  assert.ok(meta.batch_id && meta.captured_at && meta.provider_last_update);
});

test('100 sequential /api/odds + /api/odds/board + /api/home-market calls make ZERO provider requests', async () => {
  const { kv } = await seeded();
  const p = providerStub(); const real = globalThis.fetch;
  /* every network call the Vercel handler makes is routed into the worker;
     anything that reaches the provider is counted by the stub */
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.the-odds-api.com/')) return p.fetch(u);
    if (/\/api\/odds/.test(u)) return worker.fetch(req(new URL(u).pathname + new URL(u).search), env(kv), {});
    if (/\/api\/schedule/.test(u)) return new Response(JSON.stringify({ games: [{ game_id: '2026_01_NE_SEA', gameday: '2026-09-09', gametime: '20:20', away_team: 'NE', home_team: 'SEA' }] }), { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      const a = await worker.fetch(req('/api/odds'), env(kv), {});
      const b = await worker.fetch(req(`/api/odds/board?event_id=${NE_SEA}&markets=player_pass_yds`), env(kv), {});
      const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(x) { this.body = JSON.parse(x); } };
      await homeMarket({ method: 'GET', query: { away: 'New England Patriots', home: 'Seattle Seahawks' }, headers: {} }, res);
      if (a.status === 200 && b.status === 200 && res.statusCode === 200) ok++;
      if (i === 0) {
        const aj = await a.json(); const bj = await b.json();
        assert.equal(aj.semantics, 'LAST_VERIFIED_MARKET'); assert.equal(aj.cache, 'snapshot'); assert.ok(aj.captured_at); assert.equal(aj.source.semantics, 'MARKET_SNAPSHOT');
        assert.notEqual(aj.source.semantics, 'LIVE');
        assert.ok(aj.events.some((e) => e.id === NE_SEA), 'NE @ SEA is in the served slate');
        assert.equal(bj.semantics, 'LAST_VERIFIED_MARKET'); assert.ok(bj.quote_count > 0, 'player_pass_yds quotes served from the snapshot');
        assert.equal(bj.market_availability.player_pass_yds, 'IN_SNAPSHOT');
        assert.equal(res.body.semantics, 'MARKET_SNAPSHOT'); assert.equal(res.body.stale, false); assert.ok(res.body.captured_at);
        assert.equal(res.body.spread.home, -3.5); assert.equal(res.body.total.line, 44.5);
      }
    }
    assert.equal(ok, 100, 'all 300 reads answered 200');
    assert.equal(p.calls.length, 0, 'ZERO provider requests from 300 user reads');
  } finally { globalThis.fetch = real; }
});

test('reads never contact the provider even when our HTTP cache would have expired (no cache layer is consulted at all)', async () => {
  const { kv } = await seeded();
  const p = providerStub(); const real = globalThis.fetch; globalThis.fetch = p.fetch;
  try {
    for (const path of ['/api/odds', '/api/odds?season_type=regular', '/api/odds/events', `/api/odds/props?event_id=${NE_SEA}`, `/api/odds/board?event_id=${NE_SEA}`, '/api/odds/health', '/api/odds/snapshot']) {
      const r = await worker.fetch(req(path), env(kv), {});
      assert.ok([200].includes(r.status), `${path} -> ${r.status}`);
    }
    assert.equal(p.calls.length, 0);
  } finally { globalThis.fetch = real; }
});

test('a market the ingest did not capture is reported as unavailable, never fetched on demand', async () => {
  const { kv } = await seeded();
  const p = providerStub(); const real = globalThis.fetch; globalThis.fetch = p.fetch;
  try {
    const r = await worker.fetch(req(`/api/odds/board?event_id=${NE_SEA}&markets=player_sacks`), env(kv), {});
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.quote_count, 0); assert.equal(j.market_availability.player_sacks, 'NOT_OFFERED_AT_INGEST');
    const outside = FEATURED.events.find((e) => Date.parse(e.commence_time) > NOW.getTime() + 8 * 86400000) || { id: 'not-a-real-event' };
    const r2 = await worker.fetch(req(`/api/odds/board?event_id=${outside.id}`), env(kv), {});
    assert.equal(r2.status, 404); assert.equal((await r2.json()).semantics, 'UNAVAILABLE');
    assert.equal(p.calls.length, 0);
  } finally { globalThis.fetch = real; }
});

test('a failed scheduled ingest keeps the last verified batch and flags LATEST_INGEST_UNAVAILABLE', async () => {
  const { kv } = await seeded();
  const before = await kv.get('odds:v1:meta', 'json');
  const p = providerStub({ fail: true }); const real = globalThis.fetch; globalThis.fetch = p.fetch;
  try {
    const r = await ingest(env(kv), { trigger: 'cron', now: new Date(NOW.getTime() + 5 * 3600000) });
    assert.equal(r.status, 'failed'); assert.equal(r.provider_error_class, 'QUOTA');
    assert.equal(p.calls.length, 1, 'a failed featured request stops the ingest before any board request');
    const after = await kv.get('odds:v1:meta', 'json');
    assert.equal(after.batch_id, before.batch_id, 'previous verified batch untouched');
    const j = await (await worker.fetch(req('/api/odds'), env(kv), {})).json();
    assert.equal(j.semantics, 'LAST_VERIFIED_MARKET'); assert.equal(j.ingest.status, 'LATEST_INGEST_UNAVAILABLE'); assert.equal(j.ingest.last_error_class, 'QUOTA');
    assert.equal(j.captured_at, before.captured_at);
    /* the Vercel handler passes the failure through as stale */
    globalThis.fetch = async (url) => { const u = String(url); if (/\/api\/odds/.test(u)) return worker.fetch(req(new URL(u).pathname + new URL(u).search), env(kv), {}); throw new Error('unexpected ' + u); };
    const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(x) { this.body = JSON.parse(x); } };
    await homeMarket({ method: 'GET', query: { away: 'New England Patriots', home: 'Seattle Seahawks' }, headers: {} }, res);
    assert.equal(res.statusCode, 200); assert.equal(res.body.semantics, 'LAST_VERIFIED_MARKET'); assert.equal(res.body.stale, true); assert.equal(res.body.ingest.status, 'LATEST_INGEST_UNAVAILABLE');
  } finally { globalThis.fetch = real; }
});

test('empty store answers 503 and makes no provider request', async () => {
  const kv = memoryKV(); const p = providerStub(); const real = globalThis.fetch; globalThis.fetch = p.fetch;
  try {
    const r = await worker.fetch(req('/api/odds'), env(kv), {});
    assert.equal(r.status, 503); assert.equal((await r.json()).semantics, 'UNAVAILABLE'); assert.equal(p.calls.length, 0);
  } finally { globalThis.fetch = real; }
});

test('manual ingest requires the admin token and reports usage without secrets', async () => {
  const kv = memoryKV(); const p = providerStub(); const real = globalThis.fetch; globalThis.fetch = p.fetch;
  try {
    assert.equal((await worker.fetch(req('/api/odds/ingest', { method: 'POST' }), env(kv), {})).status, 401);
    assert.equal((await worker.fetch(req('/api/odds/ingest', { method: 'POST', headers: { authorization: 'Bearer wrong' } }), env(kv), {})).status, 401);
    assert.equal((await worker.fetch(req('/api/odds/ingest'), env(kv), {})).status, 405);
    assert.equal(p.calls.length, 0, 'rejected calls never reach the provider');
    const r = await worker.fetch(req('/api/odds/ingest', { method: 'POST', headers: { authorization: 'Bearer admin-test-token' } }), env(kv), {});
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.status, 'ok'); assert.ok(j.usage.used); assert.ok(j.batch_id.endsWith('-manual'));
    assert.ok(!JSON.stringify(j).includes('test-key-not-real') && !JSON.stringify(j).includes('admin-test-token'), 'no secret in the response');
  } finally { globalThis.fetch = real; }
});

test('the cron only ingests at 08 / 13 / 18 New York time, in EDT and in EST', async () => {
  assert.equal(etHour(new Date('2026-09-07T12:00:00Z')), 8);   // EDT: 12Z = 08:00 ET
  assert.equal(etHour(new Date('2026-09-07T13:00:00Z')), 9);
  assert.equal(etHour(new Date('2026-12-07T13:00:00Z')), 8);   // EST: 13Z = 08:00 ET
  assert.equal(etHour(new Date('2026-12-07T12:00:00Z')), 7);
  assert.equal(etHour(new Date('2026-09-07T22:00:00Z')), 18);
  assert.equal(etHour(new Date('2026-12-07T23:00:00Z')), 18);
  const kv = memoryKV(); const p = providerStub(); const real = globalThis.fetch; globalThis.fetch = p.fetch;
  const waits = []; const ctx = { waitUntil: (pr) => waits.push(pr) };
  try {
    await worker.scheduled({ cron: '0 12,13,17,18,22,23 * * *', scheduledTime: Date.parse('2026-09-07T13:00:00Z') }, env(kv), ctx);   // 09:00 EDT -> skip
    assert.equal(waits.length, 0); assert.equal(p.calls.length, 0);
    await worker.scheduled({ cron: '0 12,13,17,18,22,23 * * *', scheduledTime: Date.parse('2026-09-07T12:00:00Z') }, env(kv), ctx);   // 08:00 EDT -> ingest
    await Promise.all(waits);
    assert.ok(p.calls.length >= 1);
  } finally { globalThis.fetch = real; }
});
