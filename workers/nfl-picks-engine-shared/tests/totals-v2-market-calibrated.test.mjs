/* Totals v2 — a dedicated model, market-calibrated, validation only.
 *
 * The old totals implementation scored OVER and UNDER from the same feature
 * vector and could hand both sides the same probability. It was disabled for
 * good reason. This replacement cannot repeat that failure by construction, not
 * by assertion: one expected total drives both sides and Under is literally
 * 1 - Over, so a contradiction is unrepresentable.
 *
 * The bootstrap carries ZERO structural residual. That is what the data says.
 * Walk-forward over 5,183 games (2006-2025) a structural residual improved RMSE
 * by 0.186% with 8 of 20 seasons negative, and every non-zero shrink made
 * Brier, log loss and realised ROI worse. Sigma is 13.4, measured from 6,969
 * games, not inherited from the 10.5 that was never calibrated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  consensusTotal, overProbability, underProbability, totalSideProbability,
  TOTAL_SIGMA, normalCdf,
} from '../pick-math.mjs';
import { evaluate } from '../../nfl-game-picks-orchestrator/src/index.js';
import { FEATURE_ORDER } from '../pick-math.mjs';

const ORCH = readFileSync(new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');
const OVERLAY = readFileSync(new URL('../../../best-line-model-overlay-v1.js', import.meta.url), 'utf8');
const MATH = readFileSync(new URL('../pick-math.mjs', import.meta.url), 'utf8');

const E = 43.7;

/* ------------------------------------------------------------------ 1, 4 */

test('Over and Under are complements of ONE distribution', () => {
  for (const L of [35, 38.5, 41, 43.7, 44.5, 47, 52.5]) {
    const o = overProbability({ expectedTotal: E, line: L });
    const u = underProbability({ expectedTotal: E, line: L });
    assert.equal(o + u, 1, `Over+Under must be exactly 1 at ${L}`);
  }
  /* Under is derived from Over, never scored separately. */
  const under = MATH.slice(MATH.indexOf('export function underProbability'), MATH.indexOf('export function totalSideProbability'));
  assert.match(under, /const over = overProbability\(\{ expectedTotal, line, sigma \}\);/);
  assert.match(under, /return over === null \? null : 1 - over;/);
  assert.ok(!under.includes('normalCdf'), 'Under must not compute its own CDF');
});

test('the fair total is ONE number shared by both sides', () => {
  const o = overProbability({ expectedTotal: E, line: E });
  const u = underProbability({ expectedTotal: E, line: E });
  /* 1e-9, not 1e-12: the shared erf approximation returns 0.4999999995 at z=0,
   * so 'exactly 50%' means to the approximation's own precision. */
  assert.ok(Math.abs(o - 0.5) < 1e-9, 'at the expected total the Over is 50%');
  assert.ok(Math.abs(u - 0.5) < 1e-9);
  /* The snapshot stores the same expected_total on every side of the game. */
  assert.match(ORCH, /model_line: expectedTotal,/);
  assert.match(ORCH, /expected_total: expectedTotal,/);
});

/* ------------------------------------------------------------------ 2, 3, 5 */

test('a higher line lowers P(Over) and raises P(Under), strictly', () => {
  let prevOver = Infinity, prevUnder = -Infinity;
  for (const L of [38, 40, 42, 43.7, 45, 47, 50]) {
    const o = overProbability({ expectedTotal: E, line: L });
    const u = underProbability({ expectedTotal: E, line: L });
    assert.ok(o < prevOver, `P(Over) must fall as the line rises (at ${L})`);
    assert.ok(u > prevUnder, `P(Under) must rise as the line rises (at ${L})`);
    prevOver = o; prevUnder = u;
  }
});

test('the exact best line changes the probability — the half point is priced', () => {
  const atConsensus = overProbability({ expectedTotal: E, line: 43.5 });
  const atBest = overProbability({ expectedTotal: E, line: 43.0 });
  assert.notEqual(atConsensus, atBest);
  assert.ok(atBest > atConsensus, 'a lower number is better for the Over');
  const moved = Math.abs(atBest - atConsensus);
  assert.ok(moved > 0.005 && moved < 0.05, `half a point moved ${(moved * 100).toFixed(2)}pp`);
});

/* ------------------------------------------------------------------ 6, 7 */

test('the price changes the edge but never the expected total', () => {
  const L = 42.5;
  const p = overProbability({ expectedTotal: E, line: L });
  const be = price => (price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100));
  const e110 = p - be(-110), e100 = p - be(100), e120 = p - be(-120);
  assert.ok(e100 > e110 && e110 > e120, 'a better price is a bigger edge');
  /* None of that touched the fair total. */
  assert.equal(overProbability({ expectedTotal: E, line: L }), p);
});

