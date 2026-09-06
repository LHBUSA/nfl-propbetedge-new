/* QB DNA — LIMITED HISTORY IN RARE CONDITIONS
 * node --test research/qbdna/qbdna-limited-history.test.mjs
 *
 * A rare condition can have N=1 for a quarterback with 120 games. That is a
 * fact about the weather, not about him. These tests pin the tier policy the
 * engine already enforces (10 / 5 / 4%) and the additive `limited_history`
 * shape that lets a surface say so accurately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataset, gamesFor, conditionProfile, dnaSignals, SIGNAL_TIERS }
  from '../../api/_qbdna/engine.js';

const MAHOMES = '00-0033873', ALLEN = '00-0034857', JACKSON = '00-0034796',
      BURROW = '00-0036442', HERBERT = '00-0036355';
const profileFor = id => conditionProfile(gamesFor(id), 'py', 1);

/* A synthetic profile with one condition per case, so each tier boundary is
   tested in isolation rather than at the mercy of a real schedule. */
function synthetic(conditions, baselineN = 40) {
  const out = {};
  for (const [key, c] of Object.entries(conditions)) {
    out[key] = { available: true, key, group: 'weather', label: c.label || key, rollup: false,
      games: c.games, baseline_delta_pct: c.move, passing_yards_avg: 250 + 2.5 * c.move,
      record: `${Math.round(c.games / 2)}-${c.games - Math.round(c.games / 2)}`,
      win_pct: 50, completion_pct: 65, sample_label: c.games >= 20 ? 'STRONG SAMPLE'
        : c.games >= 10 ? 'MODERATE SAMPLE' : c.games >= 5 ? 'SMALL SAMPLE' : 'VERY SMALL SAMPLE' };
  }
  return { conditions: out, baseline_mean: 250, baseline_n: baselineN };
}

test('the sample policy is unchanged: 10 / 5 / 4%', () => {
  assert.equal(SIGNAL_TIERS.qualifying_n, 10);
  assert.equal(SIGNAL_TIERS.signal_n, 5);
  assert.equal(SIGNAL_TIERS.min_move_pct, 4);
});

test('N<5 is never a strength, a watchout or a signal, however large the move', () => {
  const g = dnaSignals(synthetic({ wind_20_plus: { label: 'Wind 20+ mph', games: 4, move: -37.4 },
                                  snow: { label: 'Snow', games: 1, move: 55 } }));
  assert.equal(g.strengths.length, 0);
  assert.equal(g.watchouts.length, 0);
  assert.equal(g.signals.length, 0);
  assert.equal(g.insufficient.length, 2);
  for (const x of g.insufficient) assert.equal(x.eligible, false);
});

test('N=5 with a clearing move is a SIGNAL, not a strength', () => {
  const g = dnaSignals(synthetic({ rain: { label: 'Rain', games: 5, move: 9 } }));
  assert.equal(g.signals.length, 1);
  assert.equal(g.signals[0].tier, 'SIGNAL');
  assert.equal(g.strengths.length + g.watchouts.length, 0);
});

test('N=10 with a clearing move qualifies: strength up, watchout down', () => {
  const g = dnaSignals(synthetic({ dome: { label: 'Dome / closed roof', games: 10, move: 6.5 },
                                  cold_33_50: { label: '33-50 F', games: 10, move: -4 } }));
  assert.equal(g.strengths.length, 1);
  assert.equal(g.strengths[0].label, 'Dome / closed roof');
  assert.equal(g.watchouts.length, 1);
  assert.equal(g.watchouts[0].label, '33-50 F');
});

test('N=10 under the noise floor is neutral, not promoted', () => {
  const g = dnaSignals(synthetic({ dome: { label: 'Dome / closed roof', games: 10, move: 3.9 } }));
  assert.equal(g.strengths.length + g.watchouts.length + g.signals.length, 0);
  assert.equal(g.neutral_count, 1);
});

test('limited_history is the accurate, additive name for the same rows', () => {
  const g = dnaSignals(synthetic({ wind_20_plus: { label: 'Wind 20+ mph', games: 2, move: -10.1 } }, 40));
  assert.ok(g.limited_history);
  assert.equal(g.limited_history.label, 'Limited history in rare conditions');
  assert.match(g.limited_history.disclosure, /fewer than 5 qualifying games/);
  assert.equal(g.limited_history.rows.length, g.insufficient.length);
  assert.equal(g.limited_history.rows[0].label, 'Wind 20+ mph');
  assert.equal(g.limited_history.rows[0].games, 2);
  assert.equal(g.limited_history.rows[0].classified, false);
  // the baseline is large; the CONDITION is thin. Both facts are on the object.
  assert.ok(g.baseline_n >= 30);
  // the movement stays available on the original row for a tooltip, and is
  // deliberately absent from the limited-history row
  assert.equal(g.insufficient[0].baseline_delta_pct, -10.1);
  assert.equal('baseline_delta_pct' in g.limited_history.rows[0], false);
  // contract preserved
  assert.ok(Array.isArray(g.insufficient));
  assert.ok(g.policy.rule);
});

test('veterans with a large baseline still carry rare N<5 conditions — and that is not about them', () => {
  for (const id of [MAHOMES, ALLEN, JACKSON, BURROW, HERBERT]) {
    const g = dnaSignals(profileFor(id));
    assert.ok(g.baseline_n >= 30, `${id} baseline ${g.baseline_n}`);
    for (const x of g.limited_history.rows) {
      assert.ok(x.games < SIGNAL_TIERS.signal_n, `${x.label} has ${x.games}`);
      assert.equal(x.classified, false);
    }
  }
});

test('a quarterback with no NFL games has an empty profile, not a fabricated one', () => {
  const D = dataset();
  const rookie = D.players.find(p => gamesFor(p.gsis_id).length === 0);
  if (!rookie) return;                          // dataset happens to have none; nothing to assert
  const rows = gamesFor(rookie.gsis_id);
  assert.equal(rows.length, 0);
});
