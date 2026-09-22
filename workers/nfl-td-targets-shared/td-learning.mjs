/* PropBetEdge NFL — PBE Touchdown Targets learning stage.
 *
 * WHAT LEARNS, AND WHAT IT IS ALLOWED TO CHANGE
 *
 * The committed artefact (pbe-td-hazard-v1) is the factual base: shrunk
 * touchdown rates, red-zone role, opponent concession, game script, weather,
 * and a calibration fitted out of sample on historical seasons. It is a file
 * in git and the learning loop never edits it.
 *
 * What the loop produces is an OVERRIDE: a logistic model over the exact
 * feature vector frozen at issuance, including the artefact's own probability
 * as a feature. A promoted override refines the published number; it cannot
 * silently replace the football underneath it, and because `model_prob` stays
 * the artefact's number in every feature vector, the meaning of the training
 * data never shifts under the model.
 *
 * WHAT MAY ENTER TRAINING
 * Finalized observations only: a target that was locked before kickoff, played,
 * was graded from the official final box score, and carries the feature vector
 * frozen at issuance. A live score cannot reach this file, and neither can a
 * recomputed feature — the grader copies the issuance snapshot rather than
 * rebuilding it.
 *
 * WHAT MAY BE PROMOTED
 * Nothing, until the hard gate opens: 100 finalized observations AND 4 distinct
 * weeks. The gate is the same one the existing NFL lanes use and it is not
 * relaxed because touchdown targets produce observations faster — a fast
 * denominator is exactly when a lucky numerator is most tempting.
 *
 * And then only on out-of-sample predictive quality. ROI is computed, reported
 * and deliberately NOT a promotion criterion: a short run of long-priced
 * winners is the easiest thing in this product to mistake for skill.
 */

import { logistic, round } from './td-kernel.mjs';
import { TD_FEATURE_ORDER } from './td-selector.mjs';

export const MIN_FINALIZED = 100;
export const MIN_WEEKS = 4;
export const HOLDOUT_FRACTION = 0.20;
export const MIN_HOLDOUT_ROWS = 20;

/* Promotion margins. A challenger has to be better by more than the noise in
 * a hundred-observation holdout, not merely different. */
export const LOG_LOSS_IMPROVEMENT_RATIO = 0.01;   /* 1% relative */
export const BRIER_TOLERANCE = 0.002;             /* may not be worse by more than this */
export const MAX_CALIBRATION_DEVIATION = 0.10;    /* worst populated bucket */
export const POSITION_BRIER_TOLERANCE = 0.02;
export const MIN_BUCKET_ROWS = 20;

const L2 = 1.0;
const LEARNING_RATE = 0.08;
const EPOCHS = 600;

/* Missing is not zero: Number(null) is 0 and finite. See td-kernel.mjs. */
const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const clampProb = p => Math.min(1 - 1e-9, Math.max(1e-9, p));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/* The override's feature vector. A feature the issuance snapshot recorded as
 * unavailable stays out of the sum by contributing zero AFTER its presence
 * flag is recorded, so "missing" and "zero" are different inputs to the model
 * rather than the same one. */
/* `is_primary` is recorded on every observation — the primary-only record
 * depends on it — but it is deliberately NOT an override input: whether a
 * candidate becomes the primary is decided AFTER his probability, so feeding
 * it back in would ask the model for a number it needs in order to exist. */
export const OVERRIDE_EXCLUDED = Object.freeze(['is_primary']);
const OVERRIDE_INPUTS = Object.freeze(TD_FEATURE_ORDER.filter(name => !OVERRIDE_EXCLUDED.includes(name)));

export const OVERRIDE_FEATURE_ORDER = Object.freeze(
  OVERRIDE_INPUTS.flatMap(name => [name, `${name}__present`]),
);

export function overrideVector(features) {
  const out = {};
  for (const name of OVERRIDE_INPUTS) {
    const value = finite(features?.[name]);
    out[name] = value === null ? 0 : value;
    out[`${name}__present`] = value === null ? 0 : 1;
  }
  return out;
}

