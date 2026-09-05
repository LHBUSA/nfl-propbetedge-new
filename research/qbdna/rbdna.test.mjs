/* RB DNA — usage arithmetic, count rules, market position and withholding.
 * node --test research/qbdna/rbdna.test.mjs
 *
 * A running-back product has failure modes the other three do not:
 *   · a "carry" that quietly includes quarterback kneels, dragging every
 *     average down while looking perfectly reasonable
 *   · a touch count built from targets instead of receptions, inflating a
 *     passing-down back
 *   · a favourite/underdog split presented as though the spread caused the
 *     workload rather than describing it
 *   · a snap share invented from a participation file that is not published
 * Most of what follows guards those four.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from './call.mjs';
import { dataset, gamesFor, baseline, conditionProfile, dnaSignals, usageProfile,
         splitRows, propThreshold, tdHistory, resolvePlayer, dataWindow,
         CONDITIONS, MARKETS, SIGNAL_TIERS } from '../../api/_rbdna/engine.js';
import { RUSHING_MARKET_MAP, MARKET_UNAVAILABLE } from '../../api/_playerdna/markets.js';

const BARKLEY = '00-0034844', HENRY = '00-0032764';
const withHistory = () => dataset().players.filter(p => gamesFor(p.gsis_id).length);

/* ===================== IDENTITY ========================================== */

test('the two demo backs resolve by stable id with real history', () => {
  for (const id of [BARKLEY, HENRY]) {
    const r = resolvePlayer({ player_id: id });
    assert.ok(r.player, id);
    assert.equal(r.matched_by, 'gsis_id');
    assert.ok(gamesFor(id).length > 50, `${r.player.display_name} should have real history`);
    assert.ok(r.player.espn_id, 'a demo back must carry an ESPN id for his photograph');
  }
});

test('name matching is exact only, never fuzzy', () => {
  assert.equal(resolvePlayer({ name: 'Saquon Barkley' }).player.gsis_id, BARKLEY);
  for (const near of ['Barkley', 'S. Barkley', 'saquon barkely']) {
    assert.equal(resolvePlayer({ name: near }).player, null, `"${near}" must not match`);
  }
});

test('an unknown stable id fails closed rather than falling back to a name', () => {
  const r = resolvePlayer({ espn_id: '999999999', name: 'Saquon Barkley' });
  assert.equal(r.player, null);
  assert.match(r.reason, /stable id/);
});

/* ===================== COUNT RULES ======================================= */

test('a back never out-carries his own team in any game', () => {
  for (const p of withHistory().slice(0, 80)) {
    for (const g of gamesFor(p.gsis_id)) {
      if (typeof g.tc !== 'number') continue;
      assert.ok(g.car <= g.tc, `${p.display_name} ${g.g}: ${g.car} carries of ${g.tc} team carries`);
    }
  }
});

test('a back never out-targets his own team, and never catches more than he is thrown', () => {
  for (const p of withHistory().slice(0, 80)) {
    for (const g of gamesFor(p.gsis_id)) {
      if (typeof g.tt === 'number') assert.ok(g.tg <= g.tt, `${p.display_name} ${g.g} targets`);
      assert.ok(g.rec <= g.tg, `${p.display_name} ${g.g}: ${g.rec} catches on ${g.tg} targets`);
    }
  }
});

test('red-zone carries never exceed carries', () => {
  for (const p of withHistory().slice(0, 80)) {
    for (const g of gamesFor(p.gsis_id)) {
      assert.ok((g.rzc ?? 0) <= (g.car ?? 0), `${p.display_name} ${g.g} red-zone carries`);
    }
  }
});

/* A touch is a carry plus a RECEPTION. Building it from targets would credit a
   back for passes he never caught — the single easiest way to inflate a
   passing-down back into looking like a workhorse. */
test('touches are carries plus receptions, never carries plus targets', () => {
  const rows = gamesFor(BARKLEY);
  const b = baseline(rows);
  const carries = rows.reduce((a, r) => a + (r.car ?? 0), 0);
  const receptions = rows.reduce((a, r) => a + (r.rec ?? 0), 0);
  const targets = rows.reduce((a, r) => a + (r.tg ?? 0), 0);
  assert.equal(b.touches, carries + receptions);
  assert.notEqual(b.touches, carries + targets,
    'if these are equal the rule is not being exercised — pick a back who drops passes');
});

test('scrimmage yards are rushing plus receiving, and the baseline metric is scrimmage', () => {
  const rows = gamesFor(BARKLEY);
  const b = baseline(rows);
  assert.equal(b.scrimmage_yards_total, b.rush_yards_total + b.receiving_yards_total);
  const prof = conditionProfile(rows);
  assert.equal(prof.baseline_mean, b.scrimmage_yards.mean,
    'condition movement must be measured on scrimmage yards, not rushing yards alone');
});

