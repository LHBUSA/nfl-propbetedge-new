/* QB DNA — current-season, no-history and current-market tests.
 * node --test research/qbdna/qbdna-current.test.mjs
 *
 * These cover the second half of the contract: that the product can never
 * present a stale season as current form, that a quarterback with no NFL
 * history fails closed instead of showing zeros, and that a threshold is never
 * calculated against a line nobody is offering.
 *
 * Network-dependent assertions (the live market) are marked and skip cleanly
 * when the market source is unreachable, so a gateway outage is never reported
 * as a code failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from './call.mjs';
import { dataset, gamesFor, dataWindow, MARKETS } from '../../api/_qbdna/engine.js';
import { MARKET_MAP, GATEWAY_MARKETS, OUR_TO_GATEWAY, MARKET_UNAVAILABLE }
  from '../../api/_qbdna/markets.js';

const MAHOMES = '00-0033873';
const withHistory = () => dataset().players.filter(p => gamesFor(p.gsis_id).length);

/* ===================== DATA WINDOW ======================================= */

test('the dataset window is explicit and reaches the latest completed game', () => {
  const w = dataWindow();
  assert.match(w.data_through, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(w.latest_completed_game.game_id);
  assert.equal(w.latest_completed_game.date, w.data_through);
  const newest = dataset().qb_games.reduce((a, b) => (a.d > b.d ? a : b));
  assert.equal(w.data_through, newest.d);
});

test('no game in the dataset postdates the declared window', () => {
  const w = dataWindow();
  for (const g of dataset().qb_games) {
    assert.ok(g.d <= w.data_through, `${g.g} (${g.d}) is after data_through`);
  }
});

test('a season with no play-by-play is declared, not silently absent', () => {
  const w = dataWindow();
  assert.ok(Array.isArray(w.seasons_without_play_by_play));
  if (!w.seasons_without_play_by_play.length) return;
  assert.match(w.note, /no game in that season has been completed/i);
  for (const y of w.seasons_without_play_by_play) {
    assert.equal(dataset().qb_games.some(g => g.s === y), false,
      `season ${y} is declared absent but rows exist for it`);
  }
});

test('the window covers 2019 through the latest completed season', () => {
  const w = dataWindow();
  assert.equal(w.seasons[0], 2019);
  assert.equal(w.latest_season, w.seasons[w.seasons.length - 1]);
  // the seasons list must be contiguous - a hole would silently skew every split
  for (let i = 1; i < w.seasons.length; i++) {
    assert.equal(w.seasons[i], w.seasons[i - 1] + 1, `gap before season ${w.seasons[i]}`);
  }
});

test('every response carries the data window', async () => {
  for (const [route, qs] of [
    ['qb-dna', `player_id=${MAHOMES}`],
    ['qb-dna', 'list=1'],
    ['prop-history', `player_id=${MAHOMES}&market=passing_yards&line=274.5`]
  ]) {
    const r = await call(route, qs);
    assert.equal(r.status, 200, route);
    assert.ok(r.body.data_window, `${route} must carry data_window`);
    assert.ok(r.body.data_window.data_through, `${route} data_through`);
  }
});

/* ===================== NO NFL HISTORY ==================================== */

test('a quarterback with no NFL history is a 200 saying so, not an error', async () => {
  const rookie = dataset().players.find(p => p.active_2026 && !gamesFor(p.gsis_id).length);
  assert.ok(rookie, 'expected at least one active 2026 QB with no NFL history');
  const r = await call('qb-dna', `player_id=${rookie.gsis_id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.history_available, false);
  assert.equal(r.body.sample_state, 'NFL SAMPLE UNAVAILABLE');
  assert.equal(r.body.nfl_games, 0);
  assert.equal(r.body.baseline, null);
  assert.equal(r.body.conditions, null);
  assert.match(r.body.disclosure, /College and preseason statistics are not substituted/);
});

test('no-history responses never carry a computed number', async () => {
  const rookies = dataset().players.filter(p => !gamesFor(p.gsis_id).length).slice(0, 8);
  assert.ok(rookies.length, 'the dataset must include zero-history 2026 QBs');
  for (const p of rookies) {
    const r = await call('qb-dna', `player_id=${p.gsis_id}`);
    assert.equal(r.body.history_available, false, p.display_name);
    for (const k of ['baseline', 'current_season', 'recent', 'conditions']) {
      assert.equal(r.body[k], null, `${p.display_name}.${k} must be null, not zero-filled`);
    }
    assert.equal(r.body.game_log.length, 0);
  }
});

test('prop history for a no-history QB is unavailable, not 0%', async () => {
  const rookie = dataset().players.find(p => p.active_2026 && !gamesFor(p.gsis_id).length);
  const r = await call('prop-history', `player_id=${rookie.gsis_id}&market=passing_yards&line=200`);
  assert.equal(r.status, 200);
  assert.equal(r.body.history_available, false);
  assert.equal(r.body.sample_state, 'NFL SAMPLE UNAVAILABLE');
  assert.equal(r.body.full_history.available, false);
  assert.equal(r.body.full_history.over_pct, undefined);
});

test('the player index flags 2026 status and history availability', async () => {
  const r = await call('qb-dna', 'list=1');
  assert.equal(r.status, 200);
  assert.ok(r.body.active_2026 > 0);
  assert.ok(r.body.market_priced_2026 > 0);
  assert.ok(r.body.zero_history > 0, 'the index must include QBs with no NFL history');
  for (const p of r.body.players) {
    assert.equal(typeof p.history_available, 'boolean');
    assert.equal(p.history_available, p.games > 0);
  }
  // market-priced starters sort first so the UI offers current QBs
  const firstNonPriced = r.body.players.findIndex(p => !p.market_priced_2026);
  const lastPriced = r.body.players.map(p => p.market_priced_2026).lastIndexOf(true);
  assert.ok(lastPriced < firstNonPriced, 'market-priced QBs must sort ahead');
});

/* ===================== RECENCY WINDOWS =================================== */

test('recency windows are last 5, last 10, current season and career', async () => {
  const r = await call('qb-dna', `player_id=${MAHOMES}`);
  const rec = r.body.recent;
  assert.deepEqual(Object.keys(rec), ['last_5', 'last_10', 'current_season', 'career']);
  for (const [k, w] of Object.entries(rec)) {
    assert.equal(typeof w.games, 'number', `${k} must carry N`);
    assert.ok(w.sample_label, `${k} must carry its size label`);
  }
  const rows = gamesFor(MAHOMES);
  assert.equal(rec.career.games, rows.length);
  assert.equal(rec.last_5.games, Math.min(5, rows.length));
  assert.equal(rec.last_10.games, Math.min(10, rows.length));
});

test('a window that cannot be filled says exactly how many games exist', async () => {
  const short = withHistory().find(p => {
    const n = gamesFor(p.gsis_id).length;
    return n > 0 && n < 5;
  });
  if (!short) return;                      // no such QB in this snapshot
  const n = gamesFor(short.gsis_id).length;
  const r = await call('qb-dna', `player_id=${short.gsis_id}`);
  assert.equal(r.body.recent.last_5.games, n);
  assert.equal(r.body.recent.last_5.complete, false);
  assert.match(r.body.recent.last_5.shortfall_note, new RegExp(`only ${n} game`));
});

test('current season is the latest season present, never an older one', async () => {
  const r = await call('qb-dna', `player_id=${MAHOMES}`);
  const seasons = [...new Set(gamesFor(MAHOMES).map(g => g.s))].sort();
  assert.equal(r.body.recent.current_season.season, seasons[seasons.length - 1]);
  assert.equal(r.body.recent.current_season.season, dataWindow().latest_season);
});

test('a recency window never draws on more games than exist', async () => {
  for (const p of withHistory().slice(0, 12)) {
    const n = gamesFor(p.gsis_id).length;
    const r = await call('qb-dna', `player_id=${p.gsis_id}`);
    for (const [k, w] of Object.entries(r.body.recent)) {
      assert.ok(w.games <= n, `${p.display_name} ${k}: ${w.games} > ${n}`);
    }
  }
});

/* ===================== CURRENT MARKET =================================== */

test('exactly the five supported passing markets are mapped', () => {
  assert.deepEqual(Object.values(MARKET_MAP).sort(), [
    'completions', 'interceptions', 'passing_attempts',
    'passing_touchdowns', 'passing_yards'
  ]);
  assert.equal(GATEWAY_MARKETS.length, 5);
  for (const g of GATEWAY_MARKETS) assert.match(g, /^player_pass_/);
  // every mapped market must be one the engine can actually count
  for (const our of Object.values(MARKET_MAP)) assert.ok(MARKETS[our], our);
  // and the reverse map must round-trip
  for (const [g, o] of Object.entries(MARKET_MAP)) assert.equal(OUR_TO_GATEWAY[o], g);
});

test('the unavailable state is a stated constant, not an empty value', () => {
  assert.equal(MARKET_UNAVAILABLE, 'CURRENT MARKET UNAVAILABLE');
});

test('no line and no event is refused - a default is never invented', async () => {
  const r = await call('prop-history', `player_id=${MAHOMES}&market=passing_yards`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'line_or_event_required');
  assert.equal(r.body.line, undefined, 'no line may be invented');
  assert.equal(r.body.full_history, undefined);
});

test('a supplied line is labelled as supplied, not as a market line', async () => {
  const r = await call('prop-history', `player_id=${MAHOMES}&market=passing_yards&line=250`);
  assert.equal(r.body.line, 250);
  assert.equal(r.body.line_source.source, 'supplied');
});

test('LIVE: a market line drives the calculation and is labelled as such', async () => {
  let slate;
  try {
    slate = await call('game-context', '');
  } catch { return; }                                  // market/schedule offline
  if (slate.status !== 200) return;
  const withMarket = slate.body.games.find(g => g.market_event_id);
  if (!withMarket) return;

  const ctx = await call('game-context', `event_id=${withMarket.espn_event_id}`);
  if (!ctx.body.markets || !ctx.body.markets.available) return;
  const priced = ctx.body.markets.players.find(p => p.gsis_id
    && p.markets.passing_yards && Number.isFinite(p.markets.passing_yards.line));
  if (!priced) return;

  const r = await call('prop-history',
    `player_id=${priced.gsis_id}&market=passing_yards&event_id=${ctx.body.market_event_id}`);
  assert.equal(r.status, 200);
  if (r.body.market_state === MARKET_UNAVAILABLE) return;
  assert.equal(r.body.line, priced.markets.passing_yards.line,
    'the calculation must use the market line verbatim');
  assert.equal(r.body.line_source.source, 'current_market');
  assert.equal(r.body.line_source.gateway_market, 'player_pass_yds');
  // and the count must still be internally consistent
  const f = r.body.full_history;
  assert.equal(f.over + f.under + f.push, f.total);
});

test('LIVE: an unoffered market returns CURRENT MARKET UNAVAILABLE and no line', async () => {
  let slate;
  try { slate = await call('game-context', ''); } catch { return; }
  if (slate.status !== 200) return;
  const withMarket = slate.body.games.find(g => g.market_event_id);
  if (!withMarket) return;
  const ctx = await call('game-context', `event_id=${withMarket.espn_event_id}`);
  if (!ctx.body.markets || !ctx.body.markets.available) return;

  const gap = ctx.body.markets.players.find(p => p.gsis_id && p.unavailable_markets.length);
  if (!gap) return;                                    // every market offered
  const missing = gap.unavailable_markets[0].market;
  const r = await call('prop-history',
    `player_id=${gap.gsis_id}&market=${missing}&event_id=${ctx.body.market_event_id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.market_state, MARKET_UNAVAILABLE);
  assert.equal(r.body.line, null);
  assert.equal(r.body.full_history, undefined, 'nothing may be counted without a line');
  assert.match(r.body.note, /No default line is inserted/);
});

test('LIVE: market players resolve by exact name or not at all', async () => {
  let slate;
  try { slate = await call('game-context', ''); } catch { return; }
  if (slate.status !== 200) return;
  const withMarket = slate.body.games.find(g => g.market_event_id);
  if (!withMarket) return;
  const ctx = await call('game-context', `event_id=${withMarket.espn_event_id}`);
  if (!ctx.body.markets || !ctx.body.markets.available) return;

  for (const p of ctx.body.markets.players) {
    if (p.gsis_id) {
      assert.equal(p.matched_by, 'exact_name');
      // the resolved identity must genuinely carry that exact display name
      const rec = dataset().players.find(x => x.gsis_id === p.gsis_id);
      assert.equal(rec.display_name.toLowerCase(), p.player_name.toLowerCase());
    } else {
      assert.ok(p.resolution_note, 'an unresolved market player must state why');
    }
  }
});

test('LIVE: a roofed game carries markets but no forecast', async () => {
  let slate;
  try { slate = await call('game-context', ''); } catch { return; }
  if (slate.status !== 200) return;
  const roofed = slate.body.games.find(g => g.venue && g.venue.indoor && !g.neutral_site);
  if (!roofed) return;
  const ctx = await call('game-context', `event_id=${roofed.espn_event_id}`);
  assert.equal(ctx.body.forecast, null, 'a roofed game must not fetch a forecast');
  assert.equal(ctx.body.context.roof, 'closed');
  assert.ok(ctx.body.unresolved.some(u => u.field === 'weather'),
    'the roofed exclusion must be stated');
  for (const k of ['temp_f', 'wind_mph', 'precip']) {
    assert.equal(ctx.body.context[k], undefined, `${k} must not be inferred indoors`);
  }
});

test('LIVE: game context resolves the full set the product needs', async () => {
  let slate;
  try { slate = await call('game-context', ''); } catch { return; }
  if (slate.status !== 200) return;
  const g = slate.body.games.find(x => !x.neutral_site && x.venue);
  if (!g) return;
  const ctx = await call('game-context', `event_id=${g.espn_event_id}`);
  assert.equal(ctx.status, 200);
  assert.ok(ctx.body.game.venue.venue, 'venue');
  assert.ok(ctx.body.game.surface, 'surface');
  assert.ok(ctx.body.context.roof, 'roof');
  assert.ok(ctx.body.game.kickoff_utc, 'kickoff');
  assert.equal(typeof ctx.body.context.primetime, 'boolean');
  assert.ok(ctx.body.context.home_team && ctx.body.context.away_team, 'teams');
  assert.ok(ctx.body.markets, 'markets block must always be present');
  // outdoor games must either carry a forecast or say why not
  if (!ctx.body.context.indoor) {
    assert.ok(ctx.body.forecast || ctx.body.unresolved.some(u => u.field === 'weather'),
      'an outdoor game needs a forecast or a stated reason');
  }
});
