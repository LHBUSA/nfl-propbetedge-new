/* P0 — Best Line player props across kickoff.
 *
 * Production failure (2026-09-13): at the 1:00 PM kickoff Best Line -> Player
 * Props dropped every started game (best-line-v1.js filtered `!e.started`),
 * jumped to a Sep 20 game and reported NOT_OFFERED_AT_INGEST. Underneath it,
 * nfl-odds overwrote one event record per scheduled run, so a later run that
 * found no player markets (a book pulls them at kickoff, or a finished game)
 * destroyed the last good pre-game board.
 *
 * These tests drive the real worker in-process: in-memory KV, a stubbed
 * provider that counts every request, and a controlled clock. No real
 * provider call is made.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import worker, { ingest, resolveBoard, mergeVerified, legacyPregameCapture, AVAILABILITY } from '../workers/nfl-odds/src/index.js';

const EARLY = { id: 'evt-early-chi-car', commence_time: '2026-09-13T17:05:00Z', away_team: 'Chicago Bears', home_team: 'Carolina Panthers' };
const LATE = { id: 'evt-late-gb-min', commence_time: '2026-09-13T20:25:00Z', away_team: 'Green Bay Packers', home_team: 'Minnesota Vikings' };
const FUTURE = { id: 'evt-future-cin-hou', commence_time: '2026-09-20T17:00:00Z', away_team: 'Cincinnati Bengals', home_team: 'Houston Texans' };
const SLATE = [EARLY, LATE, FUTURE];

const T08 = new Date('2026-09-13T12:00:10Z');   // 08:00 ET ingest
const T13 = new Date('2026-09-13T17:00:40Z');   // 13:00 ET ingest, 4m20s before the 1:05 kickoff
const T18 = new Date('2026-09-13T22:00:30Z');   // 18:00 ET ingest, both Sunday afternoon games under way / over

const MARKETS = {
  player_pass_yds: [['Caleb Williams', 'Over', 224.5, -115], ['Caleb Williams', 'Under', 224.5, -105]],
  player_rush_yds: [['DJ Moore', 'Over', 9.5, -110], ['DJ Moore', 'Under', 9.5, -110]],
  player_reception_yds: [['DJ Moore', 'Over', 58.5, -112], ['DJ Moore', 'Under', 58.5, -108]],
  player_receptions: [['DJ Moore', 'Over', 4.5, -130], ['DJ Moore', 'Under', 4.5, 100]],
  player_anytime_td: [['DJ Moore', 'Yes', null, 165]],
};
const CORE = Object.keys(MARKETS);

/* provider body for one event: `offer` lists the markets books are posting */
function providerEvent(ev, offer, stamp) {
  const book = (key, title, shift) => ({
    key, title, last_update: stamp,
    markets: offer.map((m) => ({ key: m, last_update: stamp, outcomes: MARKETS[m].map(([player, name, point, price]) => ({ name, description: player, point, price: price + shift })) })),
  });
  return { ...ev, sport_key: 'americanfootball_nfl', bookmakers: offer.length ? [book('draftkings', 'DraftKings', 0), book('fanduel', 'FanDuel', -5)] : [] };
}

function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(key, opts) { const v = store.get(key); if (v === undefined) return null; return (opts === 'json' || opts?.type === 'json') ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, String(value)); },
  };
}

/* offers: { [eventId]: [markets] } for this run; stamp = provider last_update */
function provider(offers, stamp) {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      const u = String(url);
      if (!u.startsWith('https://api.the-odds-api.com/')) throw new Error(`unexpected non-provider fetch ${u}`);
      calls.push(u.replace(/apiKey=[^&]+/, 'apiKey=REDACTED'));
      const ok = (body, cost) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': String(cost), 'x-requests-used': '1', 'x-requests-remaining': '99999' } });
      const m = /\/events\/([^/]+)\/odds\?/.exec(u);
      if (m) { const ev = SLATE.find((e) => e.id === decodeURIComponent(m[1])); return ok(providerEvent(ev, offers[ev.id] || [], stamp), 18); }
      if (/\/sports\/americanfootball_nfl\/odds\?/.test(u)) return ok(SLATE.map((e) => ({ ...e, sport_key: 'americanfootball_nfl', bookmakers: [] })), 3);
      return new Response('{}', { status: 404 });
    },
  };
}