test('quarterback kneels and two-point tries are excluded from carries upstream', () => {
  /* The exclusion happens in the warehouse, so this asserts the CONSEQUENCE:
     no back in the dataset carries a game whose rushing yards are deeply
     negative in the way a pile of kneels would produce. */
  let worst = 0;
  for (const p of withHistory()) {
    for (const g of gamesFor(p.gsis_id)) {
      if ((g.car ?? 0) >= 3 && typeof g.ry === 'number') worst = Math.min(worst, g.ry);
    }
  }
  assert.ok(worst > -20, `a 3+ carry game at ${worst} rushing yards suggests kneels are counted`);
});

test('the dataset is RB only and says so', () => {
  const D = dataset();
  assert.match(D.meta.position_scope, /RB only/);
  for (const p of D.players.slice(0, 100)) {
    assert.equal(p.position, 'RB', `${p.display_name} is a ${p.position}`);
  }
});

/* ===================== RATES AND SHARES ================================== */

test('every share is a real ratio bounded by one, with both parts retained', () => {
  for (const p of withHistory().slice(0, 40)) {
    const b = baseline(gamesFor(p.gsis_id));
    for (const k of ['carry_share', 'target_share', 'rush_share_of_touches']) {
      const r = b[k];
      if (r.pct === null) { assert.equal(r.denominator, 0); continue; }
      assert.ok(r.pct >= 0 && r.pct <= 100, `${p.display_name} ${k} = ${r.pct}%`);
      assert.equal(typeof r.numerator, 'number');
      assert.ok(r.denominator > 0, `${k} must keep its denominator`);
    }
  }
});

test('a ratio with no denominator reports null, never zero', () => {
  const b = baseline([{ d: '2024-01-01', car: 0, ry: 0, tg: 0, rec: 0, recy: 0,
                        rtd: 0, rectd: 0, tc: 0, tt: 0 }]);
  assert.equal(b.yards_per_carry.value, null);
  assert.equal(b.carry_share.pct, null);
  assert.equal(b.catch_rate.pct, null);
  assert.match(b.yards_per_carry.note, /no denominator/);
});

test('yards per carry is a ratio in yards, not a percentage', () => {
  const b = baseline(gamesFor(BARKLEY));
  assert.equal(b.yards_per_carry.unit, 'yards per carry');
  assert.ok(b.yards_per_carry.value > 2 && b.yards_per_carry.value < 8,
    `${b.yards_per_carry.value} is not a plausible yards-per-carry figure`);
  assert.equal(b.yards_per_carry.pct, undefined, 'a ratio must not carry a pct field');
});

/* ===================== WITHHOLDING ======================================= */

test('snap share and routes run are withheld with a measured reason', () => {
  const u = usageProfile(gamesFor(BARKLEY));
  assert.deepEqual(u.withheld, ['snap share', 'routes run']);
  assert.match(u.withheld_reason, /participation/);
  assert.match(u.withheld_reason, /not published/);
  const fields = dataset().meta.withheld_fields.map(f => f.field);
  assert.ok(fields.includes('snap share'));
  for (const f of dataset().meta.withheld_fields) {
    assert.ok(f.reason && f.reason.length > 40, `${f.field} must say WHY it is withheld`);
  }
});

test('no surface field exposes a snap share under another name', () => {
  const b = baseline(gamesFor(BARKLEY));
  const u = usageProfile(gamesFor(BARKLEY));
  for (const key of [...Object.keys(b), ...Object.keys(u)]) {
    assert.doesNotMatch(key, /snap|route/i, `${key} looks like withheld participation data`);
  }
});

/* ===================== CONDITIONS ======================================== */

test('a roofed game can never enter an outdoor weather split', () => {
  const rows = gamesFor(BARKLEY);
  for (const key of Object.keys(CONDITIONS)) {
    if (!CONDITIONS[key].weather) continue;
    for (const r of splitRows(rows, key).rows) {
      assert.notEqual(r.ind, 1, `${key} admitted an indoor game`);
      assert.equal(r.ws, 'ok', `${key} admitted a game with no resolved environment`);
    }
  }
});

test('temperature bands are exclusive, and the rollup is marked as one', () => {
  const rows = gamesFor(BARKLEY);
  const bands = ['arctic_sub20', 'freezing_20_32', 'cold_33_50', 'mild_51_70', 'warm_70_plus'];
  const seen = new Map();
  for (const b of bands) {
    for (const r of splitRows(rows, b).rows) {
      assert.ok(!seen.has(r.g), `${r.g} appears in both ${seen.get(r.g)} and ${b}`);
      seen.set(r.g, b);
    }
  }
  assert.equal(CONDITIONS.below_freezing.rollup, true);
  assert.ok(!CONDITIONS.freezing_20_32.rollup);
});

