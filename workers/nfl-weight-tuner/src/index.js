/* nfl-weight-tuner — trains a challenger, backtests it against the reigning
 * champion, and promotes ONLY if it clears the gate.
 *
 * Non-negotiables enforced here:
 *
 *   HARD GATE   >= 100 finalized graded picks AND >= 4 distinct graded weeks.
 *               Below either threshold the Worker logs and exits. There is no
 *               override parameter, no env flag, and no query string that can
 *               bypass it — deliberately, so a bypass cannot be added by
 *               accident later.
 *
 *   FINALIZED   Training reads nfl_learning_observations only. Live or
 *   ONLY        provisional results are not in that table, so production
 *               weights cannot be moved by an in-progress game.
 *
 *   APPEND-ONLY Old weight rows are never edited or deleted. A rejected
 *               challenger is still inserted with promoted=false and a note
 *               explaining which criterion it failed.
 */

import { select, insert, audit } from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  logistic, scoreFeatures, FEATURE_ORDER,
} from '../../nfl-picks-engine-shared/pick-math.mjs';

const SERVICE = 'nfl-weight-tuner';
const VERSION = 'v1.0.0';

export const MIN_GRADED_PICKS = 100;
export const MIN_DISTINCT_WEEKS = 4;

/* Promotion criteria from the brief. */
export const CLV_IMPROVEMENT_POINTS = 1.0;
export const CLV_TIE_TOLERANCE = 0.5;

/* Training target: primary label clv_beat, secondary W/L, weighted 70/30. */
export const CLV_LABEL_WEIGHT = 0.7;
export const RESULT_LABEL_WEIGHT = 0.3;

const L2 = 1.0;
const LEARNING_RATE = 0.05;
const EPOCHS = 400;

const health = { last_cron_run: null, last_error_class: null, last_result: null, gate: null };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return json({
        service: SERVICE, version: VERSION,
        last_cron_run: health.last_cron_run,
        last_error_class: health.last_error_class,
        last_result: health.last_result,
        gate: health.gate,
        gate_requirements: {
          min_graded_picks: MIN_GRADED_PICKS,
          min_distinct_weeks: MIN_DISTINCT_WEEKS,
        },
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        },
      });
    }
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTuning(env));
  },
};

/* The gate. Pure, exported, and tested directly. */
export function gateStatus(observations) {
  const rows = Array.isArray(observations) ? observations : [];
  const weeks = new Set(rows.map(o => `${o.season}-${o.week}`));
  const graded = rows.length;
  return {
    graded,
    distinct_weeks: weeks.size,
    open: graded >= MIN_GRADED_PICKS && weeks.size >= MIN_DISTINCT_WEEKS,
    reason: graded < MIN_GRADED_PICKS
      ? `insufficient_grades:${graded}/${MIN_GRADED_PICKS}`
      : weeks.size < MIN_DISTINCT_WEEKS
        ? `insufficient_weeks:${weeks.size}/${MIN_DISTINCT_WEEKS}`
        : null,
  };
}

