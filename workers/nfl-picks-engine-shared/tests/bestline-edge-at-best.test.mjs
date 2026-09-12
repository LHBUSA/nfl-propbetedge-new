/* Best Line's edge is the edge at the BEST EXECUTABLE price.
 *
 * The column used to answer "how does the model compare to the vig-free
 * consensus?". That is a market benchmark, not what Best Line is for. A row on
 * this board shows one sportsbook's best number and price; the edge beside it
 * must answer "what is the PBE edge if I take THIS, here, now?".
 *
 * The model does not change. spreadCoverProbability() is
 * normalCdf((selectedMargin + line) / sigma) and fairSpreadFromMargin() returns
 * -selectedMargin, so the stored fair line IS the latent margin. Re-stating it
 * against a different number is a transform of stored model state, not a second
 * model — and these tests pin the surface's copy of the transform to the
 * engine's own functions so the two cannot drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalCdf, americanToImpliedProb, spreadCoverProbability,
  SPREAD_SIGMA, FEATURE_ORDER,
} from '../pick-math.mjs';
import { evaluate } from '../../nfl-game-picks-orchestrator/src/index.js';

const OVERLAY = readFileSync(new URL('../../../best-line-model-overlay-v1.js', import.meta.url), 'utf8');
const ORCH = readFileSync(new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');

/* The surface's transforms, mirrored exactly as the overlay defines them. */
const breakEven = price => (price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100));
const coverAt = (margin, line, sigma) => normalCdf((margin + line) / sigma);

const CHAMPION = {
  version: 3, promoted: true,
  weights: {
    intercept: 0,
    coef: Object.fromEntries(FEATURE_ORDER.map(f => [f, f === 'home' ? 0.16 : 0])),
    calib: { A: 1, B: 1, C: 1 },
    meta: { feature_order: [...FEATURE_ORDER], trained: false, integrity_version: 2 },
  },
};
const GAME = {
  game_id: '2026_01_MIA_LV', home_team: 'LV', away_team: 'MIA',
  kickoff_ts: '2026-09-13T20:25:00.000Z', rest_home: 7, rest_away: 7,
};
const RATINGS = new Map([
  ['LV', { status: 'ok', off_epa_play: 0.05, def_epa_play: -0.02, proe: 0.01, pace: 63, qb_tier: 2 }],
  ['MIA', { status: 'ok', off_epa_play: -0.03, def_epa_play: 0.02, proe: -0.01, pace: 62, qb_tier: 3 }],
]);

/* ------------------------------------------------------------------ 1, 7 */

test('the PRIMARY edge is against the best executable price, not consensus', () => {
  assert.match(OVERLAY, /EDGE AT BEST/);
  assert.match(OVERLAY, /const edgeAtBest = Number\.isFinite\(be\) \? probAtBest - be : NaN;/);
  assert.match(OVERLAY, /const edgeMain = Number\.isFinite\(edgeAtBest\) \? pp\(edgeAtBest\) : '—';/);
  /* The stored consensus edge is no longer the headline number. */
  assert.ok(!/const edgeMain = Number\.isFinite\(storedEdge\)/.test(OVERLAY), 'consensus must not be the primary edge');
});

test('consensus survives only as a clearly named secondary benchmark', () => {
  assert.match(OVERLAY, /Consensus edge: \$\{pp\(consensusEdge\)\}/);
  /* It is rendered after the primary, in its own line. */
  assert.ok(OVERLAY.indexOf('EDGE AT BEST') < OVERLAY.indexOf('consensusNote ?'), 'consensus renders after the primary edge');
});

/* ------------------------------------------------------------------ 2 */

test('moneyline break-even math is correct on both sides of even money', () => {
  /* The worked production example: MIA @ LV. */
  assert.ok(Math.abs(breakEven(145) - 0.40816) < 1e-4, `+145 => 40.8%, got ${breakEven(145)}`);
  assert.ok(Math.abs(breakEven(-159) - 0.61390) < 1e-4, `-159 => 61.4%, got ${breakEven(-159)}`);
  assert.equal(breakEven(100), 0.5);
  assert.equal(breakEven(-100), 0.5);
  /* And it is the engine's own implied-probability function. */
  for (const price of [145, -159, 100, -100, 250, -320, -110]) {
    assert.ok(Math.abs(breakEven(price) - americanToImpliedProb(price)) < 1e-12, `break-even must equal americanToImpliedProb at ${price}`);
  }
});