export function overrideProbability(model, features) {
  if (!model || typeof model !== 'object') return null;
  const order = Array.isArray(model.feature_order) && model.feature_order.length
    ? model.feature_order : OVERRIDE_FEATURE_ORDER;
  const vector = overrideVector(features);
  let z = finite(model.intercept);
  if (z === null) return null;
  for (const name of order) {
    const coefficient = finite(model?.coef?.[name]);
    const value = finite(vector[name]);
    /* An override missing a coefficient for a feature it declares is not a
     * model: it returns nothing rather than a partial score. */
    if (coefficient === null || value === null) return null;
    z += coefficient * value;
  }
  const p = logistic(z);
  return p > 0 && p < 1 ? round(p, 6) : null;
}

/* The promoted selector's override, if it has one AND it is trained. An
 * untrained row's config can carry anything; only `trained` makes it a model
 * this function will hand back. */
export function promotedOverride(selector) {
  if (selector?.trained !== true) return null;
  const model = selector?.config?.probability_override;
  if (!model || typeof model !== 'object') return null;
  if (!Number.isFinite(Number(model.intercept)) || !model.coef) return null;
  return model;
}

/* --------------------------------------------------------------- the gate */

export function gateStatus(observations) {
  const rows = Array.isArray(observations) ? observations : [];
  const weeks = new Set(rows.map(row => `${row.season}-${row.week}`));
  return {
    finalized: rows.length,
    finalized_required: MIN_FINALIZED,
    distinct_weeks: weeks.size,
    distinct_weeks_required: MIN_WEEKS,
    open: rows.length >= MIN_FINALIZED && weeks.size >= MIN_WEEKS,
    reason: rows.length < MIN_FINALIZED
      ? `insufficient_finalized:${rows.length}/${MIN_FINALIZED}`
      : weeks.size < MIN_WEEKS
        ? `insufficient_weeks:${weeks.size}/${MIN_WEEKS}`
        : null,
  };
}

/* Chronological, never random: a random split would let a later week inform
 * an earlier one, which is the whole thing this engine is built not to do. */
export function holdoutSplit(observations) {
  const rows = (Array.isArray(observations) ? observations : []).slice()
    .sort((a, b) => String(a.finalized_at || '').localeCompare(String(b.finalized_at || '')));
  const holdoutCount = Math.max(MIN_HOLDOUT_ROWS, Math.ceil(rows.length * HOLDOUT_FRACTION));
  const splitAt = Math.max(1, rows.length - holdoutCount);
  return { train: rows.slice(0, splitAt), test: rows.slice(splitAt) };
}

/* ------------------------------------------------------------- the training */

/* A finalized observation trains on the realised outcome and nothing else.
 * A void — a withdrawn target, or a player the box score reported did not
 * play — has no outcome bit and is not a training row. */
function trainableRows(observations) {
  const rows = [];
  for (const observation of Array.isArray(observations) ? observations : []) {
    const y = observation?.outcome === 1 ? 1 : observation?.outcome === 0 ? 0 : null;
    if (y === null) continue;
    if (observation?.is_final !== true) continue;
    const features = observation?.features;
    if (!features || typeof features !== 'object' || !Object.keys(features).length) continue;
    rows.push({ x: overrideVector(features), y, observation });
  }
  return rows;
}

export function trainOverride(observations) {
  const rows = trainableRows(observations);
  if (rows.length < MIN_HOLDOUT_ROWS) throw new Error(`no_trainable_td_rows:${rows.length}`);

  const order = [...OVERRIDE_FEATURE_ORDER];
  const weights = new Array(order.length).fill(0);
  /* Start from the log-odds of the base rate so the very first epoch is not
   * fighting an intercept of zero. */
  let intercept = Math.log(clampProb(mean(rows.map(r => r.y))) / (1 - clampProb(mean(rows.map(r => r.y)))));

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const gradient = new Array(order.length).fill(0);
    let interceptGradient = 0;
    for (const row of rows) {
      let z = intercept;
      for (let i = 0; i < order.length; i += 1) z += weights[i] * row.x[order[i]];
      const error = logistic(z) - row.y;
      interceptGradient += error;
      for (let i = 0; i < order.length; i += 1) gradient[i] += error * row.x[order[i]];
    }
    intercept -= LEARNING_RATE * (interceptGradient / rows.length);
    for (let i = 0; i < order.length; i += 1) {
      weights[i] -= LEARNING_RATE * (gradient[i] / rows.length + (L2 / rows.length) * weights[i]);
    }
  }

  const coef = {};
  order.forEach((name, index) => { coef[name] = round(weights[index], 6); });
  return {
    intercept: round(intercept, 6),
    coef,
    feature_order: order,
    training_rows: rows.length,
    objective: 'log_loss_on_realised_offensive_touchdown',
    regularisation: { l2: L2, epochs: EPOCHS, learning_rate: LEARNING_RATE },
  };
}

