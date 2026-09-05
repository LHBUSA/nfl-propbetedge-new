/* TE DNA — the red zone, and the fact that TE and WR share one engine.
 * node --test research/qbdna/tedna.test.mjs
 *
 * TE DNA is the receiver engine bound to a tight-end dataset. That buys the
 * whole receiver rulebook for free, and creates exactly one new risk: the two
 * bindings drifting apart, so that a target means one thing on /#wrdna and
 * something else on /#tedna. The first block below exists to catch that.
 *
 * The second risk is the red zone itself. It is a SMALL sample by nature —
 * a dozen targets in a season is normal — so the danger is a conversion rate
 * that reads like a finishing skill when it rests on three plays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from './call.mjs';
import { dataset, gamesFor, baseline, conditionProfile, dnaSignals, qbConnections,
         splitRows, propThreshold, tdHistory, resolvePlayer, dataWindow, SAMPLE,
         CONDITIONS, MARKETS, SIGNAL_TIERS } from '../../api/_tedna/engine.js';
import * as WR from '../../api/_wrdna/engine.js';
import { RECEIVING_MARKET_MAP, MARKET_UNAVAILABLE } from '../../api/_playerdna/markets.js';

const KELCE = '00-0030506', KITTLE = '00-0033288';
const withHistory = () => dataset().players.filter(p => gamesFor(p.gsis_id).length);
const anyTE = () => withHistory().find(p => baseline(gamesFor(p.gsis_id)).rz_targets > 30);

/* ===================== ONE ENGINE, TWO BINDINGS ========================== */

test('TE and WR share one condition vocabulary, exactly', () => {
  assert.deepEqual(Object.keys(CONDITIONS).sort(), Object.keys(WR.CONDITIONS).sort());
  for (const k of Object.keys(CONDITIONS)) {
    assert.equal(CONDITIONS[k].label, WR.CONDITIONS[k].label, `${k} label drifted`);
    assert.equal(CONDITIONS[k].group, WR.CONDITIONS[k].group, `${k} group drifted`);
    assert.equal(Boolean(CONDITIONS[k].rollup), Boolean(WR.CONDITIONS[k].rollup));
  }
});

test('TE and WR share one market vocabulary and one signal policy', () => {
  assert.deepEqual(Object.keys(MARKETS).sort(), Object.keys(WR.MARKETS).sort());
  assert.deepEqual(SIGNAL_TIERS, WR.SIGNAL_TIERS);
});

test('TE and WR share one sample grammar', () => {
  for (const [n, want] of [[25, 'STRONG SAMPLE'], [14, 'MODERATE SAMPLE'],
                           [6, 'SMALL SAMPLE'], [3, 'VERY SMALL SAMPLE']]) {
    assert.equal(SAMPLE(n), want);
    assert.equal(SAMPLE(n), WR.SAMPLE(n));
  }
});

test('the two datasets are disjoint — a player is never both a WR and a TE', () => {
  const te = new Set(dataset().players.map(p => p.gsis_id));
  const both = WR.dataset().players.filter(p => te.has(p.gsis_id));
  assert.equal(both.length, 0, `${both.map(p => p.display_name).join(', ')} appear in both`);
});

/* ===================== IDENTITY ========================================== */

test('the two demo tight ends resolve by stable id with real history', () => {
  for (const id of [KELCE, KITTLE]) {
    const r = resolvePlayer({ player_id: id });
    assert.ok(r.player, id);
    assert.equal(r.matched_by, 'gsis_id');
    assert.ok(gamesFor(id).length > 50, `${r.player.display_name} should have real history`);
    assert.ok(r.player.espn_id, 'a demo tight end must carry an ESPN id for his photograph');
  }
});

test('name matching is exact only, never fuzzy', () => {
  assert.equal(resolvePlayer({ name: 'Travis Kelce' }).player.gsis_id, KELCE);
  for (const near of ['Kelce', 'T. Kelce', 'travis kelse']) {
    assert.equal(resolvePlayer({ name: near }).player, null, `"${near}" must not match`);
  }
});

test('the dataset is TE only and says so', () => {
  const D = dataset();
  assert.match(D.meta.position_scope, /TE only/);
  for (const p of D.players.slice(0, 100)) {
    assert.equal(p.position, 'TE', `${p.display_name} is a ${p.position}`);
  }
});

/* ===================== RED ZONE ========================================== */

test('red-zone counts never exceed their own parents', () => {
  for (const p of withHistory().slice(0, 80)) {
    for (const g of gamesFor(p.gsis_id)) {
      assert.ok((g.rzt ?? 0) <= (g.tg ?? 0), `${p.display_name} ${g.g}: RZ targets exceed targets`);
      assert.ok((g.rzr ?? 0) <= (g.rzt ?? 0), `${p.display_name} ${g.g}: RZ catches exceed RZ targets`);
      assert.ok((g.rztd ?? 0) <= (g.rzr ?? 0), `${p.display_name} ${g.g}: RZ TDs exceed RZ catches`);
    }
  }
});