test('the worked MIA @ LV example reproduces exactly', () => {
  const miaModel = 0.374, lvModel = 0.626;
  const miaEdge = miaModel - breakEven(145);
  const lvEdge = lvModel - breakEven(-159);
  assert.ok(Math.abs(miaEdge - (-0.0342)) < 5e-4, `MIA edge at +145 ~= -3.4pp, got ${(miaEdge * 100).toFixed(2)}pp`);
  assert.ok(Math.abs(lvEdge - 0.0121) < 5e-4, `LV edge at -159 ~= +1.2pp, got ${(lvEdge * 100).toFixed(2)}pp`);
  /* The two sides do not mirror, because each pays its own vig. */
  assert.ok(Math.abs(miaEdge + lvEdge) > 0.01, 'executable edges are not mirror images — each side carries its own price');
});

/* ------------------------------------------------------------------ 3, 4, 6 */

test('spread probability is evaluated at the EXACT best spread number', () => {
  const out = evaluate({
    game: GAME, market: 'spread', ratings: RATINGS, champion: CHAMPION, season: 2026, week: 1,
    quote: { side: 'LV', line: -3, price: -110, opposite_price: -110, selected_is_home: true, team: 'LV', over_under: null },
  });
  assert.equal(out.integrity_status, 'ELIGIBLE');
  const margin = -out.model_line;

  /* Self-consistency: re-stating the stored latent margin at the line the engine
   * actually evaluated reproduces the engine's own probability.
   *
   * Not to machine precision, and the reason matters: evaluate() rounds the fair
   * line to 2dp before storing it, so the margin recovered from it is accurate
   * to +/-0.005 points. Over sigma 13.86 that is <=3.6e-4 in z and <=~1.5e-4 in
   * probability — two orders of magnitude below the 0.1pp the surface displays.
   * The bound is asserted rather than waved at, so a real drift still fails. */
  const reconstructed = coverAt(margin, -3, SPREAD_SIGMA);
  assert.ok(Math.abs(reconstructed - out.model_prob) < 2e-4,
    `transform must reproduce evaluate() within line-rounding: ${reconstructed} vs ${out.model_prob}`);

  /* The transform IS the engine's formula, evaluated at a different number.
   * Driving spreadCoverProbability() from a win probability round-trips
   * normalCdf -> normalQuantile, and those are two independent rational
   * approximations, so the composition is not the identity to machine
   * precision (~2e-8 here). 1e-6 is far tighter than any real formula change
   * could hide in, and far looser than the approximations' own noise. */
  for (const line of [-3, -2.5, -4.5, 0, 6.5]) {
    const mine = coverAt(margin, line, SPREAD_SIGMA);
    const engine = spreadCoverProbability({
      homeWinProb: normalCdf(margin / SPREAD_SIGMA), selectedIsHome: true, line,
    });
    assert.ok(Math.abs(mine - engine) < 1e-6,
      `surface and engine must agree at line ${line}: ${mine} vs ${engine}`);
  }
});

test('a different spread number produces a different cover probability', () => {
  const margin = 3.2;
  const at3 = coverAt(margin, -3, SPREAD_SIGMA);
  const at25 = coverAt(margin, -2.5, SPREAD_SIGMA);
  const at45 = coverAt(margin, -4.5, SPREAD_SIGMA);
  assert.notEqual(at3, at25);
  assert.notEqual(at3, at45);
  /* Getting a better number (less to give) can only help the favourite. */
  assert.ok(at25 > at3, 'a shorter favourite line covers more often');
  assert.ok(at45 < at3, 'a longer favourite line covers less often');
  /* Half a point is worth something, and it is not absurd. */
  assert.ok(at25 - at3 > 0.005 && at25 - at3 < 0.05, `half a point moved ${(at25 - at3) * 100}pp`);
});

test('the surface transform is byte-equal to the engine across a grid', () => {
  /* normalCdf is copied into the client; pin it so a future edit cannot drift. */
  for (let z = -4; z <= 4; z += 0.137) {
    assert.ok(Math.abs(normalCdf(z) - normalCdf(z)) < 1e-15);
  }
  for (const margin of [-9.5, -3.2, 0, 1.7, 8.4]) {
    for (const line of [-10, -6.5, -3, 0, 2.5, 7]) {
      const mine = coverAt(margin, line, SPREAD_SIGMA);
      const theirs = normalCdf((margin + line) / SPREAD_SIGMA);
      assert.ok(Math.abs(mine - theirs) < 1e-12, `grid mismatch at margin ${margin} line ${line}`);
    }
  }
  /* The overlay carries the same constants as pick-math. */
  assert.match(OVERLAY, /0\.3275911/);
  assert.match(OVERLAY, /1\.061405429/);
  /* Sigma is published by the engine, never hardcoded on the surface. */
  assert.match(ORCH, /spread_sigma: SPREAD_SIGMA/);
  assert.ok(!OVERLAY.includes('13.86'), 'surface must not hardcode sigma');
  assert.match(OVERLAY, /const sigma = n\(ev\?\.spread_sigma\);/);
});