const env = (kv) => ({ NFL_KV: kv, ODDS_API_KEY: 'test-key-not-real', ODDS_ADMIN_TOKEN: 'admin-test-token', INGEST_PROP_WINDOW_DAYS: '8' });

async function run(kv, now, offers, stamp = now.toISOString()) {
  const p = provider(offers, stamp);
  const real = globalThis.fetch; globalThis.fetch = p.fetch;
  try { const result = await ingest(env(kv), { trigger: 'cron', now }); return { result, calls: p.calls }; }
  finally { globalThis.fetch = real; }
}

async function read(kv, at, path) {
  mock.timers.enable({ apis: ['Date'], now: at.getTime() });
  const p = provider({}, at.toISOString()); const real = globalThis.fetch; globalThis.fetch = p.fetch;
  try {
    const r = await worker.fetch(new Request(`https://nfl-odds.internal${path}`), env(kv), {});
    return { status: r.status, body: await r.json(), providerCalls: p.calls.length };
  } finally { globalThis.fetch = real; mock.timers.reset(); }
}
const board = (kv, at, ev, markets) => read(kv, at, `/api/odds/board?event_id=${ev.id}&markets=${markets.join(',')}`);

/* The Sunday: 08:00 and 13:00 capture both afternoon games; at 13:00 books have
   pulled receiving yards for the late game; nothing is posted for next week. */
async function sunday() {
  const kv = memoryKV();
  const r08 = await run(kv, T08, { [EARLY.id]: CORE, [LATE.id]: CORE });
  const r13 = await run(kv, T13, { [EARLY.id]: CORE, [LATE.id]: CORE.filter((m) => m !== 'player_reception_yds') });
  return { kv, r08, r13 };
}

test('game before kickoff: every core market is IN_SNAPSHOT with its own capture time and batch', async () => {
  const { kv, r13 } = await sunday();
  const { status, body, providerCalls } = await board(kv, new Date('2026-09-13T17:03:00Z'), EARLY, CORE);
  assert.equal(status, 200);
  assert.equal(providerCalls, 0, 'a read never reaches the provider');
  assert.equal(body.event.started, false);
  assert.equal(body.event.state, 'PRE_GAME');
  assert.equal(body.price_semantics, 'SCHEDULED_SNAPSHOT_NOT_LIVE');
  for (const m of CORE) {
    assert.equal(body.market_availability[m], AVAILABILITY.current, m);
    const prov = body.market_provenance[m];
    assert.equal(prov.batch_id, r13.result.batch_id, `${m} comes from the 13:00 batch`);
    assert.ok(Date.parse(prov.captured_at) >= T13.getTime() && Date.parse(prov.captured_at) < Date.parse(EARLY.commence_time), `${m} captured at 13:00, before kickoff`);
    assert.ok(body.quotes.filter((q) => q.market === m).every((q) => q.captured_at === prov.captured_at && q.snapshot_semantics === AVAILABILITY.current), `${m} quotes carry the capture time`);
  }
});

test('game immediately after kickoff: the pre-game board is still served, labelled KICKED OFF, never current', async () => {
  const { kv, r13 } = await sunday();
  const { status, body } = await board(kv, new Date('2026-09-13T17:06:00Z'), EARLY, CORE);
  assert.equal(status, 200);
  assert.equal(body.event.started, true);
  assert.equal(body.event.state, 'KICKED_OFF');
  assert.equal(body.price_semantics, 'KICKED_OFF_PREGAME_SNAPSHOT_NOT_LIVE');
  for (const m of CORE) {
    assert.equal(body.market_availability[m], AVAILABILITY.verified, `${m} is a retained pre-game snapshot after kickoff`);
    assert.equal(body.market_provenance[m].batch_id, r13.result.batch_id);
    assert.ok(body.quotes.some((q) => q.market === m), `${m} still has quotes`);
  }
  assert.ok(!Object.values(body.market_availability).includes(AVAILABILITY.current), 'nothing after kickoff is called current');
});