test('favourite and underdog are offered but declared descriptive, not causal', () => {
  assert.equal(CONDITIONS.favorite.group, 'market');
  assert.equal(CONDITIONS.underdog.group, 'market');
  const sig = dnaSignals(conditionProfile(gamesFor(BARKLEY)));
  assert.match(sig.policy.note, /descriptive/i);
  assert.match(sig.policy.note, /not evidence/i);
});

test('a rollup never appears in the signal list beside its own parts', () => {
  const sig = dnaSignals(conditionProfile(gamesFor(BARKLEY)));
  const all = [...sig.strengths, ...sig.watchouts, ...sig.signals, ...sig.insufficient];
  assert.ok(!all.some(x => x.key === 'below_freezing'),
    'the below-freezing rollup would double-count its own temperature bands');
});

test('nothing under the qualifying N is called a strength or a watchout', () => {
  for (const p of withHistory().slice(0, 25)) {
    const sig = dnaSignals(conditionProfile(gamesFor(p.gsis_id)));
    for (const x of [...sig.strengths, ...sig.watchouts]) {
      assert.ok(x.games >= SIGNAL_TIERS.qualifying_n,
        `${p.display_name}: "${x.label}" called ${x.tier} on N=${x.games}`);
    }
    for (const x of sig.signals) {
      assert.ok(x.games >= SIGNAL_TIERS.signal_n && x.games < SIGNAL_TIERS.qualifying_n);
      assert.ok(/SAMPLE/.test(x.sample_label), 'a signal must carry its sample label');
    }
  }
});

test('carry volume is NOT offered as a condition', () => {
  /* Splitting a back on his own carry count and then reporting his yards would
     be circular: of course he gains more on more carries. */
  for (const k of Object.keys(CONDITIONS)) {
    assert.doesNotMatch(k, /carr|touch|volume/i, `${k} splits on the back's own workload`);
  }
});

/* ===================== MARKETS =========================================== */

test('the rushing market map covers exactly the five offered markets', () => {
  assert.deepEqual(Object.values(RUSHING_MARKET_MAP).sort(),
    ['anytime_td', 'receiving_yards', 'receptions', 'rush_attempts', 'rushing_yards']);
  for (const m of Object.values(RUSHING_MARKET_MAP)) {
    if (m === 'anytime_td') continue;
    assert.ok(MARKETS[m], `${m} has no engine definition`);
  }
});

test('anytime TD is a rate of touchdown games, never a threshold', () => {
  const t = tdHistory(gamesFor(BARKLEY));
  assert.equal(t.market, 'anytime_td');
  assert.equal(t.td_games + t.no_td_games, t.total);
  assert.equal(t.td_games, t.td_game_rate.numerator);
  assert.match(t.note, /not an implied probability/i);
  assert.equal(MARKETS.anytime_td, undefined, 'anytime TD must not be a threshold market');
});

test('a rushing-plus-receiving touchdown both settle the anytime TD market', () => {
  const t = tdHistory(gamesFor(BARKLEY));
  assert.equal(t.total_touchdowns, t.rush_tds + t.receiving_tds);
  assert.ok(t.receiving_tds > 0, 'a back who never caught a TD does not exercise this rule');
});

test('a threshold splits over, under and push exactly', () => {
  const t = propThreshold(gamesFor(BARKLEY), 'rushing_yards', 75.5);
  assert.equal(t.over + t.under + t.push, t.total);
  assert.equal(t.over_pct, +(100 * t.over / t.total).toFixed(1));
});

test('scrimmage yards grade against the derived per-game total', () => {
  const rows = gamesFor(BARKLEY);
  const t = propThreshold(rows, 'scrimmage_yards', 100);
  const manual = rows.filter(r => (r.ry ?? 0) + (r.recy ?? 0) > 100).length;
  assert.equal(t.over, manual);
});

test('an unsupported market is refused rather than guessed', () => {
  const t = propThreshold(gamesFor(BARKLEY), 'passing_yards', 250);
  assert.equal(t.available, false);
  assert.match(t.reason, /unsupported/);
});

/* ===================== ROUTES ============================================ */

