/* PROP BOARD BATCH MERGE GATE
 *
 * The rule under test: NO REQUESTED MARKET BATCH MAY SILENTLY DISAPPEAR.
 *
 * Prop Board asks for 10 player markets in two batches of 5 — batch 1 is the
 * five passing markets, batch 2 is receiving/rushing/TD. On the Sep 7 2026
 * production slate that split is stark: batch 1 carries exactly 2 players (the
 * two quarterbacks), batch 2 carries 35. mergeBoards seeded its result from
 * `{...parts[0]}`, so rows merged correctly but metadata — market_availability
 * above all — described the first batch alone. Feed Health could therefore
 * report the passing markets as if they were the whole board.
 *
 * This drives the SHIPPED mergeBoards out of prop-board-v3.js inside a vm with
 * a minimal DOM, so the assertions bind to the real function rather than a
 * copy that can drift away from it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../prop-board-v3.js', import.meta.url), 'utf8');

/* prop-board-v3.js is a browser IIFE: it installs on load and listens for DOM
   events. Give it just enough surface to reach its own bottom line, where it
   publishes window.PBEPropBoardV3. */
function loadBoardModule() {
  const noop = () => {};
  const element = () => ({
    textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, appendChild: noop, remove: noop,
    querySelector: () => null, querySelectorAll: () => [], setAttribute: noop, getAttribute: () => null,
    closest: () => null, focus: noop, before: noop, append: noop, insertAdjacentHTML: noop,
  });
  const documentStub = {
    readyState: 'complete', head: element(), body: element(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => element(), addEventListener: noop, removeEventListener: noop,
  };
  const windowStub = {
    location: { search: '', href: 'https://nfl.propbetedge.ai/' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => { throw new Error('no network in this test'); },
  };
  const context = vm.createContext({ ...windowStub, window: windowStub, document: documentStub,
    console, URLSearchParams, Set, Map, JSON, Math, Date, Number, String, Array, Object, isNaN, parseFloat, parseInt });
  context.globalThis = context;
  vm.runInContext(SOURCE, context, { filename: 'prop-board-v3.js' });
  const api = context.window.PBEPropBoardV3;
  assert.ok(api && typeof api.mergeBoards === 'function', 'prop-board-v3.js must publish mergeBoards');
  return api;
}

const SNAPSHOT = {
  captured_at: '2026-09-07T17:00:33.691Z', captured_at_et: 'Sep 7, 1:00 PM ET',
  batch_id: '20260907T170009Z-cron', semantics: 'LAST_VERIFIED_MARKET',
  source: { provider: 'the_odds_api', semantics: 'MARKET_SNAPSHOT', read_path: 'kv-snapshot' },
};
const EVENT = { id: '8c94552d022acec4a0458d70c19d3da9', away_team: 'New England Patriots', home_team: 'Seattle Seahawks', commence_time: '2026-09-10T00:20:00Z' };

const PASSING = ['player_pass_yds', 'player_pass_completions', 'player_pass_attempts', 'player_pass_tds', 'player_pass_interceptions'];
const SKILL = ['player_reception_yds', 'player_receptions', 'player_rush_yds', 'player_rush_attempts', 'player_anytime_td'];

const quote = (player, market, book, direction, point, price) => ({
  event_id: EVENT.id, away_team: EVENT.away_team, home_team: EVENT.home_team,
  player, market, direction, point, price, book_key: book.toLowerCase(), book,
  last_update: '2026-09-07T16:59:51Z',
});

/* batch 1: five passing markets, exactly two players — the shape that made a
   correct board look like a two-player product. */
function batchOne() {
  const players = ['Drake Maye', 'Sam Darnold'];
  const quotes = [];
  for (const market of PASSING) for (const player of players) for (const book of ['DraftKings', 'FanDuel']) {
    quotes.push(quote(player, market, book, 'OVER', 250.5, -110));
    quotes.push(quote(player, market, book, 'UNDER', 250.5, -110));
  }
  return { event: EVENT, ...SNAPSHOT, markets: [...PASSING],
    market_availability: Object.fromEntries(PASSING.map((m) => [m, 'IN_SNAPSHOT'])),
    quotes, market_summary: players.flatMap((p) => PASSING.map((m) => ({ player: p, market: m, consensus_line: 250.5 }))),
    quote_count: quotes.length, provider_last_update: '2026-09-07T16:59:51Z' };
}

/* batch 2: receiving/rushing/TD, 35 players, and one market the provider never
   posted — the status that must survive aggregation. */
function batchTwo() {
  const players = Array.from({ length: 35 }, (_, i) => `Skill Player ${i + 1}`);
  const offered = SKILL.filter((m) => m !== 'player_rush_attempts');
  const quotes = [];
  for (const market of offered) for (const player of players) {
    quotes.push(quote(player, market, 'DraftKings', 'OVER', 40.5, -115));
  }
  const availability = Object.fromEntries(SKILL.map((m) => [m, m === 'player_rush_attempts' ? 'NOT_OFFERED_AT_INGEST' : 'IN_SNAPSHOT']));
  return { event: EVENT, ...SNAPSHOT, markets: [...SKILL], market_availability: availability,
    quotes, market_summary: [], quote_count: quotes.length, provider_last_update: '2026-09-07T16:58:00Z' };
}

const uniquePlayers = (board) => new Set(board.quotes.map((q) => q.player)).size;
const uniquePairs = (board) => new Set(board.quotes.map((q) => `${q.player}|${q.market}`)).size;

test('merged board is the union of both batches, not the first one', () => {
  const { mergeBoards } = loadBoardModule();
  const one = batchOne(); const two = batchTwo();
  const merged = mergeBoards([one, two]);

  assert.equal(uniquePlayers(merged), 37, 'union is 2 passing + 35 skill players');
  assert.equal(merged.quotes.length, one.quotes.length + two.quotes.length, 'every quote survives the merge');
  assert.equal(uniquePairs(merged), uniquePairs(one) + uniquePairs(two), 'player/market rows are the union');
  assert.equal(merged.quote_count, merged.quotes.length);

  assert.equal(merged.markets.length, 10, 'all 10 requested markets are named');
  for (const market of [...PASSING, ...SKILL]) assert.ok(merged.markets.includes(market), `${market} missing from merged markets`);

  const availability = merged.market_availability;
  assert.equal(Object.keys(availability).length, 10, 'availability covers all 10 markets, not just batch 1');
  for (const market of PASSING) assert.equal(availability[market], 'IN_SNAPSHOT', market);
  for (const market of SKILL.filter((m) => m !== 'player_rush_attempts')) assert.equal(availability[market], 'IN_SNAPSHOT', market);
});

test('a market the provider never posted keeps that status through aggregation', () => {
  const { mergeBoards } = loadBoardModule();
  const merged = mergeBoards([batchOne(), batchTwo()]);
  assert.equal(merged.market_availability.player_rush_attempts, 'NOT_OFFERED_AT_INGEST');
  assert.deepEqual(merged.markets_not_in_snapshot, ['player_rush_attempts'],
    'the honest not-offered market is reported, and nothing else is invented');
});

test('batch order cannot change the merged truth', () => {
  const { mergeBoards } = loadBoardModule();
  const forward = mergeBoards([batchOne(), batchTwo()]);
  const reverse = mergeBoards([batchTwo(), batchOne()]);
  assert.equal(uniquePlayers(reverse), uniquePlayers(forward));
  assert.equal(reverse.quotes.length, forward.quotes.length);
  assert.deepEqual(
    Object.fromEntries(Object.entries(reverse.market_availability).sort()),
    Object.fromEntries(Object.entries(forward.market_availability).sort()),
    'availability must not depend on which batch answered first');
  assert.equal(reverse.markets.length, 10);
});

test('a thin per-market retry cannot downgrade a market already in the snapshot', () => {
  const { mergeBoards } = loadBoardModule();
  /* loadMarketBatch falls back to one request per market when a batch fails;
     such a response describes one market and must not overwrite the rest. */
  const thin = { event: EVENT, markets: ['player_pass_yds'],
    market_availability: { player_pass_yds: 'NOT_REQUESTED_BY_INGEST' }, quotes: [], market_summary: [] };
  const merged = mergeBoards([batchOne(), batchTwo(), thin]);
  assert.equal(merged.market_availability.player_pass_yds, 'IN_SNAPSHOT',
    'the strongest truthful claim wins; a thin retry cannot un-ship a market');
  assert.equal(Object.keys(merged.market_availability).length, 10);
});

test('a batch with no snapshot metadata still yields a board that can state its freshness', () => {
  const { mergeBoards } = loadBoardModule();
  const bare = { event: EVENT, markets: [...PASSING], market_availability: {}, quotes: [], market_summary: [] };
  const merged = mergeBoards([bare, batchTwo()]);
  assert.equal(merged.captured_at_et, 'Sep 7, 1:00 PM ET');
  assert.equal(merged.batch_id, '20260907T170009Z-cron');
  assert.equal(merged.source.provider, 'the_odds_api');
});

test('provider_last_update is the freshest across batches', () => {
  const { mergeBoards } = loadBoardModule();
  const merged = mergeBoards([batchOne(), batchTwo()]);
  assert.equal(merged.provider_last_update, '2026-09-07T16:59:51Z');
});