test('a tight end never takes more red-zone targets than his team has', () => {
  for (const p of withHistory().slice(0, 80)) {
    for (const g of gamesFor(p.gsis_id)) {
      if (typeof g.trz !== 'number' || !g.trz) continue;
      assert.ok(g.rzt <= g.trz, `${p.display_name} ${g.g}: ${g.rzt} of ${g.trz} team RZ targets`);
    }
  }
});

test('every red-zone rate keeps both of its numbers', () => {
  const b = baseline(gamesFor(anyTE().gsis_id));
  for (const k of ['rz_catch_rate', 'rz_td_per_target', 'rz_target_share']) {
    const r = b[k];
    if (!r || r.pct === null) continue;
    assert.equal(r.numerator + 0, r.numerator, `${k} numerator missing`);
    assert.ok(r.denominator > 0, `${k} must keep its denominator`);
    assert.ok(r.pct >= 0 && r.pct <= 100, `${k} = ${r.pct}%`);
  }
});

test('the red-zone sample is counted in TARGETS, not games', async () => {
  /* This is the whole hazard of a tight-end product: a 131-game career reads
     as a STRONG SAMPLE while the red-zone work inside it is a handful of
     plays. The label has to describe the plays, not the career.

     Asserting that on one player is fragile — the two can coincide — so this
     checks every window of every tight end, and separately proves that the
     rule bites somewhere: at least one window where labelling by games would
     have overstated the red-zone sample. */
  let bites = 0, checked = 0;
  for (const p of withHistory().slice(0, 40)) {
    const r = await call('te-dna', `player_id=${p.gsis_id}`);
    for (const key of ['career', 'current_season', 'last_10']) {
      const w = r.body.red_zone_dna[key];
      if (!w || !w.available || !w.has_red_zone_work) continue;
      checked++;
      assert.equal(w.sample_basis, 'red-zone TARGETS, not games');
      assert.equal(w.sample_label, SAMPLE(w.rz_targets),
        `${p.display_name} ${key}: label does not follow the red-zone target count`);
      if (SAMPLE(w.rz_targets) !== SAMPLE(w.games)) bites++;
    }
  }
  assert.ok(checked > 30, `only ${checked} windows checked`);
  assert.ok(bites > 0, 'no window where games and red-zone targets disagree — rule untested');
});

test('a window with no red-zone work says so rather than reporting a zero rate', async () => {
  const thin = withHistory().find(p => baseline(gamesFor(p.gsis_id)).rz_targets === 0);
  if (!thin) { console.log('  (every tight end has red-zone work — rule not exercised)'); return; }
  const r = await call('te-dna', `player_id=${thin.gsis_id}`);
  const c = r.body.red_zone_dna.career;
  assert.equal(c.has_red_zone_work, false);
  assert.equal(c.rz_targets, 0);
  assert.ok(!('rz_catch_rate' in c), 'a catch rate on zero targets must not be emitted at all');
  assert.match(c.note, /no red-zone target/);
});

test('red-zone targets are a subset of all targets, never a parallel count', () => {
  const b = baseline(gamesFor(KELCE));
  assert.ok(b.rz_targets < b.targets);
  assert.ok(b.rz_touchdowns <= b.touchdowns,
    'a red-zone TD is also a touchdown; it cannot exceed the total');
});

/* ===================== RECEIVER RULES, INHERITED ========================= */

test('receptions never exceed targets in any game', () => {
  for (const p of withHistory().slice(0, 80)) {
    for (const g of gamesFor(p.gsis_id)) {
      assert.ok(g.rec <= g.tg, `${p.display_name} ${g.g}: ${g.rec} receptions on ${g.tg} targets`);
    }
  }
});

test('a roofed game can never enter an outdoor weather split', () => {
  const rows = gamesFor(KELCE);
  for (const key of Object.keys(CONDITIONS)) {
    if (!CONDITIONS[key].weather) continue;
    for (const r of splitRows(rows, key).rows) {
      assert.notEqual(r.ind, 1, `${key} admitted an indoor game`);
      assert.equal(r.ws, 'ok', `${key} admitted a game with no resolved environment`);
    }
  }
});

test('nothing under the qualifying N is called a strength or a watchout', () => {
  for (const p of withHistory().slice(0, 25)) {
    const sig = dnaSignals(conditionProfile(gamesFor(p.gsis_id)));
    for (const x of [...sig.strengths, ...sig.watchouts]) {
      assert.ok(x.games >= SIGNAL_TIERS.qualifying_n,
        `${p.display_name}: "${x.label}" called ${x.tier} on N=${x.games}`);
    }
  }
});

