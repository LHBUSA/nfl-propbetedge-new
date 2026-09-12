/* The surface cannot re-state the model without the model's own sigma.
 *
 * The Worker snapshot carried spread_sigma. modelEvaluations() in
 * api/pbe-picks.js reshapes the internal response through an explicit allowlist
 * — and that allowlist omitted it. The overlay then found sigma undefined, took
 * its documented fallback, and reported the probability at the EVALUATED line
 * while pairing it with the break-even of the BEST line's price.
 *
 * That combination is not a conservative fallback. It is the one pairing that is
 * not an edge at all: a consensus-line probability against a best-line price.
 * Production showed it plainly on BUF @ HOU — "40.9% cover at -1.5 (evaluated
 * line)" beside a best available of -1 -110.
 *
 * These tests pin the passthrough and the arithmetic that depends on it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalCdf, americanToImpliedProb, SPREAD_SIGMA } from '../pick-math.mjs';

const PICKS_API = readFileSync(new URL('../../../api/pbe-picks.js', import.meta.url), 'utf8');
const OVERLAY = readFileSync(new URL('../../../best-line-model-overlay-v1.js', import.meta.url), 'utf8');

/* Mirrors the overlay's guarded coverAt exactly. The guards matter: pick-math's
 * normalCdf THROWS on a non-finite z, so an absent sigma must be caught before
 * it reaches the maths — which is what makes the fallback a branch rather than
 * an exception. */
/* The overlay's n(): null/undefined/'' become NaN rather than 0, which is what
 * stops an absent latent_margin from being silently read as a pick'em. */
const n = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const coverAt = (margin, line, sigma) => {
  const m = n(margin), l = n(line), sd = n(sigma);
  if (!Number.isFinite(m) || !Number.isFinite(l) || !Number.isFinite(sd) || sd <= 0) return NaN;
  return normalCdf((m + l) / sd);
};
const breakEven = price => (price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100));

/* Live production values, BUF @ HOU, evaluated 2026-09-12. */
const BUF = { latent_margin: -1.67, evaluated_line: -1.5, model_prob: 0.409452, best_line: -1, best_price: -110 };
const HOU = { latent_margin: 1.67, evaluated_line: 1.5, model_prob: 0.590548, best_line: 2, best_price: -113 };

/* ------------------------------------------------------------------ 1, 2 */

test('the Pro model_evaluations payload passes spread_sigma through', () => {
  const fn = PICKS_API.slice(PICKS_API.indexOf('async function modelEvaluations'), PICKS_API.indexOf('async function currentView'));
  assert.match(fn, /spread_sigma: body\?\.spread_sigma \?\? null,/);
  /* It is part of the allowlisted reshape, not accidentally spread in. */
  assert.ok(!fn.includes('...body'), 'the reshape stays an explicit allowlist');
});

test('the public response still carries no model_evaluations at all', () => {
  const preview = PICKS_API.slice(PICKS_API.indexOf('async function previewView'));
  assert.ok(!preview.includes('model_evaluations'), 'public must not receive the model layer');
  assert.ok(!preview.includes('spread_sigma'), 'public must not receive engine dispersion');
  assert.equal((PICKS_API.match(/model_evaluations:/g) || []).length, 1);
});

/* ------------------------------------------------------------------ 3, 4 */

test('BUF best -1 is evaluated at -1, not at the -1.5 consensus line', () => {
  const atBest = coverAt(BUF.latent_margin, BUF.best_line, SPREAD_SIGMA);
  const atEvaluated = coverAt(BUF.latent_margin, BUF.evaluated_line, SPREAD_SIGMA);

  /* The evaluated-line figure is what production wrongly displayed. */
  assert.ok(Math.abs(atEvaluated - BUF.model_prob) < 2e-4, 'the -1.5 figure is the stored 40.9%');
  assert.notEqual(atBest.toFixed(4), atEvaluated.toFixed(4));
  /* Half a point of the hook is worth something and must be visible. */
  assert.ok(atBest > atEvaluated, 'BUF laying half a point less covers more often');
  assert.ok(Math.abs(atBest - atEvaluated) > 0.005, `half a point must move the number, moved ${(atBest - atEvaluated) * 100}pp`);
  assert.ok(Math.abs(atBest - 0.4239) < 2e-3, `cover at -1 ~= 42.4%, got ${(atBest * 100).toFixed(1)}%`);
});

test('HOU best +2 is evaluated at +2, not at the +1.5 consensus line', () => {
  const atBest = coverAt(HOU.latent_margin, HOU.best_line, SPREAD_SIGMA);
  const atEvaluated = coverAt(HOU.latent_margin, HOU.evaluated_line, SPREAD_SIGMA);

  assert.ok(Math.abs(atEvaluated - HOU.model_prob) < 2e-4, 'the +1.5 figure is the stored 59.1%');
  assert.ok(atBest > atEvaluated, 'HOU taking half a point more covers more often');
  assert.ok(Math.abs(atBest - 0.6045) < 2e-3, `cover at +2 ~= 60.5%, got ${(atBest * 100).toFixed(1)}%`);
});