/* ----------------------------------------------------------- the evaluation */

/* Score a model — a trained override, or `null` meaning "the champion as it
 * stands, which publishes the artefact's own number" — on a set of finalized
 * observations. The artefact's number is `features.model_prob`, which is why
 * that feature is never overwritten. */
export function evaluate(model, observations) {
  const rows = trainableRows(observations);
  if (!rows.length) return null;

  const scored = [];
  for (const row of rows) {
    const p = model
      ? overrideProbability(model, row.observation.features)
      : finite(row.observation.features?.model_prob);
    if (p === null) return { unavailable_reason: 'model_could_not_score_every_holdout_row', rows: rows.length };
    scored.push({
      p: clampProb(p),
      y: row.y,
      observation: row.observation,
    });
  }

  const brier = mean(scored.map(s => (s.p - s.y) ** 2));
  const logLoss = mean(scored.map(s => -(s.y * Math.log(s.p) + (1 - s.y) * Math.log(1 - s.p))));
  const primaries = scored.filter(s => s.observation.features?.is_primary === 1);
  const priced = scored.filter(s => finite(s.observation.units_delta) !== null);

  return {
    rows: scored.length,
    base_rate: round(mean(scored.map(s => s.y)), 6),
    mean_probability: round(mean(scored.map(s => s.p)), 6),
    brier: round(brier, 6),
    log_loss: round(logLoss, 6),
    calibration: calibration(scored),
    max_calibration_deviation: maxCalibrationDeviation(calibration(scored)),
    by_position: {},
    primary: primaries.length ? {
      rows: primaries.length,
      hit_rate: round(mean(primaries.map(s => s.y)), 6),
      mean_probability: round(mean(primaries.map(s => s.p)), 6),
      brier: round(mean(primaries.map(s => (s.p - s.y) ** 2)), 6),
    } : null,
    /* Reported, never a promotion criterion. `units` is the sum of the
     * persisted per-target unit results, each at the price actually frozen at
     * issuance — never a default, never -110. */
    roi: priced.length ? {
      rows: priced.length,
      units: round(priced.reduce((sum, s) => sum + Number(s.observation.units_delta), 0), 4),
      roi_pct: round(priced.reduce((sum, s) => sum + Number(s.observation.units_delta), 0) / priced.length * 100, 4),
      denominator: 'settled targets, 1u risked each at the persisted issuance price',
      promotion_criterion: false,
    } : null,
    by_week: byKey(scored, s => `${s.observation.season}-${String(s.observation.week).padStart(2, '0')}`),
    by_probability_bucket: byKey(scored, s => bucketOf(s.p)),
  };
}

function calibration(scored, edges = [0, 0.15, 0.25, 0.35, 0.5, 1.0001]) {
  const bins = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const inBin = scored.filter(s => s.p >= edges[i] && s.p < edges[i + 1]);
    if (inBin.length < MIN_BUCKET_ROWS) continue;
    bins.push({
      from: edges[i], to: Math.min(edges[i + 1], 1), n: inBin.length,
      predicted: round(mean(inBin.map(s => s.p)), 6),
      observed: round(mean(inBin.map(s => s.y)), 6),
    });
  }
  return bins;
}

function maxCalibrationDeviation(bins) {
  if (!bins.length) return null;
  return round(Math.max(...bins.map(bin => Math.abs(bin.predicted - bin.observed))), 6);
}

function bucketOf(p) {
  if (p < 0.15) return 'under_15';
  if (p < 0.25) return '15_to_25';
  if (p < 0.35) return '25_to_35';
  if (p < 0.5) return '35_to_50';
  return '50_plus';
}

function byKey(scored, keyOf) {
  const groups = new Map();
  for (const row of scored) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = {};
  for (const [key, rows] of [...groups.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1))) {
    out[key] = {
      n: rows.length,
      observed: round(mean(rows.map(r => r.y)), 6),
      predicted: round(mean(rows.map(r => r.p)), 6),
      brier: round(mean(rows.map(r => (r.p - r.y) ** 2)), 6),
    };
  }
  return out;
}

/* ------------------------------------------------------------ the verdict */