async function runTuning(env) {
  health.last_cron_run = new Date().toISOString();
  try {
    const observations = await select(
      env, 'nfl_learning_observations',
      'is_final=is.true&select=*&order=season.desc,week.desc&limit=5000',
    ) || [];

    const gate = gateStatus(observations);
    health.gate = gate;

    if (!gate.open) {
      health.last_result = `gated:${gate.reason}`;
      health.last_error_class = null;
      console.log(`[${SERVICE}] gate closed ${gate.reason} — exiting without training`);
      return;
    }

    const championRows = await select(
      env, 'nfl_model_weights',
      'promoted=is.true&select=version,weights&order=version.desc&limit=1',
    ) || [];
    const champion = championRows[0];
    if (!champion) throw new Error('no_promoted_model');

    const candidate = trainChallenger(observations);
    const candidateScore = backtest(candidate, observations);
    const championScore = backtest(champion.weights, observations);
    const verdict = promotionVerdict(candidateScore, championScore);

    const trainedWeeks = [...new Set(observations.map(o => o.week))].sort((a, b) => b - a);

    const inserted = await insert(env, 'nfl_model_weights', {
      weights: candidate,
      trained_through_week: trainedWeeks[0] ?? null,
      training_rows: observations.length,
      backtest_clv_beat_pct: candidateScore.clv_beat_pct,
      backtest_brier: candidateScore.brier,
      backtest_units: candidateScore.units,
      promoted: verdict.promote,
      promoted_at: verdict.promote ? new Date().toISOString() : null,
      notes: verdict.promote
        ? `promoted: ${verdict.reason}`
        : `rejected: ${verdict.reason}`,
    });
    const newVersion = Array.isArray(inserted) ? inserted[0]?.version : inserted?.version;

    await audit(env, {
      event_type: 'training_run', model_version: newVersion,
      detail: { training_rows: observations.length, gate },
    });
    await audit(env, {
      event_type: 'challenger_evaluation', model_version: newVersion,
      detail: { candidate: candidateScore, champion: championScore, verdict },
    });
    await audit(env, {
      event_type: verdict.promote ? 'champion_promoted' : 'champion_rejected',
      model_version: newVersion,
      detail: { previous_champion: champion.version, reason: verdict.reason },
    });

    health.last_result = verdict.promote
      ? `promoted v${newVersion}: ${verdict.reason}`
      : `rejected v${newVersion}: ${verdict.reason}`;
    health.last_error_class = null;
  } catch (error) {
    health.last_error_class = errorClass(error);
    console.error(`[${SERVICE}] tuning failed class=${health.last_error_class}`);
  }
}

/* ---------------------------------------------------------------------------
 * Training — L2-regularised logistic regression by batch gradient descent.
 * ------------------------------------------------------------------------ */

export function blendedLabel(observation) {
  /* Primary signal is CLV; W/L contributes only 30%. A void has no result
   * component, so it trains on CLV alone — which is why killed picks still
   * carry information. */
  const clv = observation.clv_beat === true ? 1 : observation.clv_beat === false ? 0 : null;
  const outcome = observation.outcome === 1 ? 1 : observation.outcome === 0 ? 0 : null;

  if (clv === null && outcome === null) return null;
  if (outcome === null) return clv;
  if (clv === null) return outcome;
  return CLV_LABEL_WEIGHT * clv + RESULT_LABEL_WEIGHT * outcome;
}

export function trainChallenger(observations) {
  const rows = [];
  for (const o of observations) {
    const label = blendedLabel(o);
    if (label === null) continue;
    const features = o.features || {};
    const x = FEATURE_ORDER.map(name => Number(features[name] || 0));
    if (x.some(v => !Number.isFinite(v))) continue;
    rows.push({ x, y: label });
  }
  if (!rows.length) throw new Error('no_trainable_rows');

  const n = FEATURE_ORDER.length;
  const w = new Array(n).fill(0);
  let intercept = 0;

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const grad = new Array(n).fill(0);
    let gradIntercept = 0;

    for (const row of rows) {
      let z = intercept;
      for (let j = 0; j < n; j += 1) z += w[j] * row.x[j];
      const error = logistic(z) - row.y;
      gradIntercept += error;
      for (let j = 0; j < n; j += 1) grad[j] += error * row.x[j];
    }

    intercept -= LEARNING_RATE * (gradIntercept / rows.length);
    for (let j = 0; j < n; j += 1) {
      grad[j] = grad[j] / rows.length + (L2 / rows.length) * w[j];
      w[j] -= LEARNING_RATE * grad[j];
    }
  }

  const coef = {};
  FEATURE_ORDER.forEach((name, j) => { coef[name] = Number(w[j].toFixed(6)); });

  return {
    intercept: Number(intercept.toFixed(6)),
    coef,
    calib: calibrate(observations),
    meta: {
      source: 'trained_challenger',
      trained: true,
      feature_order: [...FEATURE_ORDER],
      training_rows: rows.length,
    },
  };
}