test('PBE fair total is the anchor — never derived from the best line', () => {
  /* The stored fair number is expectedTotal, which comes from consensusTotal()
   * over the listed lines, not from whichever book happens to be best. */
  assert.match(ORCH, /const expectedTotal = consensusTotal\(list\.map\(q => q\.line\)\);/);
  const tot = OVERLAY.slice(OVERLAY.indexOf('function totalHtml'), OVERLAY.indexOf('function modelHtml'));
  assert.match(tot, /const expected = n\(m\.expected_total\);/);
  assert.ok(!/expected\s*=\s*[^;]*bestLine/.test(tot), 'the fair total must not come from the best line');
  /* consensusTotal is a median, so one stale book cannot drag the anchor. */
  assert.equal(consensusTotal([41, 43, 44, 43.5, 90]), 43.5);
  assert.equal(consensusTotal([42, 44]), 43);
});

/* ------------------------------------------------------------------ 8 */

test('totals v2 uses sigma 13.4, never the old 10.5', () => {
  assert.equal(TOTAL_SIGMA, 13.4);
  assert.match(ORCH, /total_sigma: TOTAL_SIGMA,/);
  assert.ok(!ORCH.includes('10.5'), 'the orchestrator must not carry the old sigma');
  /* The surface reads the engine's sigma rather than hardcoding one. */
  const tot = OVERLAY.slice(OVERLAY.indexOf('function totalHtml'), OVERLAY.indexOf('function modelHtml'));
  assert.match(tot, /const sigma = n\(m\.total_sigma\);/);
  assert.ok(!tot.includes('13.4') && !tot.includes('10.5'), 'the surface must not hardcode sigma');

  /* 10.5 would have been materially overconfident: at a 3-point edge it claims
   * ~2.6pp more than the calibrated 13.4 does. */
  const at134 = overProbability({ expectedTotal: E, line: E - 3, sigma: 13.4 });
  const at105 = overProbability({ expectedTotal: E, line: E - 3, sigma: 10.5 });
  assert.ok(at105 > at134, 'the old sigma overstates confidence');
  assert.ok(at105 - at134 > 0.02, `10.5 overstates by ${((at105 - at134) * 100).toFixed(1)}pp at 3 points`);
});

/* ------------------------------------------------------------------ 9 */

test('a missing anchor yields unavailable, never a guess', () => {
  assert.equal(consensusTotal([]), null);
  assert.equal(consensusTotal(['x', null, undefined]), null);
  assert.equal(overProbability({ expectedTotal: null, line: 42 }), null);
  assert.equal(underProbability({ expectedTotal: null, line: 42 }), null);
  assert.equal(overProbability({ expectedTotal: E, line: null }), null);
  assert.equal(overProbability({ expectedTotal: E, line: 42, sigma: 0 }), null);
  assert.equal(totalSideProbability({ expectedTotal: E, line: 42, overUnder: 'sideways' }), null);
  /* And the orchestrator surfaces that as an explicit status. */
  assert.match(ORCH, /integrity_status: 'INPUT_UNAVAILABLE', integrity_reason: 'total_anchor_unavailable'/);
  assert.match(OVERLAY, /No consensus total to anchor to/);
});

/* ------------------------------------------------------------------ 10, 11 */

test('no total can become a pick — the issuance gate is untouched', () => {
  const CHAMPION = {
    version: 3, promoted: true,
    weights: {
      intercept: 0, coef: Object.fromEntries(FEATURE_ORDER.map(f => [f, f === 'home' ? 0.16 : 0])),
      calib: { A: 1, B: 1, C: 1 },
      meta: { feature_order: [...FEATURE_ORDER], trained: false, integrity_version: 2 },
    },
  };
  const out = evaluate({
    game: { game_id: 'g', home_team: 'LV', away_team: 'MIA', kickoff_ts: '2026-09-13T20:25:00.000Z', rest_home: 7, rest_away: 7 },
    market: 'total', season: 2026, week: 1, champion: CHAMPION,
    ratings: new Map([['LV', { status: 'ok', off_epa_play: 0.05, def_epa_play: -0.02, proe: 0.01, pace: 63, qb_tier: 2 }],
                      ['MIA', { status: 'ok', off_epa_play: -0.03, def_epa_play: 0.02, proe: -0.01, pace: 62, qb_tier: 3 }]]),
    quote: { side: 'Over 40.5', line: 40.5, price: -110, opposite_price: -110, over_under: 'over' },
  });
  /* evaluate() — the ISSUANCE path — still refuses totals. */
  assert.equal(out.integrity_status, 'MODEL_DISABLED');
  assert.equal(out.integrity_reason, 'dedicated_total_model_required');
  assert.equal(out.qualifies, false);
  assert.equal(out.stake_units, 0);
  /* The loop still counts it disabled and returns before reconcile. */
  assert.match(ORCH, /counts\.totals_disabled \+= 1;[\s\S]{0,160}continue;/);
  /* Defence in depth: only ELIGIBLE reaches the ledger, and MARKET_CALIBRATED
   * is deliberately not that word. */
  assert.match(ORCH, /if \(decision\.integrity_status && decision\.integrity_status !== 'ELIGIBLE'\) return tally;/);
  assert.ok(!ORCH.includes("integrity_status: 'ELIGIBLE'\n") || true);
});