test('the QB connection is built from play-level passer ids', () => {
  const c = qbConnections(KELCE, { min_targets: 5 });
  assert.ok(c.connections.length > 1, 'a long career should show more than one passer');
  for (const x of c.connections) {
    assert.ok(x.games > 0);
    assert.equal(x.targets_per_game, +(x.targets / x.games).toFixed(1));
    assert.equal(x.sample_label, SAMPLE(x.games));
    assert.ok(x.passer_id, 'a connection without a stable passer id is a name match');
  }
  const top = c.connections[0];
  const career = baseline(gamesFor(KELCE));
  assert.ok(top.targets <= career.targets, 'a connection cannot exceed his own career targets');
});

/* ===================== MARKETS =========================================== */

test('anytime TD is a rate of touchdown games, never a threshold', () => {
  const t = tdHistory(gamesFor(KELCE));
  assert.equal(t.td_games + t.no_td_games, t.total);
  assert.match(t.note, /not an implied probability/i);
  assert.equal(MARKETS.anytime_td, undefined);
});

test('a threshold splits over, under and push exactly', () => {
  const t = propThreshold(gamesFor(KELCE), 'receiving_yards', 55.5);
  assert.equal(t.over + t.under + t.push, t.total);
});

/* ===================== ROUTES ============================================ */

test('the prop lab refuses to work without an event', async () => {
  const r = await call('te-prop-lab', `player_id=${KELCE}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'event_id_required');
});

test('the tight end response leads with the red zone and carries the disclaimer', async () => {
  const r = await call('te-dna', `player_id=${KELCE}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.history_available, true);
  assert.ok(r.body.red_zone_dna.career.rz_targets > 0);
  assert.match(r.body.red_zone_dna.definition, /opponent 20/);
  assert.match(r.body.red_zone_dna.caveat, /small by nature/);
  assert.ok(r.body.qb_connection.connections.length);
  assert.ok(r.body.provenance.notes.some(n => /not.*model picks/i.test(n)));
  assert.ok(r.body.player.media.headshot_url);
  assert.equal(r.body.player.position, 'TE');
});

test('a tight end with no NFL history is a 200 saying so, not zeros', async () => {
  const zero = dataset().players.find(p => !gamesFor(p.gsis_id).length);
  if (!zero) return;
  const r = await call('te-dna', `player_id=${zero.gsis_id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.history_available, false);
  assert.equal(r.body.red_zone_dna, null);
  assert.equal(r.body.baseline, null);
  assert.match(r.body.disclosure, /College/);
});

test('the list is ordered by market relevance and every tight end carries media', async () => {
  const r = await call('te-dna', 'list=1');
  assert.equal(r.status, 200);
  assert.ok(r.body.count > 150);
  for (const p of r.body.players) assert.ok(p.media, `${p.name} has no media block`);
  const firstUnpriced = r.body.players.findIndex(p => !p.market_priced_2026);
  assert.ok(r.body.players.slice(0, firstUnpriced).every(p => p.market_priced_2026));
});

test('compare reports each tight end against HIS OWN baseline', async () => {
  const r = await call('te-compare', `player_a=${KELCE}&player_b=${KITTLE}`);
  assert.equal(r.status, 200);
  for (const [k, c] of Object.entries(r.body.conditions)) {
    if (!c.available) { assert.ok(c.reason); continue; }
    assert.ok('a_vs_own_baseline' in c && 'b_vs_own_baseline' in c, k);
    assert.equal(typeof c.rollup, 'boolean');
  }
});

/* ===================== WINDOW ============================================ */

test('no game in the tight end dataset postdates the declared window', () => {
  const w = dataWindow();
  for (const p of withHistory()) {
    for (const g of gamesFor(p.gsis_id)) {
      assert.ok(g.d <= w.data_through, `${g.g} on ${g.d} postdates ${w.data_through}`);
    }
  }
});

/* ===================== LIVE MARKET ======================================= */

test('LIVE: an offered market carries a real number, an unoffered one says so', async () => {
  const slate = await call('game-context', '');
  const g = (slate.body.games || [])[0];
  if (!g) { console.log('  (no slate available — market assertions skipped)'); return; }
  const r = await call('te-prop-lab', `player_id=${KELCE}&event_id=${g.espn_event_id}`);
  assert.equal(r.status, 200);
  for (const c of r.body.markets) {
    if (!c.available) { assert.equal(c.state, MARKET_UNAVAILABLE); assert.ok(c.reason); continue; }
    if (c.kind === 'price') assert.equal(c.line, null);
    else assert.ok(Number.isFinite(c.line), `${c.market} offered without a numeric line`);
  }
});