test('a later ingest never requests a started game and never erases its verified board or restamps it', async () => {
  const { kv, r13 } = await sunday();
  const r18 = await run(kv, T18, { [EARLY.id]: [], [LATE.id]: [] });
  assert.equal(r18.result.status, 'ok');
  assert.equal(r18.calls.filter((u) => u.includes(`/events/${EARLY.id}/`) || u.includes(`/events/${LATE.id}/`)).length, 0, 'started games are not re-requested');
  for (const ev of [EARLY, LATE]) {
    const { body } = await board(kv, new Date('2026-09-13T22:05:00Z'), ev, ['player_pass_yds', 'player_rush_yds', 'player_receptions', 'player_anytime_td']);
    for (const m of ['player_pass_yds', 'player_rush_yds', 'player_receptions', 'player_anytime_td']) {
      assert.equal(body.market_availability[m], AVAILABILITY.verified, `${ev.id} ${m}`);
      assert.equal(body.market_provenance[m].batch_id, r13.result.batch_id, `${ev.id} ${m} keeps the 13:00 batch id`);
      assert.notEqual(body.market_provenance[m].batch_id, r18.result.batch_id, 'never stamped with the newest batch');
      assert.ok(Date.parse(body.market_provenance[m].captured_at) < Date.parse(ev.commence_time), 'captured before kickoff');
    }
    assert.ok(Date.parse(body.captured_at) < T18.getTime(), 'board-level time is the retained capture, not 18:00');
    assert.equal(body.snapshot_batch_id, r18.result.batch_id, 'the newest batch is reported separately');
  }
});

test('previous verified props are retained when a newer PRE-GAME ingest omits the market', async () => {
  const { kv, r08, r13 } = await sunday();
  const { body } = await board(kv, new Date('2026-09-13T18:00:00Z'), LATE, ['player_reception_yds', 'player_pass_yds']);
  assert.equal(body.event.started, false);
  assert.equal(body.market_availability.player_reception_yds, AVAILABILITY.verified, 'pulled at 13:00, retained from 08:00');
  assert.equal(body.market_provenance.player_reception_yds.batch_id, r08.result.batch_id);
  assert.ok(Date.parse(body.market_provenance.player_reception_yds.captured_at) < T13.getTime(), '08:00 capture time, not 13:00');
  assert.equal(body.market_availability.player_pass_yds, AVAILABILITY.current);
  assert.equal(body.market_provenance.player_pass_yds.batch_id, r13.result.batch_id);
  assert.equal(body.captured_at, body.market_provenance.player_reception_yds.captured_at, 'one-timestamp consumers see the OLDEST served capture');
  const rec = body.quotes.filter((q) => q.market === 'player_reception_yds');
  assert.ok(rec.length && rec.every((q) => q.batch_id === r08.result.batch_id));
});

test('future game with no props posted yet stays NOT_OFFERED_AT_INGEST with zero fabricated quotes', async () => {
  const { kv } = await sunday();
  const { status, body } = await board(kv, new Date('2026-09-13T18:00:00Z'), FUTURE, CORE);
  assert.equal(status, 200);
  assert.equal(body.quote_count, 0);
  assert.deepEqual(body.quotes, []);
  for (const m of CORE) {
    assert.equal(body.market_availability[m], AVAILABILITY.never, m);
    assert.equal(body.market_provenance[m].captured_at, null, 'no capture time for a market that was never captured');
  }
  const notRequested = await board(kv, new Date('2026-09-13T18:00:00Z'), FUTURE, ['player_sacks']);
  assert.equal(notRequested.body.market_availability.player_sacks, AVAILABILITY.never, 'player_sacks is on the default ingest list');
});

