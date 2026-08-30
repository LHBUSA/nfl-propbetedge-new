/* PropBetEdge NFL Picks Engine — canonical decision math.
 *
 * ONE copy, imported by all four Workers via a relative path. Wrangler's
 * bundler follows it. This is deliberate: the grader must be deterministic and
 * idempotent, and four hand-copied de-vig implementations would drift and make
 * that impossible to prove.
 *
 * Every function here is pure. No I/O, no clock, no randomness.
 */

/* ---------------------------------------------------------------------------
 * American odds
 * ------------------------------------------------------------------------ */

export function americanToDecimal(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p === 0) throw new Error('bad_price');
  return p > 0 ? 1 + p / 100 : 1 + 100 / Math.abs(p);
}

export function americanToImpliedProb(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p === 0) throw new Error('bad_price');
  return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
}

export function probToAmerican(prob) {
  const p = Number(prob);
  if (!(p > 0 && p < 1)) throw new Error('bad_prob');
  return p >= 0.5
    ? -Math.round((100 * p) / (1 - p))
    : Math.round((100 * (1 - p)) / p);
}

/* Remove the vig from a two-sided market by normalising the implied
 * probabilities so they sum to 1. Returns the fair probability of `price`
 * given its opposite side `oppositePrice`. */
export function devigTwoWay(price, oppositePrice) {
  const a = americanToImpliedProb(price);
  const b = americanToImpliedProb(oppositePrice);
  const total = a + b;
  if (!(total > 0)) throw new Error('bad_market');
  return a / total;
}

export function holdPct(price, oppositePrice) {
  return americanToImpliedProb(price) + americanToImpliedProb(oppositePrice) - 1;
}

/* ---------------------------------------------------------------------------
 * Model
 * ------------------------------------------------------------------------ */

export function logistic(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/* w.x + intercept, driven by the weight row's own feature_order so a pick is
 * always scored with exactly the vector its model version declares. */
export function scoreFeatures(weights, features) {
  const coef = weights?.coef || {};
  const order = weights?.meta?.feature_order || Object.keys(coef);
  let z = Number(weights?.intercept || 0);
  for (const name of order) {
    const c = Number(coef[name] || 0);
    const x = Number(features?.[name] || 0);
    if (!Number.isFinite(c) || !Number.isFinite(x)) throw new Error(`bad_feature:${name}`);
    z += c * x;
  }
  return z;
}

/* Calibration shrinkage pulls a stated probability toward 0.5. factor 1.0 is
 * a no-op; the tuner lowers it when a bucket is overconfident. */
export function applyCalibration(prob, factor) {
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) return prob;
  return 0.5 + (prob - 0.5) * f;
}

export function modelProbability(weights, features, bucket) {
  const raw = logistic(scoreFeatures(weights, features));
  const factor = bucket ? weights?.calib?.[bucket] : undefined;
  return factor === undefined ? raw : applyCalibration(raw, factor);
}

/* ---------------------------------------------------------------------------
 * Normal quantile — Acklam's rational approximation. Used for prob <-> fair
 * line conversion on spreads and totals.
 * ------------------------------------------------------------------------ */

const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
           1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
           6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
           -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
           3.754408661907416e+00];

export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error('bad_prob');
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
           ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
            ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q /
         (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
}

/* NFL margin-of-victory and total dispersion. Public, well-established values;
 * they are model constants, not tuned parameters. */
export const SPREAD_SIGMA = 13.86;
export const TOTAL_SIGMA = 10.5;

/* Fair spread for the side whose cover probability is `prob`, expressed the
 * way the side is written (favourite negative). */
export function probToFairSpread(prob, sigma = SPREAD_SIGMA) {
  return -normalQuantile(prob) * sigma;
}

/* Fair total for an OVER whose hit probability is `prob`, relative to the
 * model's expected total. */
export function probToFairTotalOffset(prob, sigma = TOTAL_SIGMA) {
  return -normalQuantile(prob) * sigma;
}

/* ---------------------------------------------------------------------------
 * Thresholds, buckets, sizing
 * ------------------------------------------------------------------------ */

export const EDGE_THRESHOLD = { spread: 0.020, total: 0.020, moneyline: 0.030 };
export const KILL_THRESHOLD = 0.010;
export const STAKE_CAP = 2.0;
export const STAKE_FLOOR = 0.5;

export function edgeThreshold(market) {
  const t = EDGE_THRESHOLD[market];
  if (t === undefined) throw new Error(`bad_market:${market}`);
  return t;
}

export function qualifies(edge, market) {
  return Number(edge) >= edgeThreshold(market);
}

/* A >= 5%, B >= 3.5%, C >= the market's own threshold. Returns null when the
 * edge does not clear the threshold at all. */
export function confidenceBucket(edge, market) {
  const e = Number(edge);
  if (!qualifies(e, market)) return null;
  if (e >= 0.05) return 'A';
  if (e >= 0.035) return 'B';
  return 'C';
}

/* Quarter-Kelly on the de-vigged price, expressed in units where 1 unit = 1%
 * of bankroll. Hard cap 2.0, floor 0.5. Returns 0 when Kelly itself is
 * non-positive, which the caller must treat as "do not bet". */
export function quarterKellyUnits(modelProb, price) {
  const p = Number(modelProb);
  if (!(p > 0 && p < 1)) throw new Error('bad_prob');
  const b = americanToDecimal(price) - 1;
  if (!(b > 0)) throw new Error('bad_price');
  const full = (b * p - (1 - p)) / b;
  if (!(full > 0)) return 0;
  const units = (full / 4) * 100;
  return Math.min(STAKE_CAP, Math.max(STAKE_FLOOR, Number(units.toFixed(4))));
}