/* Per-bucket shrinkage: if a bucket states 70% and hits 55%, pull it toward
 * 0.5. Applied before any coefficient logic, per the brief. */
export function calibrate(observations) {
  const buckets = { A: [], B: [], C: [] };
  for (const o of observations) {
    if (o.outcome !== 0 && o.outcome !== 1) continue;
    const bucket = o.confidence_bucket || inferBucket(o);
    if (buckets[bucket]) buckets[bucket].push(o);
  }

  const calib = {};
  for (const key of ['A', 'B', 'C']) {
    const rows = buckets[key];
    if (rows.length < 20) { calib[key] = 1.0; continue; }
    const stated = mean(rows.map(r => Number(r.model_prob)));
    const realised = mean(rows.map(r => Number(r.outcome)));
    const statedEdge = stated - 0.5;
    const realisedEdge = realised - 0.5;
    if (Math.abs(statedEdge) < 1e-6) { calib[key] = 1.0; continue; }
    const factor = realisedEdge / statedEdge;
    calib[key] = Number(Math.max(0, Math.min(1, factor)).toFixed(4));
  }
  return calib;
}

function inferBucket(o) {
  const edge = Math.abs(Number(o.model_prob) - 0.5);
  if (edge >= 0.05) return 'A';
  if (edge >= 0.035) return 'B';
  return 'C';
}

/* ---------------------------------------------------------------------------
 * Backtest + promotion gate
 * ------------------------------------------------------------------------ */

export function backtest(weights, observations) {
  let clvBeats = 0, clvCount = 0, brierSum = 0, brierCount = 0, units = 0;

  for (const o of observations) {
    let prob;
    try {
      prob = logistic(scoreFeatures(weights, o.features || {}));
    } catch (_) {
      continue;
    }
    if (o.clv_beat === true || o.clv_beat === false) {
      clvCount += 1;
      /* The model "agreed with the close" when it leaned the same way the
       * market moved. */
      const leaned = prob >= 0.5;
      if (leaned === (o.clv_beat === true)) clvBeats += 1;
    }
    if (o.outcome === 0 || o.outcome === 1) {
      brierSum += (prob - o.outcome) ** 2;
      brierCount += 1;
    }
    units += Number(o.units_delta || 0);
  }

  return {
    clv_beat_pct: clvCount ? Number(((clvBeats / clvCount) * 100).toFixed(4)) : null,
    brier: brierCount ? Number((brierSum / brierCount).toFixed(6)) : null,
    units: Number(units.toFixed(4)),
    rows: observations.length,
  };
}

/* Promote ONLY if candidate CLV-beat% >= champion + 1.0 point, OR the CLV is
 * effectively tied (within 0.5) and the Brier is lower. Anything else is a
 * rejection with a recorded reason. */
export function promotionVerdict(candidate, champion) {
  const c = candidate.clv_beat_pct, k = champion.clv_beat_pct;

  if (c === null || k === null) {
    return { promote: false, reason: 'insufficient_clv_signal_for_comparison' };
  }
  if (c >= k + CLV_IMPROVEMENT_POINTS) {
    return { promote: true, reason: `clv_beat ${c} >= champion ${k} + ${CLV_IMPROVEMENT_POINTS}` };
  }
  if (Math.abs(c - k) <= CLV_TIE_TOLERANCE) {
    if (candidate.brier !== null && champion.brier !== null && candidate.brier < champion.brier) {
      return { promote: true, reason: `clv tied (${c} vs ${k}), brier improved ${candidate.brier} < ${champion.brier}` };
    }
    return { promote: false, reason: `clv tied (${c} vs ${k}) and brier not improved` };
  }
  return { promote: false, reason: `clv_beat ${c} did not clear champion ${k} + ${CLV_IMPROVEMENT_POINTS}` };
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function mean(values) {
  const list = values.filter(v => Number.isFinite(v));
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
}

function errorClass(error) {
  return String(error?.message || 'unknown').split(':')[0].slice(0, 60);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
