import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gateStatus, holdoutSplit, blendedLabel, trainSelector,
  qualityProbability, backtestSelector, promotionVerdict,
} from '../workers/nfl-prop-picks-tuner/src/index.js';
import { SELECTOR_FEATURE_ORDER } from '../workers/nfl-prop-picks-shared/prop-math.mjs';

function observation(i, overrides = {}) {
  const features = Object.fromEntries(SELECTOR_FEATURE_ORDER.map((name, index) => [name, ((i + index) % 10) / 10]));
  return {
    season: 2026,
    week: (i % 4) + 1,
    finalized_at: new Date(Date.UTC(2026, 8, 10 + i)).toISOString(),
    features,
    clv_beat: i % 3 !== 0,
    outcome: i % 2,
    units_delta: i % 2 ? 0.9 : -1,
    ...overrides,
  };
}

test('prop tuner hard gate requires both 100 finals and four weeks', () => {
  const ninetyNine = Array.from({ length: 99 }, (_, i) => observation(i));
  assert.equal(gateStatus(ninetyNine).open, false);
  const oneWeek = Array.from({ length: 100 }, (_, i) => observation(i, { week: 1 }));
  assert.equal(gateStatus(oneWeek).open, false);
  const ready = Array.from({ length: 100 }, (_, i) => observation(i));
  assert.equal(gateStatus(ready).open, true);
});

test('chronological holdout keeps newest 20 percent out of training', () => {
  const rows = Array.from({ length: 100 }, (_, i) => observation(i));
  const split = holdoutSplit(rows);
  assert.equal(split.train.length, 80);
  assert.equal(split.test.length, 20);
  assert.equal(split.train.at(-1).finalized_at, rows[79].finalized_at);
  assert.equal(split.test[0].finalized_at, rows[80].finalized_at);
});

test('training label is 70 percent CLV and 30 percent outcome when both exist', () => {
  assert.equal(blendedLabel({ clv_beat: true, outcome: 0 }), 0.7);
  assert.equal(blendedLabel({ clv_beat: false, outcome: 1 }), 0.3);
  assert.equal(blendedLabel({ clv_beat: true, outcome: null }), 1);
});

test('trained selector produces finite deterministic quality probability', () => {
  const rows = Array.from({ length: 80 }, (_, i) => observation(i));
  const model = trainSelector(rows);
  assert.equal(model.feature_order.length, SELECTOR_FEATURE_ORDER.length);
  assert.ok(Object.values(model.coef).every(Number.isFinite));
  const p = qualityProbability(model, rows[0].features);
  assert.ok(p > 0 && p < 1);
  assert.equal(p, qualityProbability(model, rows[0].features));
});

test('seed champion backtest selects all holdout rows', () => {
  const rows = Array.from({ length: 20 }, (_, i) => observation(i));
  const score = backtestSelector(null, rows, 0.55);
  assert.equal(score.selected, 20);
});

test('promotion requires meaningful selected sample', () => {
  const verdict = promotionVerdict(
    { selected: 3, clv_beat_pct: 90, brier: 0.1 },
    { selected: 20, clv_beat_pct: 50, brier: 0.25 },
    20,
  );
  assert.equal(verdict.promote, false);
  assert.match(verdict.reason, /selected_sample_too_small/);
});

test('promotion accepts a challenger that clears holdout CLV by a full point', () => {
  const verdict = promotionVerdict(
    { selected: 15, clv_beat_pct: 61.5, brier: 0.20 },
    { selected: 20, clv_beat_pct: 60.0, brier: 0.22 },
    20,
  );
  assert.equal(verdict.promote, true);
});