/* ---------------------------------------------------------------------------
 * Grading
 * ------------------------------------------------------------------------ */

export function unitsDelta(stakeUnits, price, result) {
  const stake = Number(stakeUnits);
  if (!Number.isFinite(stake) || stake < 0) throw new Error('bad_stake');
  if (result === 'push' || result === 'void') return 0;
  if (result === 'loss') return -Number(stake.toFixed(4));
  if (result !== 'win') throw new Error(`bad_result:${result}`);
  const p = Number(price);
  const profit = p > 0 ? stake * (p / 100) : stake * (100 / Math.abs(p));
  return Number(profit.toFixed(4));
}

export function brierScore(modelProb, result) {
  if (result === 'push' || result === 'void') return null;
  const outcome = result === 'win' ? 1 : 0;
  const p = Number(modelProb);
  if (!(p >= 0 && p <= 1)) throw new Error('bad_prob');
  return Number(((p - outcome) ** 2).toFixed(6));
}

export function outcomeBit(result) {
  if (result === 'win') return 1;
  if (result === 'loss') return 0;
  return null;
}

/* Closing line value in points, signed so positive always means the market
 * moved toward the side we took.
 *
 *   spread : we took MIN -2.5, close MIN -3.5 -> we beat the close by 1.0
 *   over   : we took 44.5, close 45.5         -> we bought the lower number
 *   under  : we took 44.5, close 43.5         -> we sold the higher number
 *
 * Moneyline has no line; callers must use clv_prob alone and store null here.
 */
/* Number(null) is 0, so a missing line would otherwise compute a confident
 * wrong CLV instead of reporting "unknown". Absent means absent. */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clvPoints({ market, side, pickLine, closeLine }) {
  if (market === 'moneyline') return null;
  const pick = finiteOrNull(pickLine), close = finiteOrNull(closeLine);
  if (pick === null || close === null) return null;
  if (market === 'spread') return Number((pick - close).toFixed(4));
  if (market === 'total') {
    const isOver = /^over\b/i.test(String(side || '').trim());
    return Number((isOver ? close - pick : pick - close).toFixed(4));
  }
  throw new Error(`bad_market:${market}`);
}

/* Positive means the de-vigged closing probability of our side is higher than
 * the price we actually took — the market agreed with us after the fact. */
export function clvProb({ closingProb, pickMarketProb }) {
  const c = finiteOrNull(closingProb), m = finiteOrNull(pickMarketProb);
  if (c === null || m === null) return null;
  return Number((c - m).toFixed(6));
}

export function clvBeat(clvProbValue) {
  return clvProbValue === null ? null : clvProbValue > 0;
}

/* ---------------------------------------------------------------------------
 * Settlement from authoritative final scores. Deterministic and total.
 * ------------------------------------------------------------------------ */

export function settleSpread({ side, pickLine, teamScore, oppScore }) {
  const margin = Number(teamScore) - Number(oppScore);
  const adjusted = margin + Number(pickLine);
  if (adjusted > 0) return 'win';
  if (adjusted < 0) return 'loss';
  return 'push';
}

export function settleTotal({ side, pickLine, homeScore, awayScore }) {
  const total = Number(homeScore) + Number(awayScore);
  const line = Number(pickLine);
  if (total === line) return 'push';
  const isOver = /^over\b/i.test(String(side || '').trim());
  const wentOver = total > line;
  return wentOver === isOver ? 'win' : 'loss';
}

export function settleMoneyline({ teamScore, oppScore }) {
  const a = Number(teamScore), b = Number(oppScore);
  if (a > b) return 'win';
  if (a < b) return 'loss';
  return 'push';
}

/* ---------------------------------------------------------------------------
 * Feature vector. Exactly the brief's v1 list — no more.
 * ------------------------------------------------------------------------ */

export const FEATURE_ORDER = Object.freeze([
  'off_epa_diff', 'def_epa_diff', 'qb_tier_diff', 'rest_diff', 'home', 'dome',
  'wind15', 'cold25', 'proe_diff', 'pace_sum', 'line_move', 'prior_blend_weight',
]);

export function clampRestDiff(days) {
  const d = Number(days) || 0;
  return Math.max(-7, Math.min(7, d));
}

/* Weeks 1-8 only: 1.0 at week 1 decaying linearly to 0 by week 8. */
export function priorBlendWeight(week) {
  const w = Number(week);
  if (!Number.isFinite(w) || w >= 8) return 0;
  if (w <= 1) return 1;
  return Number(((8 - w) / 7).toFixed(6));
}

/* Builds the immutable snapshot. Every declared feature is present and finite;
 * a missing input is an explicit 0, never undefined, so the stored vector can
 * always be replayed by the tuner. */
export function buildFeatureVector(input) {
  const v = {
    off_epa_diff: Number(input.off_epa_diff || 0),
    def_epa_diff: Number(input.def_epa_diff || 0),
    qb_tier_diff: Number(input.qb_tier_diff || 0),
    rest_diff: clampRestDiff(input.rest_diff),
    home: input.home ? 1 : 0,
    dome: input.dome ? 1 : 0,
    wind15: input.wind15 ? 1 : 0,
    cold25: input.cold25 ? 1 : 0,
    proe_diff: Number(input.proe_diff || 0),
    pace_sum: Number(input.pace_sum || 0),
    line_move: Number(input.line_move || 0),
    prior_blend_weight: priorBlendWeight(input.week),
  };
  for (const name of FEATURE_ORDER) {
    if (!Number.isFinite(v[name])) throw new Error(`bad_feature:${name}`);
  }
  return v;
}
