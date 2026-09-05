/* WR DNA — receiver metrics, count rules, QB connection and withholding.
 * node --test research/qbdna/wrdna.test.mjs
 *
 * The receiver product has two failure modes a quarterback product does not:
 * a target rule that quietly miscounts, and a QB-connection table that
 * attributes a receiver's production to the wrong passer. Most of what follows
 * guards those two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from './call.mjs';
import { dataset, gamesFor, baseline, conditionProfile, dnaSignals, qbConnections,
         splitRows, propThreshold, tdHistory, resolvePlayer, dataWindow,
         CONDITIONS, MARKETS, SIGNAL_TIERS } from '../../api/_wrdna/engine.js';
import { RECEIVING_MARKET_MAP, MARKET_UNAVAILABLE } from '../../api/_playerdna/markets.js';

const JEFFERSON = '00-0036322', CHASE = '00-0036900';
const withHistory = () => dataset().players.filter(p => gamesFor(p.gsis_id).length);

/* ===================== IDENTITY ========================================== */

test('the two demo receivers resolve by stable id with real history', () => {
  for (const id of [JEFFERSON, CHASE]) {
    const r = resolvePlayer({ player_id: id });
    assert.ok(r.player, id);
    assert.equal(r.matched_by, 'gsis_id');
    assert.ok(gamesFor(id).length > 50, `${r.player.display_name} should have real history`);
    assert.ok(r.player.espn_id, 'a demo receiver must carry an ESPN id for his photograph');
  }
});

test('name matching is exact only, never fuzzy', () => {
  assert.equal(resolvePlayer({ name: 'Justin Jefferson' }).player.gsis_id, JEFFERSON);
  for (const near of ['Jefferson', 'J. Jefferson', 'justin jeffersen']) {
    assert.equal(resolvePlayer({ name: near }).player, null, `"${near}" must not match`);
  }
});

test('an unknown stable id fails closed rather than falling back to a name', () => {
  const r = resolvePlayer({ espn_id: '999999999', name: 'Justin Jefferson' });
  assert.equal(r.player, null);
  assert.match(r.reason, /stable id/);
});

/* ===================== COUNT RULES ======================================= */

test('receptions never exceed targets in any game', () => {
  for (const p of withHistory().slice(0, 60)) {
    for (const g of gamesFor(p.gsis_id)) {
      assert.ok(g.rec <= g.tg, `${p.display_name} ${g.g}: ${g.rec} receptions on ${g.tg} targets`);
    }
  }
});

test('a receiver never out-targets his own team', () => {
  for (const p of withHistory().slice(0, 60)) {
    for (const g of gamesFor(p.gsis_id)) {
      assert.ok(g.tg <= g.tt, `${p.display_name} ${g.g}: ${g.tg} of ${g.tt} team targets`);
    }
  }
});

test('target share is a real ratio bounded by one, with both parts retained', () => {
  const b = baseline(gamesFor(JEFFERSON));
  assert.equal(b.target_share.numerator, b.targets);
  assert.ok(b.target_share.denominator > b.target_share.numerator);
  assert.ok(b.target_share.pct > 0 && b.target_share.pct < 100);
  // catch rate is bounded the same way
  assert.equal(b.catch_rate.numerator, b.receptions);
  assert.equal(b.catch_rate.denominator, b.targets);
  assert.ok(b.catch_rate.pct <= 100);
});

test('receiving yards are only credited on completions', () => {
  // a game with zero receptions can carry no receiving yards
  for (const p of withHistory().slice(0, 40)) {
    for (const g of gamesFor(p.gsis_id)) {
      if (g.rec === 0) assert.equal(g.ry, 0, `${p.display_name} ${g.g}`);
    }
  }
});

test('a ratio with no denominator reports null, never zero', () => {
  const empty = baseline([{ tg: 0, rec: 0, ry: 0, tt: 0, ay: 0, tay: 0, rtd: 0,
                            yac: 0, fd: 0, d: '2025-01-01', win: null }]);
  assert.equal(empty.catch_rate.pct, null);
  assert.equal(empty.yards_per_target.value, null);
  assert.equal(empty.yards_per_reception.value, null);
});

/* ===================== POSITION SCOPE ==================================== */

test('the dataset is WR only and says so', () => {
  const m = dataset().meta;
  assert.match(m.position_scope, /WR only/);
  for (const p of dataset().players) {
    if (p.games_in_dataset > 0) assert.equal(p.position, 'WR', p.display_name);
  }
});

/* ===================== WITHHELD ========================================== */