/* ------------------------------------------------------------------ 5 */

test('the "(evaluated line)" fallback only fires when the model state is genuinely absent', () => {
  /* With margin and sigma present, the best line is used. */
  assert.match(OVERLAY, /const c = coverAt\(margin, bestLine, sigma\);/);
  assert.match(OVERLAY, /if \(Number\.isFinite\(c\)\) \{[\s\S]{0,200}cover at \$\{signed\(bestLine\)\}/);
  /* The fallback is the else branch, and it names itself honestly. */
  assert.match(OVERLAY, /cover at \$\{signed\(n\(m\.market_line\)\)\} \(evaluated line\)/);

  /* And it is genuinely unreachable once sigma arrives. */
  assert.ok(Number.isFinite(coverAt(BUF.latent_margin, BUF.best_line, SPREAD_SIGMA)), 'real inputs produce a finite cover probability');
  assert.ok(!Number.isFinite(coverAt(BUF.latent_margin, BUF.best_line, null)), 'a missing sigma is what triggered the fallback');
  assert.ok(!Number.isFinite(coverAt(null, BUF.best_line, SPREAD_SIGMA)), 'a missing margin also triggers it');
});

/* ------------------------------------------------------------------ 6 */

test('EDGE AT BEST is probability at the best LINE minus break-even at the best PRICE', () => {
  for (const row of [BUF, HOU]) {
    const p = coverAt(row.latent_margin, row.best_line, SPREAD_SIGMA);
    const be = breakEven(row.best_price);
    const edge = p - be;

    /* The wrong pairing production displayed: consensus-line probability
     * against best-line price. It must not equal the correct edge. */
    const wrong = coverAt(row.latent_margin, row.evaluated_line, SPREAD_SIGMA) - be;
    assert.notEqual(edge.toFixed(4), wrong.toFixed(4), 'the fixed edge differs from the mispaired one');
    assert.ok(Math.abs(edge - wrong) > 0.005, `the bug was worth ${(Math.abs(edge - wrong) * 100).toFixed(1)}pp`);

    /* Break-even is the engine's own implied probability. */
    assert.ok(Math.abs(be - americanToImpliedProb(row.best_price)) < 1e-12);
  }

  /* Concrete expected production values. */
  const bufEdge = coverAt(BUF.latent_margin, BUF.best_line, SPREAD_SIGMA) - breakEven(BUF.best_price);
  const houEdge = coverAt(HOU.latent_margin, HOU.best_line, SPREAD_SIGMA) - breakEven(HOU.best_price);
  assert.ok(Math.abs(bufEdge - (-0.1002)) < 3e-3, `BUF edge at -1 -110 ~= -10.0pp, got ${(bufEdge * 100).toFixed(1)}pp`);
  assert.ok(Math.abs(houEdge - 0.0741) < 3e-3, `HOU edge at +2 -113 ~= +7.4pp, got ${(houEdge * 100).toFixed(1)}pp`);
});

/* ------------------------------------------------------------------ 7, 8 */

test('moneyline behaviour is untouched — it never needed sigma', () => {
  /* A moneyline probability is number-independent: only the price moves the
   * edge, so the sigma bug could not and did not affect it. */
  const bufMl = 0.451952, houMl = 0.548048;
  assert.ok(Math.abs((bufMl + houMl) - 1) < 1e-6, 'the two sides are complementary');
  for (const price of [121, -121, 145, -159]) {
    const edge = bufMl - breakEven(price);
    assert.ok(Number.isFinite(edge), 'moneyline edge needs only model_prob and price');
  }
  /* Structurally: the moneyline branch uses model_prob directly and never
   * re-states a spread number. */
  const ml = OVERLAY.slice(OVERLAY.indexOf("} else if (market === 'moneyline') {"), OVERLAY.indexOf('/* PBE FAIR stays pure model truth'));
  assert.ok(!ml.includes('coverAt('), 'moneyline must not re-state a spread number');
  assert.ok(!ml.includes('sigma'), 'moneyline must not depend on sigma');
  assert.match(OVERLAY, /let probAtBest = modelProb;/);
});

test('totals remain MODEL DISABLED and never acquire an executable edge', () => {
  assert.match(OVERLAY, /MODEL DISABLED<\/b><small>Dedicated total model required/);
  assert.match(OVERLAY, /NOT MODELED/);
  /* The executable-edge maths sits inside the ELIGIBLE branch only. */
  const eligible = OVERLAY.slice(OVERLAY.indexOf("if (m.integrity_status === 'ELIGIBLE')"), OVERLAY.indexOf('/* No evaluation for this market yet'));
  assert.ok(eligible.includes('EDGE AT BEST'));
  const status = OVERLAY.slice(OVERLAY.indexOf('function statusHtml'), OVERLAY.indexOf('function modelHtml'));
  assert.ok(!status.includes('coverAt('), 'disabled/quarantined rows compute nothing');
});