/* Every criterion must pass. Each one is named in the verdict so a rejection
 * is reviewable rather than a shrug, and so a promotion can be explained to a
 * customer looking at the model ledger. */
export function promotionVerdict({ candidate, champion, gate }) {
  const checks = [];
  const fail = (name, detail) => checks.push({ check: name, pass: false, detail });
  const pass = (name, detail) => checks.push({ check: name, pass: true, detail });

  if (!gate?.open) {
    return { promote: false, reason: `gate_closed:${gate?.reason || 'unknown'}`, checks: [{ check: 'hard_gate', pass: false, detail: gate?.reason ?? null }] };
  }
  pass('hard_gate', `${gate.finalized} finalized over ${gate.distinct_weeks} weeks`);

  if (!candidate || candidate.unavailable_reason) {
    return { promote: false, reason: `candidate_unscoreable:${candidate?.unavailable_reason || 'no_evaluation'}`, checks };
  }
  if (!champion || champion.unavailable_reason) {
    return { promote: false, reason: `champion_unscoreable:${champion?.unavailable_reason || 'no_evaluation'}`, checks };
  }
  if (candidate.rows < MIN_HOLDOUT_ROWS) {
    fail('holdout_size', `${candidate.rows}/${MIN_HOLDOUT_ROWS}`);
    return { promote: false, reason: `holdout_too_small:${candidate.rows}/${MIN_HOLDOUT_ROWS}`, checks };
  }
  pass('holdout_size', `${candidate.rows} rows`);

  const required = champion.log_loss * (1 - LOG_LOSS_IMPROVEMENT_RATIO);
  if (!(candidate.log_loss <= required)) {
    fail('log_loss_improvement', `candidate ${candidate.log_loss} vs required <= ${round(required, 6)} (champion ${champion.log_loss})`);
  } else {
    pass('log_loss_improvement', `candidate ${candidate.log_loss} beats champion ${champion.log_loss} by more than ${LOG_LOSS_IMPROVEMENT_RATIO * 100}%`);
  }

  if (!(candidate.brier <= champion.brier + BRIER_TOLERANCE)) {
    fail('brier_not_worse', `candidate ${candidate.brier} vs champion ${champion.brier}`);
  } else {
    pass('brier_not_worse', `candidate ${candidate.brier} vs champion ${champion.brier}`);
  }

  if (candidate.max_calibration_deviation === null) {
    fail('calibration', 'no probability bucket reached the minimum sample for a calibration check');
  } else if (candidate.max_calibration_deviation > MAX_CALIBRATION_DEVIATION) {
    fail('calibration', `worst bucket off by ${candidate.max_calibration_deviation} (limit ${MAX_CALIBRATION_DEVIATION})`);
  } else {
    pass('calibration', `worst populated bucket off by ${candidate.max_calibration_deviation}`);
  }

  /* Stability: a candidate that wins overall by collapsing on one week or one
   * probability band has not learned anything worth publishing. */
  const unstableWeeks = Object.entries(candidate.by_week || {})
    .filter(([week, row]) => row.n >= MIN_BUCKET_ROWS
      && champion.by_week?.[week]
      && row.brier > champion.by_week[week].brier + POSITION_BRIER_TOLERANCE)
    .map(([week]) => week);
  if (unstableWeeks.length) fail('week_stability', `worse than champion on ${unstableWeeks.join(', ')}`);
  else pass('week_stability', 'no week with an adequate sample got worse');

  const unstableBuckets = Object.entries(candidate.by_probability_bucket || {})
    .filter(([bucket, row]) => row.n >= MIN_BUCKET_ROWS
      && champion.by_probability_bucket?.[bucket]
      && row.brier > champion.by_probability_bucket[bucket].brier + POSITION_BRIER_TOLERANCE)
    .map(([bucket]) => bucket);
  if (unstableBuckets.length) fail('probability_bucket_stability', `worse than champion in ${unstableBuckets.join(', ')}`);
  else pass('probability_bucket_stability', 'no probability bucket with an adequate sample got worse');

  const failed = checks.filter(check => !check.pass);
  return {
    promote: failed.length === 0,
    reason: failed.length === 0
      ? `all ${checks.length} criteria passed; holdout log loss ${candidate.log_loss} vs champion ${champion.log_loss}`
      : failed.map(check => `${check.check}:${check.detail}`).join(' | '),
    checks,
    roi_reported_not_used: candidate.roi ?? null,
  };
}