test('routes and snap share are withheld with a measured reason', () => {
  const w = dataset().meta.withheld_fields;
  assert.ok(w.length >= 2);
  const routes = w.find(f => /route/i.test(f.field));
  assert.ok(routes, 'route participation must be explicitly withheld');
  assert.match(routes.reason, /NOT PUBLISHED|not published/);
  // and nothing route-shaped may leak into a receiver row
  const g = gamesFor(JEFFERSON)[0];
  for (const k of Object.keys(g)) {
    assert.equal(/route|snap/i.test(k), false, `row carries a withheld field: ${k}`);
  }
});

/* ===================== QB CONNECTION ===================================== */

test('the QB connection is built from play-level passer ids', () => {
  const c = qbConnections(JEFFERSON, { min_targets: 1 });
  assert.ok(c.connections.length > 1, 'a long career spans more than one passer');
  assert.match(c.method, /play-level passer ids/);
  assert.match(c.disclaimer, /Not a model/);
});

test('every connection carries per-game rates against its own N', () => {
  for (const id of [JEFFERSON, CHASE]) {
    for (const x of qbConnections(id, { min_targets: 1 }).connections) {
      assert.ok(Number.isFinite(x.targets_per_game), `${x.name} targets_per_game`);
      assert.ok(Number.isFinite(x.receiving_yards_per_game), `${x.name} yards_per_game`);
      assert.ok(x.games > 0);
      // the rate must actually equal its own division
      assert.equal(x.targets_per_game, +(x.targets / x.games).toFixed(1));
      assert.equal(x.receiving_yards_per_game, +(x.receiving_yards / x.games).toFixed(1));
      // and the sample label must match the game count, not something else
      const expect = x.games >= 20 ? 'STRONG SAMPLE' : x.games >= 10 ? 'MODERATE SAMPLE'
        : x.games >= 5 ? 'SMALL SAMPLE' : 'VERY SMALL SAMPLE';
      assert.equal(x.sample_label, expect, `${x.name} N=${x.games}`);
    }
  }
});

test('connection totals never exceed the receiver own career totals', () => {
  for (const id of [JEFFERSON, CHASE]) {
    const b = baseline(gamesFor(id));
    const c = qbConnections(id, { min_targets: 1 });
    const t = c.connections.reduce((a, x) => a + x.targets, 0);
    const y = c.connections.reduce((a, x) => a + x.receiving_yards, 0);
    assert.ok(t <= b.targets, `pairing targets ${t} exceed career ${b.targets}`);
    assert.ok(y <= b.receiving_yards_total, `pairing yards ${y} exceed career`);
  }
});

test('a receiver targeted by two passers in a game is counted against each', () => {
  // games do not sum to the career total precisely because of this, and the
  // method statement says so rather than hiding it
  const c = qbConnections(JEFFERSON, { min_targets: 1 });
  const summed = c.connections.reduce((a, x) => a + x.games, 0);
  assert.ok(summed >= gamesFor(JEFFERSON).length);
  assert.match(c.method, /do not sum/);
});

/* ===================== CONDITIONS AND SIGNALS ============================ */

test('a roofed game can never enter an outdoor weather split', () => {
  const weather = Object.keys(CONDITIONS).filter(k => CONDITIONS[k].weather);
  for (const p of withHistory().slice(0, 20)) {
    const rows = gamesFor(p.gsis_id);
    for (const k of weather) {
      for (const r of splitRows(rows, k).rows) {
        assert.notEqual(r.ind, 1, `${p.display_name} ${k} contains an indoor game`);
        assert.equal(r.ws, 'ok');
      }
    }
  }
});

test('temperature bands are exclusive', () => {
  const rows = gamesFor(JEFFERSON);
  const seen = new Set();
  for (const b of ['arctic_sub20', 'freezing_20_32', 'cold_33_50', 'mild_51_70', 'warm_70_plus']) {
    for (const r of splitRows(rows, b).rows) {
      assert.equal(seen.has(r.g), false, `${r.g} in two bands`);
      seen.add(r.g);
    }
  }
});

test('target volume is NOT offered as a condition', () => {
  // it is an outcome of a game, not something known before it; splitting on it
  // would produce a confident number that cannot be applied to a future game
  for (const k of Object.keys(CONDITIONS)) {
    assert.equal(/target|volume|reception/i.test(k), false, `${k} is a postgame outcome`);
  }
});

test('nothing under the qualifying N is called a strength or a watchout', () => {
  for (const id of [JEFFERSON, CHASE]) {
    const g = dnaSignals(conditionProfile(gamesFor(id), 1));
    for (const x of [...g.strengths, ...g.watchouts]) {
      assert.ok(x.games >= SIGNAL_TIERS.qualifying_n, `${x.label} on ${x.games} games`);
    }
    for (const x of [...g.strengths, ...g.watchouts, ...g.signals, ...g.insufficient]) {
      assert.match(x.statement, /N=\d+/);
      assert.match(x.statement, /SAMPLE/);
    }
  }
});

