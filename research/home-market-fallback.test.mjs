/* End-to-end contract of /api/home-market during a provider outage, with
   every network call stubbed: the gateway answers the classified 502 the
   live system produces today, the schedule names the game, the snapshot
   store returns one stored batch. The handler must answer 200 under
   LAST_VERIFIED_SNAPSHOT semantics, and 503 when there is nothing verified
   to stand in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/home-market.js';

const GATEWAY_502 = { error: 'Odds provider request failed', provider: 'the_odds_api', provider_status: 401, provider_error_code: 'OUT_OF_USAGE_CREDITS', provider_error_class: 'QUOTA', semantics: 'UNAVAILABLE' };
const now = new Date();
const kickoff = new Date(now.getTime() + 2 * 86400000);
const gameday = kickoff.toISOString().slice(0, 10);
const SCHEDULE = { games: [{ game_id: `2026_01_NE_SEA`, season: 2026, game_type: 'REG', week: 1, gameday, gametime: '20:20', away_team: 'NE', home_team: 'SEA' }] };
const captured = new Date(now.getTime() - 5 * 3600000).toISOString();
const row = (o) => ({ book: 'consensus:6', captured_at: captured, is_closing: false, ...o });
const ROWS = [
  row({ market: 'spread', side: 'NE', team: 'NE', is_home: false, line: 3, price: -110 }),
  row({ market: 'spread', side: 'SEA', team: 'SEA', is_home: true, line: -3, price: -110 }),
  row({ market: 'total', side: 'over', over_under: 'over', line: 44, price: -110 }),
  row({ market: 'total', side: 'under', over_under: 'under', line: 44, price: -110 }),
  row({ market: 'moneyline', side: 'NE', team: 'NE', is_home: false, price: 140 }),
  row({ market: 'moneyline', side: 'SEA', team: 'SEA', is_home: true, price: -165 }),
];

function fakeFetch({ rows = ROWS, storeStatus = 200 } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      const u = String(url); calls.push(u);
      const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (u.includes('/api/odds/board')) return reply(502, GATEWAY_502);
      if (u.includes('/api/odds')) return reply(502, GATEWAY_502);
      if (u.includes('/api/schedule')) return reply(200, SCHEDULE);
      if (u.includes('/rest/v1/nfl_odds_snapshots')) return reply(storeStatus, storeStatus === 200 ? rows : { message: 'nope' });
      throw new Error(`unexpected fetch ${u}`);
    },
  };
}
function fakeRes() {
  /* the shape api/home-market.js actually uses: statusCode, setHeader, end(json) */
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = JSON.parse(b); return r; };
  return r;
}
async function run(opts) {
  const real = globalThis.fetch;
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const f = fakeFetch(opts);
  globalThis.fetch = f.fetch;
  try {
    const res = fakeRes();
    await handler({ method: 'GET', query: { away: 'New England Patriots', home: 'Seattle Seahawks' }, headers: {} }, res);
    return { res, calls: f.calls };
  } finally { globalThis.fetch = real; }
}

const storeConfigured = Boolean(String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());

test('gateway 502 → 200 LAST_VERIFIED_SNAPSHOT from the stored batch', { skip: !storeConfigured && 'SUPABASE_SERVICE_ROLE_KEY not set in this shell; the handler correctly refuses to query the store' }, async () => {
  const { res, calls } = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-pbe-market-semantics'], 'LAST_VERIFIED_SNAPSHOT');
  assert.equal(res.body.semantics, 'LAST_VERIFIED_SNAPSHOT');
  assert.equal(res.body.stale, true);
  assert.equal(res.body.live_feed.status, 'UNAVAILABLE');
  assert.match(res.body.live_feed.error, /OUT_OF_USAGE_CREDITS|gateway_502/);
  assert.equal(res.body.captured_at, captured);
  assert.equal(res.body.event.id, '2026_01_NE_SEA');
  assert.deepEqual(res.body.spread, { away: 3, home: -3 });
  assert.equal(res.body.total.line, 44);
  assert.deepEqual(res.body.moneyline, { away: 140, home: -165 });
  assert.ok(calls.some((u) => u.includes('game_id=eq.2026_01_NE_SEA')), 'store is queried by the exact schedule game_id');
});

test('gateway 502 and an empty store → honest 503, no invented market', { skip: !storeConfigured && 'store not configured in this shell' }, async () => {
  const { res } = await run({ rows: [] });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'core_market_unavailable');
  assert.equal(res.body.fallback, 'no_verified_snapshot');
});

test('gateway 502 and a snapshot older than 72h → 503 (too old to stand in)', { skip: !storeConfigured && 'store not configured in this shell' }, async () => {
  const old = new Date(now.getTime() - 80 * 3600000).toISOString();
  const { res } = await run({ rows: ROWS.map((r) => ({ ...r, captured_at: old })) });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.fallback, 'no_verified_snapshot');
});

test('gateway 502 without store credentials → 503 naming the missing store, never a fabricated market', { skip: storeConfigured && 'store IS configured in this shell' }, async () => {
  const { res, calls } = await run();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'core_market_unavailable');
  assert.equal(res.body.fallback, 'snapshot_store_not_configured');
  assert.ok(!calls.some((u) => u.includes('/rest/v1/')), 'the store is never contacted without credentials');
});