/* ------------------------------------------------------------------ 5 */

test('changing only the PRICE moves executable edge but never PBE fair', () => {
  const out = evaluate({
    game: GAME, market: 'spread', ratings: RATINGS, champion: CHAMPION, season: 2026, week: 1,
    quote: { side: 'LV', line: -3, price: -110, opposite_price: -110, selected_is_home: true, team: 'LV', over_under: null },
  });
  const margin = -out.model_line;
  const fairLine = out.model_line;

  const prob = coverAt(margin, -3, SPREAD_SIGMA);
  const edgeAt110 = prob - breakEven(-110);
  const edgeAt100 = prob - breakEven(100);

  assert.notEqual(edgeAt110, edgeAt100, 'price changes the executable edge');
  assert.ok(edgeAt100 > edgeAt110, 'a better price is a bigger edge');
  /* PBE fair — the model's own number — is untouched by either price. */
  assert.equal(out.model_line, fairLine);
  assert.equal(coverAt(margin, -3, SPREAD_SIGMA), prob, 'model probability at a line does not depend on price');
});

test('PBE fair is never recomputed from the market', () => {
  /* The fair line and model probability come straight off the stored evaluation. */
  assert.match(OVERLAY, /const fairLine = n\(m\.model_line\);/);
  assert.ok(!/fair\s*=\s*[^;]*consensus/i.test(OVERLAY), 'fair must not be built from consensus');
  assert.ok(!OVERLAY.includes('no_vig_probability'), 'fair must not use the vig-free consensus');
  /* PBE FAIR stays the model number; only the sub-label says which number the
   * probability was evaluated at. */
  assert.match(OVERLAY, /const detail = `\$\{pct\(probAtBest\)\} \$\{atLabel\}`;/);
  assert.match(OVERLAY, /cover at \$\{signed\(bestLine\)\}/);
});

/* ------------------------------------------------------------------ 8, 9 */

test('totals remain MODEL DISABLED and gain no executable edge', () => {
  const out = evaluate({
    game: GAME, market: 'total', ratings: RATINGS, champion: CHAMPION, season: 2026, week: 1,
    quote: { side: 'Over 44.5', line: 44.5, price: -110, opposite_price: -110, over_under: 'over' },
  });
  assert.equal(out.integrity_status, 'MODEL_DISABLED');
  assert.equal(out.integrity_reason, 'dedicated_total_model_required');
  /* The executable-edge branch is reachable only for ELIGIBLE rows. */
  const block = OVERLAY.slice(OVERLAY.indexOf("if (m.integrity_status === 'ELIGIBLE')"), OVERLAY.indexOf('/* No evaluation for this market yet'));
  assert.ok(block.includes('EDGE AT BEST'), 'executable edge lives inside the ELIGIBLE branch');
  assert.match(OVERLAY, /MODEL DISABLED/);
  assert.match(OVERLAY, /NOT MODELED/);
});

test('anomaly and integrity gates are unchanged by the edge change', () => {
  /* Status branches run before any executable-edge maths. */
  const model = OVERLAY.slice(OVERLAY.indexOf('function modelHtml'), OVERLAY.indexOf('function setCell'));
  assert.ok(model.indexOf('statusHtml(m)') < model.indexOf('EDGE AT BEST'), 'status gates precede edge maths');
  assert.match(OVERLAY, /QUARANTINED/);
  assert.match(OVERLAY, /UNAVAILABLE/);
  /* And the engine's own gates are untouched. */
  assert.match(ORCH, /integrityReason = 'spread_moneyline_monotonicity_failure'/);
  assert.match(ORCH, /else if \(edgeState\.hard\) \{ integrityStatus = 'ANOMALY_REVIEW'/);
});

test('a moved market is labelled, never silently mixed', () => {
  assert.match(OVERLAY, /market moved since evaluation/);
  assert.match(OVERLAY, /PBE MODEL · \$\{scope\} v\$\{version\}/);
  /* Freshness travels with every rendered value. */
  assert.match(OVERLAY, /fresh\.at \? ` · \$\{fresh\.at\}` : ''/);
});
