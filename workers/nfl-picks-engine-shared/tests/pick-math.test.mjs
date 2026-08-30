/* Canonical decision-math tests. These must pass before any Worker that
 * depends on them is deployed. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  americanToDecimal, americanToImpliedProb, probToAmerican, devigTwoWay, holdPct,
  logistic, scoreFeatures, applyCalibration, modelProbability,
  normalQuantile, probToFairSpread,
  edgeThreshold, qualifies, confidenceBucket, quarterKellyUnits,
  STAKE_CAP, STAKE_FLOOR,
  unitsDelta, brierScore, outcomeBit, clvPoints, clvProb, clvBeat,
  settleSpread, settleTotal, settleMoneyline,
  buildFeatureVector, priorBlendWeight, clampRestDiff, FEATURE_ORDER,
} from '../pick-math.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('american odds convert both directions', () => {
  near(americanToDecimal(-110), 1 + 100 / 110);
  near(americanToDecimal(+150), 2.5);
  near(americanToImpliedProb(-110), 110 / 210);
  near(americanToImpliedProb(+150), 100 / 250);
  assert.equal(probToAmerican(0.5), -100);
  assert.equal(probToAmerican(0.6), -150);
  assert.equal(probToAmerican(0.4), 150);
  assert.throws(() => americanToDecimal(0), /bad_price/);
});

test('de-vig normalises a two-sided market to 1.0', () => {
  const a = devigTwoWay(-110, -110);
  near(a, 0.5);
  const fav = devigTwoWay(-200, +170);
  const dog = devigTwoWay(+170, -200);
  near(fav + dog, 1);
  assert.ok(fav > dog);
  assert.ok(holdPct(-110, -110) > 0);
});

test('a standard -110/-110 market holds about 4.76%', () => {
  // 220/210 - 1 = 0.047619...
  const hold = holdPct(-110, -110);
  assert.ok(hold > 0.0476 && hold < 0.0477, `hold was ${hold}`);
});

test('logistic and feature scoring respect declared feature_order', () => {
  near(logistic(0), 0.5);
  const weights = {
    intercept: 0.1,
    coef: { a: 2, b: -1, unused: 99 },
    meta: { feature_order: ['a', 'b'] },
  };
  // unused is excluded because feature_order does not declare it.
  near(scoreFeatures(weights, { a: 1, b: 1, unused: 1 }), 0.1 + 2 - 1);
});

test('a missing feature scores as absent, a non-numeric one throws', () => {
  const weights = { intercept: 0, coef: { a: 1 }, meta: { feature_order: ['a'] } };
  near(scoreFeatures(weights, {}), 0);
  assert.throws(() => scoreFeatures(weights, { a: 'x' }), /bad_feature:a/);
});

test('calibration shrinks toward 0.5 and 1.0 is a no-op', () => {
  near(applyCalibration(0.8, 1.0), 0.8);
  near(applyCalibration(0.8, 0.5), 0.65);
  near(applyCalibration(0.2, 0.5), 0.35);
  const weights = {
    intercept: 0, coef: { a: 1 }, meta: { feature_order: ['a'] },
    calib: { A: 0.5 },
  };
  const raw = modelProbability(weights, { a: 2 });
  const shrunk = modelProbability(weights, { a: 2 }, 'A');
  assert.ok(shrunk < raw && shrunk > 0.5);
});

test('normal quantile round-trips through the fair-spread conversion', () => {
  near(normalQuantile(0.5), 0, 1e-9);
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-4);
  // A coin-flip cover is a pick-em; a favourite carries a negative number.
  near(probToFairSpread(0.5), -0, 1e-9);
  assert.ok(probToFairSpread(0.65) < 0);
  assert.ok(probToFairSpread(0.35) > 0);
});

test('edge thresholds and buckets follow the brief exactly', () => {
  assert.equal(edgeThreshold('spread'), 0.02);
  assert.equal(edgeThreshold('total'), 0.02);
  assert.equal(edgeThreshold('moneyline'), 0.03);
  assert.throws(() => edgeThreshold('parlay'), /bad_market/);

  assert.equal(qualifies(0.02, 'spread'), true);
  assert.equal(qualifies(0.029, 'moneyline'), false);

  assert.equal(confidenceBucket(0.06, 'spread'), 'A');
  assert.equal(confidenceBucket(0.05, 'spread'), 'A');
  assert.equal(confidenceBucket(0.04, 'spread'), 'B');
  assert.equal(confidenceBucket(0.035, 'spread'), 'B');
  assert.equal(confidenceBucket(0.025, 'spread'), 'C');
  assert.equal(confidenceBucket(0.019, 'spread'), null);
  // A 2.5% edge clears spread but NOT moneyline.
  assert.equal(confidenceBucket(0.025, 'moneyline'), null);
});

test('quarter-Kelly is capped, floored, and refuses a non-positive edge', () => {
  assert.equal(quarterKellyUnits(0.5, -110), 0);      // no edge -> do not bet
  assert.equal(quarterKellyUnits(0.99, +200), STAKE_CAP);
  const modest = quarterKellyUnits(0.53, -110);
  assert.ok(modest >= STAKE_FLOOR && modest <= STAKE_CAP);
});

test('units math is correct for negative and positive prices', () => {
  // unitsDelta rounds to 4dp on purpose so stored units are exact decimals.
  near(unitsDelta(1, -110, 'win'), 100 / 110, 1e-4);
  near(unitsDelta(2, +150, 'win'), 3);
  near(unitsDelta(1.5, -110, 'loss'), -1.5);
  assert.equal(unitsDelta(1.5, -110, 'push'), 0);
  assert.equal(unitsDelta(1.5, -110, 'void'), 0);
  assert.throws(() => unitsDelta(1, -110, 'nonsense'), /bad_result/);
});

test('brier is null on push and void, populated otherwise', () => {
  near(brierScore(0.7, 'win'), 0.09);
  near(brierScore(0.7, 'loss'), 0.49);
  assert.equal(brierScore(0.7, 'push'), null);
  assert.equal(brierScore(0.7, 'void'), null);
  assert.equal(outcomeBit('win'), 1);
  assert.equal(outcomeBit('loss'), 0);
  assert.equal(outcomeBit('push'), null);
});

test('CLV points are signed toward the side we actually took', () => {
  // Favourite: took -2.5, closed -3.5 -> we beat the close by a point.
  near(clvPoints({ market: 'spread', side: 'MIN -2.5', pickLine: -2.5, closeLine: -3.5 }), 1);
  // Underdog: took +2.5, closed +1.5 -> also a point better for us.
  near(clvPoints({ market: 'spread', side: 'MIN +2.5', pickLine: 2.5, closeLine: 1.5 }), 1);
  // Moving against us is negative.
  near(clvPoints({ market: 'spread', side: 'MIN -2.5', pickLine: -2.5, closeLine: -1.5 }), -1);
  // OVER wants the lower number; UNDER wants the higher one.
  near(clvPoints({ market: 'total', side: 'OVER 44.5', pickLine: 44.5, closeLine: 45.5 }), 1);
  near(clvPoints({ market: 'total', side: 'UNDER 44.5', pickLine: 44.5, closeLine: 43.5 }), 1);
  near(clvPoints({ market: 'total', side: 'OVER 44.5', pickLine: 44.5, closeLine: 43.5 }), -1);
  // Moneyline has no line at all.
  assert.equal(clvPoints({ market: 'moneyline', side: 'GB ML', pickLine: null, closeLine: null }), null);
});

test('CLV probability and beat flag', () => {
  near(clvProb({ closingProb: 0.55, pickMarketProb: 0.52 }), 0.03);
  assert.equal(clvBeat(0.03), true);
  assert.equal(clvBeat(-0.01), false);
  assert.equal(clvBeat(null), null);
  assert.equal(clvProb({ closingProb: null, pickMarketProb: 0.5 }), null);
});

test('settlement is deterministic including pushes', () => {
  // Took -3, won by 7 -> covered.
  assert.equal(settleSpread({ pickLine: -3, teamScore: 27, oppScore: 20 }), 'win');
  // Took -3, won by exactly 3 -> push.
  assert.equal(settleSpread({ pickLine: -3, teamScore: 23, oppScore: 20 }), 'push');
  assert.equal(settleSpread({ pickLine: -3, teamScore: 21, oppScore: 20 }), 'loss');
  // Underdog +3 losing by 2 still covers.
  assert.equal(settleSpread({ pickLine: 3, teamScore: 20, oppScore: 22 }), 'win');

  assert.equal(settleTotal({ side: 'OVER 44.5', pickLine: 44.5, homeScore: 24, awayScore: 21 }), 'win');
  assert.equal(settleTotal({ side: 'UNDER 44.5', pickLine: 44.5, homeScore: 24, awayScore: 21 }), 'loss');
  assert.equal(settleTotal({ side: 'OVER 45', pickLine: 45, homeScore: 24, awayScore: 21 }), 'push');

  assert.equal(settleMoneyline({ teamScore: 20, oppScore: 17 }), 'win');
  assert.equal(settleMoneyline({ teamScore: 17, oppScore: 20 }), 'loss');
  assert.equal(settleMoneyline({ teamScore: 20, oppScore: 20 }), 'push');
});

test('prior blend weight decays to zero by week 8', () => {
  assert.equal(priorBlendWeight(1), 1);
  assert.equal(priorBlendWeight(8), 0);
  assert.equal(priorBlendWeight(12), 0);
  const w4 = priorBlendWeight(4);
  assert.ok(w4 > 0 && w4 < 1);
  assert.equal(clampRestDiff(20), 7);
  assert.equal(clampRestDiff(-20), -7);
});

test('feature vector is complete, finite, and exactly the v1 list', () => {
  const v = buildFeatureVector({ off_epa_diff: 0.1, home: true, week: 3, rest_diff: 99 });
  assert.deepEqual(Object.keys(v).sort(), [...FEATURE_ORDER].sort());
  assert.equal(v.home, 1);
  assert.equal(v.dome, 0);
  assert.equal(v.rest_diff, 7);
  for (const name of FEATURE_ORDER) assert.ok(Number.isFinite(v[name]), `${name} not finite`);
  assert.equal(FEATURE_ORDER.length, 12);
});

test('a non-numeric model input cannot silently become a stored feature', () => {
  assert.throws(() => buildFeatureVector({ off_epa_diff: 'oops', week: 1 }), /bad_feature/);
});