test('receiving yards, passing yards, rushing yards, receptions and anytime TD each survive kickoff with real prices', async () => {
  const { kv } = await sunday();
  await run(kv, T18, {});
  const after = new Date('2026-09-13T21:00:00Z');
  const expect = { player_reception_yds: 58.5, player_pass_yds: 224.5, player_rush_yds: 9.5, player_receptions: 4.5 };
  for (const [m, point] of Object.entries(expect)) {
    const { body } = await board(kv, after, EARLY, [m]);
    assert.equal(body.market_availability[m], AVAILABILITY.verified, m);
    const over = body.quotes.find((q) => q.market === m && q.direction === 'OVER' && q.book === 'DraftKings');
    assert.equal(over.point, point, `${m} line is the captured one`);
    assert.ok(Number.isFinite(over.price));
  }
  const { body } = await board(kv, after, EARLY, ['player_anytime_td']);
  assert.equal(body.market_availability.player_anytime_td, AVAILABILITY.verified);
  const yes = body.quotes.filter((q) => q.direction === 'YES');
  assert.deepEqual(yes.map((q) => [q.book, q.price]).sort(), [['DraftKings', 165], ['FanDuel', 160]]);
});

test('a player-market response that arrives after kickoff is written nowhere', () => {
  const previous = { event: EARLY, markets: { player_pass_yds: { market: 'player_pass_yds', quotes: [{ player: 'x' }], captured_at: '2026-09-13T17:00:41Z', batch_id: 'b13' } } };
  const live = providerEvent(EARLY, ['player_pass_yds'], '2026-09-13T17:20:00Z');
  assert.equal(mergeVerified(previous, { event: live, event_ref: EARLY, markets_requested: CORE, captured_at: '2026-09-13T17:20:01Z', batch_id: 'b-late', pregame: false }), previous);
  assert.equal(mergeVerified(null, { event: live, event_ref: EARLY, markets_requested: CORE, captured_at: '2026-09-13T17:20:01Z', batch_id: 'b-late', pregame: false }), null);
});

test('an empty pre-game capture keeps every verified market entry', () => {
  const first = mergeVerified(null, { event: providerEvent(LATE, CORE, '2026-09-13T12:00:00Z'), event_ref: LATE, markets_requested: CORE, captured_at: '2026-09-13T12:00:11Z', batch_id: 'b08', pregame: true });
  const second = mergeVerified(first, { event: providerEvent(LATE, [], '2026-09-13T17:00:00Z'), event_ref: LATE, markets_requested: CORE, captured_at: '2026-09-13T17:00:41Z', batch_id: 'b13', pregame: true });
  assert.deepEqual(Object.keys(second.markets).sort(), [...CORE].sort());
  for (const m of CORE) { assert.equal(second.markets[m].batch_id, 'b08'); assert.equal(second.markets[m].captured_at, '2026-09-13T12:00:11Z'); }
});

test('first v3.1 run promotes a pre-v3.1 record only when it is provably pre-game', () => {
  const stored = { event: providerEvent(EARLY, CORE, '2026-09-13T17:01:10Z'), markets_requested: CORE, markets_captured: CORE, provider_last_update: '2026-09-13T17:01:10Z' };
  const prevMeta = { batch_id: '20260913T170057Z-cron', captured_at: '2026-09-13T17:01:26.754Z' };
  const promoted = legacyPregameCapture(stored, prevMeta, { id: EARLY.id });
  assert.ok(promoted);
  assert.equal(promoted.captured_at, prevMeta.captured_at, 'stamped with the batch that wrote it');
  assert.equal(promoted.batch_id, prevMeta.batch_id);
  assert.equal(legacyPregameCapture(stored, prevMeta, null), null, 'not in the previous index: unknown batch, not promoted');
  assert.equal(legacyPregameCapture({ ...stored, provider_last_update: '2026-09-13T17:10:00Z' }, prevMeta, { id: EARLY.id }), null, 'a book update after kickoff: in-play, not promoted');
  assert.equal(legacyPregameCapture(stored, { ...prevMeta, captured_at: '2026-09-13T17:06:00Z' }, { id: EARLY.id }), null, 'batch finished after kickoff: not promoted');
  assert.equal(legacyPregameCapture({ ...stored, captured_at: '2026-09-13T17:00:59Z' }, prevMeta, { id: EARLY.id }), null, 'a v3.1 record is never treated as legacy');
});