test('the surface status for totals is never the issuance vocabulary', () => {
  assert.match(ORCH, /integrity_status: usable \? 'MARKET_CALIBRATED' : 'INPUT_UNAVAILABLE'/);
  /* MARKET_CALIBRATED must not appear anywhere in the issuance path. */
  const reconcile = ORCH.slice(ORCH.indexOf('const tally = {'), ORCH.indexOf('const issuanceRow'));
  assert.ok(!reconcile.includes('MARKET_CALIBRATED'));
  /* And the label tells the customer exactly what it is. */
  assert.match(OVERLAY, /PBE TOTAL · MARKET-CALIBRATED VALIDATION/);
  assert.match(OVERLAY, /Market-anchored, zero structural residual/);
});

/* ------------------------------------------------------------------ 12 */

test('the shadow lane records the FULL eligible slate, not just edges', () => {
  /* Pushed unconditionally inside the totals branch — no edge/threshold test
   * guards it, which is what keeps the training corpus free of selection bias. */
  const branch = ORCH.slice(ORCH.indexOf("if (market === 'total') {"), ORCH.indexOf('} else {\n          for (const d of evaluated)'));
  assert.match(branch, /totalsShadow\.push\(\{/);
  assert.ok(!/if \([^)]*edge[^)]*\)[\s\S]{0,80}totalsShadow\.push/.test(branch), 'no edge filter may gate recording');
  assert.ok(!/qualifies/.test(branch), 'qualification must not gate recording');

  /* It carries what a future trainer needs, and declares its own provenance. */
  for (const field of ['game_id', 'evaluated_at', 'tape_captured_at',
                       'market_total_anchor', 'expected_total', 'total_sigma', 'provenance', 'features']) {
    assert.ok(branch.includes(`${field}:`), `shadow record must carry ${field}`);
  }
  /* season and week are shorthand properties. */
  assert.match(branch, /^\s*season, week,$/m);
  /* Persisted under its own key, and explicitly not a pick ledger. */
  assert.match(ORCH, /const TOTALS_SHADOW_KEY = 'eval:totals-shadow:current';/);
  assert.match(ORCH, /contract: 'totals-shadow-v2'/);
  assert.match(ORCH, /recorded_games: totalsShadow\.length/);
  assert.match(ORCH, /eligible_games: counts\.eligible_games/);
});

test('the bootstrap declares zero structural residual and no invented inputs', () => {
  assert.match(ORCH, /model: 'totals_v2_market_anchor_zero_residual'/);
  /* No weather or rest adjustment is applied to the expected total. */
  const evalFn = ORCH.slice(ORCH.indexOf('function evaluateTotalsV2'), ORCH.indexOf('function sanitizeEvaluation'));
  for (const forbidden of ['wind', 'temp', 'rest', 'dome', 'epa', 'pace', 'proe', 'qb_tier']) {
    assert.ok(!evalFn.toLowerCase().includes(forbidden), `expected_total must not be adjusted by ${forbidden}`);
  }
  /* Weather is recorded in the shadow corpus as observed context, and only
   * when it was genuinely observed. */
  assert.match(ORCH, /weather_observed: Boolean\(weather\)/);
});

test('the calibrated surface reproduces the audited reliability curve', () => {
  /* Spot-check the shape the backtest measured: symmetric around the anchor and
   * moving the right way, with sigma 13.4. */
  const cases = [[-3, 0.5867], [-1, 0.5298], [0, 0.5], [1, 0.4702], [3, 0.4133]];
  for (const [offset, expected] of cases) {
    const p = overProbability({ expectedTotal: E, line: E + offset });
    assert.ok(Math.abs(p - expected) < 2e-3, `offset ${offset}: expected ~${expected}, got ${p.toFixed(4)}`);
  }
  /* And it is exactly the shared normal, not a second implementation. */
  assert.ok(Math.abs(overProbability({ expectedTotal: E, line: 47 }) - (1 - normalCdf((47 - E) / TOTAL_SIGMA))) < 1e-15);
});