/* ===================== MARKETS =========================================== */

test('the receiving market map covers exactly the three offered markets', () => {
  assert.deepEqual(Object.values(RECEIVING_MARKET_MAP).sort(),
    ['anytime_td', 'receiving_yards', 'receptions']);
  // the two threshold markets must be countable; anytime TD deliberately is not
  assert.ok(MARKETS.receiving_yards);
  assert.ok(MARKETS.receptions);
  assert.equal(MARKETS.anytime_td, undefined,
    'anytime TD must not be treated as a numeric threshold');
});

test('anytime TD is a rate of touchdown games, never a threshold', () => {
  const t = tdHistory(gamesFor(JEFFERSON));
  assert.equal(t.available, true);
  assert.equal(t.td_games + t.no_td_games, t.total);
  assert.equal(t.td_game_rate.numerator, t.td_games);
  assert.equal(t.td_game_rate.denominator, t.total);
  assert.match(t.note, /not an implied probability/i);
  assert.equal(t.over, undefined, 'a TD history has no over/under');
});

test('a threshold splits over, under and push exactly', () => {
  const t = propThreshold(gamesFor(JEFFERSON), 'receiving_yards', 73.5);
  assert.equal(t.over + t.under + t.push, t.total);
  assert.equal(t.over_pct, +(100 * t.over / t.total).toFixed(1));
});

test('the prop lab refuses to work without an event', async () => {
  const r = await call('wr-prop-lab', `player_id=${JEFFERSON}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'event_id_required');
});

/* ===================== API SHAPE ========================================= */

test('the receiver response carries the window, the scope and the disclaimer', async () => {
  const r = await call('wr-dna', `player_id=${JEFFERSON}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data_window.data_through);
  assert.match(r.body.provenance.position_scope, /WR only/);
  // WR DNA is counted history and market context, never a governed model pick
  assert.ok(r.body.provenance.notes.some(n => /not\s+PropBetEdge model picks/i.test(n)),
    'the response must state it is not a model pick');
  assert.ok(r.body.qb_connection.connections.length);
  assert.ok(r.body.form_series.games.length);
  for (const g of r.body.form_series.games) {
    assert.equal(typeof g.targets, 'number');
    assert.equal(typeof g.receptions, 'number');
  }
});

test('no game in the receiver dataset postdates the declared window', () => {
  const w = dataWindow();
  for (const g of dataset().receiver_games) {
    assert.ok(g.d <= w.data_through, `${g.g} (${g.d}) is after data_through`);
  }
});

test('a receiver with no NFL history is a 200 saying so, not zeros', async () => {
  const rookie = dataset().players.find(p => p.active_2026 && !gamesFor(p.gsis_id).length);
  if (!rookie) return;
  const r = await call('wr-dna', `player_id=${rookie.gsis_id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.history_available, false);
  assert.equal(r.body.sample_state, 'NFL SAMPLE UNAVAILABLE');
  for (const k of ['baseline', 'recent', 'conditions', 'dna_signals', 'qb_connection']) {
    assert.equal(r.body[k], null, `${k} must be null, not zero-filled`);
  }
});

test('compare reports each receiver against HIS OWN baseline', async () => {
  const r = await call('wr-compare', `player_a=${JEFFERSON}&player_b=${CHASE}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'players');
  for (const [key, x] of Object.entries(r.body.conditions)) {
    if (!x.available) { assert.ok(x.reason, key); continue; }
    assert.equal(typeof x.a.games, 'number');
    assert.equal(typeof x.b.games, 'number');
    assert.ok(x.key && x.group, `${key} must carry key and group`);
    assert.equal(typeof x.rollup, 'boolean');
  }
});

test('LIVE: anytime TD carries a signed price, never a fabricated line', async () => {
  let slate;
  try { slate = await call('game-context', ''); } catch { return; }
  if (slate.status !== 200) return;
  const g = slate.body.games.find(x => x.market_event_id);
  if (!g) return;
  const r = await call('wr-prop-lab',
    `player_id=${JEFFERSON}&event_id=${g.market_event_id}`);
  if (r.status !== 200 || !r.body.history_available) return;
  const td = r.body.markets.find(m => m.market === 'anytime_td');
  assert.ok(td);
  if (!td.available) { assert.equal(td.state, MARKET_UNAVAILABLE); return; }
  assert.equal(td.kind, 'price');
  assert.equal(td.line, null, 'a TD market must not carry a line');
  assert.ok(Number.isFinite(td.market_price));
  assert.match(td.note, /Not an implied probability|not an implied probability/i);
  for (const w of Object.values(td.windows)) {
    if (!w.available) continue;
    assert.equal(w.over, undefined, 'a TD window has no over/under');
    assert.equal(w.td_games + w.no_td_games, w.total);
  }
});