test('a pre-v3.1 store keeps the 1:05 games through the first v3.1 ingest after kickoff', async () => {
  /* the production shape at 2026-09-13T17:01Z: v3.0 records, no captured_at */
  const kv = memoryKV();
  const stamp = '2026-09-13T17:01:10Z';
  const record = (ev) => ({ event: providerEvent(ev, CORE, stamp), markets_requested: CORE, markets_captured: CORE, quote_count: 10, provider_last_update: stamp });
  kv.store.set(`odds:v1:event:${EARLY.id}`, JSON.stringify(record(EARLY)));
  kv.store.set('odds:v1:board-index', JSON.stringify([{ id: EARLY.id, commence_time: EARLY.commence_time, away_team: EARLY.away_team, home_team: EARLY.home_team, markets_captured: CORE, quote_count: 10 }]));
  kv.store.set('odds:v1:meta', JSON.stringify({ batch_id: '20260913T170057Z-cron', captured_at: '2026-09-13T17:01:26.754Z', attempt_started_at: '2026-09-13T17:00:57.000Z' }));
  kv.store.set('odds:v1:featured:regular', JSON.stringify({ events: [] }));

  const before = await board(kv, new Date('2026-09-13T18:30:00Z'), EARLY, ['player_reception_yds']);
  assert.equal(before.body.market_availability.player_reception_yds, AVAILABILITY.verified, 'served as pre-game straight after the worker deploy');
  assert.equal(before.body.market_provenance.player_reception_yds.batch_id, '20260913T170057Z-cron');

  const r18 = await run(kv, T18, {});
  const after = await board(kv, new Date('2026-09-13T22:10:00Z'), EARLY, ['player_reception_yds']);
  assert.equal(after.body.market_availability.player_reception_yds, AVAILABILITY.verified, 'still served after the 18:00 ingest');
  assert.equal(after.body.market_provenance.player_reception_yds.batch_id, '20260913T170057Z-cron');
  assert.equal(after.body.market_provenance.player_reception_yds.captured_at, '2026-09-13T17:01:26.754Z');
  assert.notEqual(after.body.market_provenance.player_reception_yds.batch_id, r18.result.batch_id);
});

test('prop coverage lists started games with verified props and future games without, from one KV read', async () => {
  const { kv } = await sunday();
  await run(kv, T18, {});
  const { status, body, providerCalls } = await read(kv, new Date('2026-09-13T22:10:00Z'), '/api/odds/prop-coverage');
  assert.equal(status, 200);
  assert.equal(providerCalls, 0);
  const byId = Object.fromEntries(body.events.map((e) => [e.id, e]));
  assert.equal(byId[EARLY.id].started, true);
  assert.equal(byId[EARLY.id].has_player_props, true);
  assert.deepEqual(byId[EARLY.id].verified_markets, [...CORE].sort());
  assert.ok(byId[LATE.id].verified_markets.includes('player_reception_yds'), 'the 08:00 receiving-yards entry is still listed');
  assert.equal(byId[FUTURE.id].has_player_props, false);
  assert.deepEqual(byId[FUTURE.id].current_markets, []);
});

test('resolveBoard never calls a started game current, even from a v3.1 current record', () => {
  const stored = { event: providerEvent(EARLY, ['player_pass_yds'], '2026-09-13T17:00:30Z'), markets_requested: CORE, captured_at: '2026-09-13T17:00:41Z', batch_id: 'b13', captured_pregame: true };
  const verified = mergeVerified(null, { event: stored.event, event_ref: EARLY, markets_requested: CORE, captured_at: stored.captured_at, batch_id: 'b13', pregame: true });
  const pre = resolveBoard({ stored, verified, markets: ['player_pass_yds'], nowMs: Date.parse('2026-09-13T17:04:59Z') });
  const post = resolveBoard({ stored, verified, markets: ['player_pass_yds'], nowMs: Date.parse('2026-09-13T17:05:00Z') });
  assert.equal(pre.market_availability.player_pass_yds, AVAILABILITY.current);
  assert.equal(post.market_availability.player_pass_yds, AVAILABILITY.verified, 'kickoff instant flips it');
  assert.equal(post.market_provenance.player_pass_yds.captured_at, '2026-09-13T17:00:41Z');
});