test('the prop lab refuses to work without an event', async () => {
  const r = await call('rb-prop-lab', `player_id=${BARKLEY}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'event_id_required');
});

test('the back response carries the window, the usage block and the disclaimer', async () => {
  const r = await call('rb-dna', `player_id=${BARKLEY}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.history_available, true);
  assert.ok(r.body.usage_dna.career.touches_per_game > 0);
  assert.ok(r.body.usage_dna.withheld.some(w => w.field === 'snap share'));
  assert.equal(r.body.sample.baseline_metric, 'scrimmage_yards');
  assert.equal(r.body.form_series.metric, 'scrimmage_yards');
  assert.ok(r.body.provenance.notes.some(n => /not.*model picks/i.test(n)));
  assert.ok(r.body.player.media.headshot_url, 'identity must carry a real photograph URL');
});

test('the list is ordered by market relevance and every back carries media', async () => {
  const r = await call('rb-dna', 'list=1');
  assert.equal(r.status, 200);
  assert.ok(r.body.count > 200);
  assert.ok(r.body.market_priced_2026 > 50);
  for (const p of r.body.players) {
    assert.ok(p.media, `${p.name} has no media block`);
    assert.equal(typeof p.history_available, 'boolean');
  }
  const priced = r.body.players.findIndex(p => !p.market_priced_2026);
  assert.ok(r.body.players.slice(0, priced).every(p => p.market_priced_2026));
});

test('a back with no NFL history is a 200 saying so, not zeros', async () => {
  const zero = dataset().players.find(p => !gamesFor(p.gsis_id).length);
  if (!zero) return;
  const r = await call('rb-dna', `player_id=${zero.gsis_id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.history_available, false);
  assert.equal(r.body.sample_state, 'NFL SAMPLE UNAVAILABLE');
  assert.equal(r.body.baseline, null);
  assert.equal(r.body.usage_dna, null);
  assert.equal(r.body.nfl_games, 0);
  assert.match(r.body.disclosure, /College/);
});

test('compare reports each back against HIS OWN baseline', async () => {
  const r = await call('rb-compare', `player_a=${BARKLEY}&player_b=${HENRY}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.comparison_metric, 'scrimmage_yards');
  for (const [k, c] of Object.entries(r.body.conditions)) {
    if (!c.available) { assert.ok(c.reason); continue; }
    assert.ok('a_vs_own_baseline' in c && 'b_vs_own_baseline' in c, k);
    assert.ok(c.a.games > 0 && c.b.games > 0, `${k} must carry both Ns`);
    assert.equal(typeof c.rollup, 'boolean', `${k} must declare whether it is a rollup`);
  }
});

test('context mode skips weather for a roofed game and says why', async () => {
  const r = await call('rb-compare', `player_id=${BARKLEY}&roof=dome&temp_f=70&home=false`);
  assert.equal(r.status, 200);
  for (const k of r.body.matched_windows) {
    assert.ok(!CONDITIONS[k].weather, `${k} is a weather window on a roofed game`);
  }
  assert.ok(r.body.unevaluated.some(u => /roofed/.test(u.reason)));
});

test('context mode reads the spread as a market position, not a projection', async () => {
  const r = await call('rb-compare', `player_id=${BARKLEY}&roof=outdoors&home=true&spread=3.5`);
  assert.ok(r.body.matched_windows.includes('favorite'));
  assert.ok(!r.body.matched_windows.includes('underdog'));
  const u = await call('rb-compare', `player_id=${BARKLEY}&roof=outdoors&home=true&spread=-3.5`);
  assert.ok(u.body.matched_windows.includes('underdog'));
});

/* ===================== WINDOW ============================================ */

test('no game in the back dataset postdates the declared window', () => {
  const w = dataWindow();
  for (const p of withHistory()) {
    for (const g of gamesFor(p.gsis_id)) {
      assert.ok(g.d <= w.data_through, `${g.g} on ${g.d} postdates ${w.data_through}`);
    }
  }
  assert.ok(w.seasons_without_play_by_play.includes(2026));
  assert.match(w.note, /Nothing is projected/);
});

/* ===================== LIVE MARKET ======================================= */

test('LIVE: anytime TD carries a signed price, never a fabricated line', async () => {
  const slate = await call('game-context', '');
  const g = (slate.body.games || [])[0];
  if (!g) { console.log('  (no slate available — market assertions skipped)'); return; }
  const r = await call('rb-prop-lab', `player_id=${BARKLEY}&event_id=${g.espn_event_id}`);
  assert.equal(r.status, 200);
  for (const c of r.body.markets) {
    if (!c.available) { assert.equal(c.state, MARKET_UNAVAILABLE); assert.ok(c.reason); continue; }
    if (c.kind === 'price') {
      assert.equal(c.line, null, 'a price must never be presented as a line');
      assert.ok(Number.isFinite(c.market_price));
    } else {
      assert.ok(Number.isFinite(c.line), `${c.market} is offered without a numeric line`);
    }
  }
});
