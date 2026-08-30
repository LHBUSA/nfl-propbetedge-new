/* nfl-prop-picks-tuner — Algorithm #2 learning loop.
 *
 * Hard gate: >=100 finalized player-prop observations AND >=4 distinct weeks.
 * Evaluation is chronological holdout: oldest 80% train, newest 20% test.
 * Only after a challenger wins the holdout is it refit on the full finalized
 * sample and atomically promoted. No HTTP train/promote route exists.
 */
import { select, insert, rpc } from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  logistic, SELECTOR_FEATURE_ORDER, PROP_MARKET,
} from '../../nfl-prop-picks-shared/prop-math.mjs';

const SERVICE = 'nfl-prop-picks-tuner';
const VERSION = 'v1.0.0';
export const MIN_FINALIZED = 100;
export const MIN_WEEKS = 4;
export const HOLDOUT_FRACTION = 0.20;
export const CLV_IMPROVEMENT_POINTS = 1.0;
export const CLV_TIE_TOLERANCE = 0.5;
export const CLV_LABEL_WEIGHT = 0.70;
export const RESULT_LABEL_WEIGHT = 0.30;
const MIN_SELECTED_FRACTION = 0.50;
const MIN_SELECTED_ABSOLUTE = 10;
const L2 = 1.0;
const LEARNING_RATE = 0.05;
const EPOCHS = 400;

const health = {
  last_cron_run: null,
  last_error_class: null,
  last_result: null,
  gate: null,
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/health') return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
    return json({
      service: SERVICE,
      version: VERSION,
      last_cron_run: health.last_cron_run,
      last_error_class: health.last_error_class,
      last_result: health.last_result,
      gate: health.gate,
      gate_requirements: {
        min_finalized: MIN_FINALIZED,
        min_distinct_weeks: MIN_WEEKS,
        holdout_fraction: HOLDOUT_FRACTION,
      },
      requirements: {
        SUPABASE_URL: Boolean(env.SUPABASE_URL),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
      },
    });
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(runTuning(env)); },
};

export function gateStatus(observations) {
  const rows = Array.isArray(observations) ? observations : [];
  const weeks = new Set(rows.map(row => `${row.season}-${row.week}`));
  return {
    finalized: rows.length,
    distinct_weeks: weeks.size,
    open: rows.length >= MIN_FINALIZED && weeks.size >= MIN_WEEKS,
    reason: rows.length < MIN_FINALIZED
      ? `insufficient_finalized:${rows.length}/${MIN_FINALIZED}`
      : weeks.size < MIN_WEEKS
        ? `insufficient_weeks:${weeks.size}/${MIN_WEEKS}`
        : null,
  };
}

async function runTuning(env) {
  health.last_cron_run = new Date().toISOString();
  try {
    const observations = await select(
      env,
      'nfl_prop_learning_observations',
      `market=eq.${PROP_MARKET}&is_final=eq.true&select=*&order=finalized_at.asc&limit=5000`,
    ) || [];
    const gate = gateStatus(observations);
    health.gate = gate;
    if (!gate.open) {
      health.last_result = `gated:${gate.reason}`;
      health.last_error_class = null;
      return;
    }

    const championRows = await select(
      env,
      'nfl_prop_selector_models',
      `market=eq.${PROP_MARKET}&promoted=is.true&select=*&order=version.desc&limit=1`,
    ) || [];
    const champion = championRows[0];
    if (!champion) throw new Error('no_promoted_prop_selector');

    const split = holdoutSplit(observations);
    const provisional = trainSelector(split.train);
    const minQuality = finite(champion?.config?.min_quality_prob, 0.55);
    const candidateScore = backtestSelector(provisional, split.test, minQuality);
    const championModel = champion?.trained === true ? champion?.config?.selector_model : null;
    const championScore = backtestSelector(championModel, split.test, minQuality);
    const verdict = promotionVerdict(candidateScore, championScore, split.test.length);

    // Fit the retained challenger on all finalized information only after the
    // holdout verdict is known. Evaluation metrics remain holdout metrics.
    const retainedModel = trainSelector(observations);
    const config = {
      ...(champion.config || {}),
      source: 'trained_prop_selector',
      selector_model: retainedModel,
      validation: {
        method: 'chronological_holdout',
        train_rows: split.train.length,
        holdout_rows: split.test.length,
        candidate_holdout: candidateScore,
        champion_holdout: championScore,
      },
    };

    const inserted = await insert(env, 'nfl_prop_selector_models', {
      market: PROP_MARKET,
      projection_model: champion.projection_model,
      config,
      trained: true,
      promoted: false,
      training_rows: observations.length,
      trained_through_week: Math.max(...observations.map(row => Number(row.week) || 0)),
      backtest_clv_beat_pct: candidateScore.clv_beat_pct,
      backtest_brier: candidateScore.brier,
      backtest_units: candidateScore.units,
      notes: verdict.promote ? `candidate passed holdout: ${verdict.reason}` : `candidate rejected: ${verdict.reason}`,
    });
    const newVersion = Array.isArray(inserted) ? inserted[0]?.version : inserted?.version;
    if (!newVersion) throw new Error('candidate_insert_failed');

    await audit(env, 'prop_training_run', newVersion, {
      finalized: observations.length,
      gate,
      train_rows: split.train.length,
      holdout_rows: split.test.length,
    });
    await audit(env, 'prop_selector_evaluation', newVersion, {
      candidate: candidateScore,
      champion: championScore,
      verdict,
      previous_champion: champion.version,
    });

    if (verdict.promote) {
      await rpc(env, 'nfl_promote_prop_selector', {
        p_version: newVersion,
        p_market: PROP_MARKET,
      });
      await audit(env, 'prop_selector_promoted', newVersion, {
        previous_champion: champion.version,
        reason: verdict.reason,
      });
      health.last_result = `promoted v${newVersion}: ${verdict.reason}`;
    } else {
      await audit(env, 'prop_selector_rejected', newVersion, {
        previous_champion: champion.version,
        reason: verdict.reason,
      });
      health.last_result = `rejected v${newVersion}: ${verdict.reason}`;
    }
    health.last_error_class = null;
  } catch (error) {
    health.last_error_class = errorClass(error);
    console.error(`[${SERVICE}] tuning failed class=${health.last_error_class}`);
  }
}

export function holdoutSplit(observations) {
  const rows = Array.isArray(observations) ? observations : [];
  const holdoutCount = Math.max(20, Math.ceil(rows.length * HOLDOUT_FRACTION));
  const splitAt = Math.max(1, rows.length - holdoutCount);
  return { train: rows.slice(0, splitAt), test: rows.slice(splitAt) };
}

export function blendedLabel(row) {
  const clv = row?.clv_beat === true ? 1 : row?.clv_beat === false ? 0 : null;
  const outcome = row?.outcome === 1 ? 1 : row?.outcome === 0 ? 0 : null;
  if (clv === null && outcome === null) return null;
  if (clv === null) return outcome;
  if (outcome === null) return clv;
  return CLV_LABEL_WEIGHT * clv + RESULT_LABEL_WEIGHT * outcome;
}

export function trainSelector(observations) {
  const rows = [];
  for (const observation of Array.isArray(observations) ? observations : []) {
    const y = blendedLabel(observation);
    if (y === null) continue;
    const source = observation?.features || {};
    const x = SELECTOR_FEATURE_ORDER.map(name => Number(source[name] || 0));
    if (x.some(value => !Number.isFinite(value))) continue;
    rows.push({ x, y });
  }
  if (!rows.length) throw new Error('no_trainable_prop_rows');

  const weights = new Array(SELECTOR_FEATURE_ORDER.length).fill(0);
  let intercept = 0;
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const gradient = new Array(weights.length).fill(0);
    let interceptGradient = 0;
    for (const row of rows) {
      let z = intercept;
      for (let i = 0; i < weights.length; i += 1) z += weights[i] * row.x[i];
      const error = logistic(z) - row.y;
      interceptGradient += error;
      for (let i = 0; i < weights.length; i += 1) gradient[i] += error * row.x[i];
    }
    intercept -= LEARNING_RATE * (interceptGradient / rows.length);
    for (let i = 0; i < weights.length; i += 1) {
      const regularized = gradient[i] / rows.length + (L2 / rows.length) * weights[i];
      weights[i] -= LEARNING_RATE * regularized;
    }
  }

  const coef = {};
  SELECTOR_FEATURE_ORDER.forEach((name, index) => { coef[name] = Number(weights[index].toFixed(6)); });
  return {
    intercept: Number(intercept.toFixed(6)),
    coef,
    feature_order: [...SELECTOR_FEATURE_ORDER],
    training_rows: rows.length,
    objective: '70pct_clv_30pct_outcome',
  };
}

export function qualityProbability(model, features) {
  if (!model || typeof model !== 'object') return 0.5;
  const order = Array.isArray(model.feature_order) && model.feature_order.length
    ? model.feature_order : SELECTOR_FEATURE_ORDER;
  let z = finite(model.intercept, 0);
  for (const name of order) {
    const c = Number(model?.coef?.[name]);
    const x = Number(features?.[name] || 0);
    if (!Number.isFinite(c) || !Number.isFinite(x)) return 0.5;
    z += c * x;
  }
  return logistic(z);
}

export function backtestSelector(model, observations, minQuality = 0.55) {
  const rows = Array.isArray(observations) ? observations : [];
  let selected = 0, clvBeats = 0, clvCount = 0, brierSum = 0, brierCount = 0, units = 0;
  for (const row of rows) {
    const quality = qualityProbability(model, row?.features || {});
    const y = blendedLabel(row);
    if (y !== null) {
      brierSum += (quality - y) ** 2;
      brierCount += 1;
    }
    if (quality < minQuality && model) continue;
    selected += 1;
    if (row?.clv_beat === true || row?.clv_beat === false) {
      clvCount += 1;
      if (row.clv_beat === true) clvBeats += 1;
    }
    units += Number(row?.units_delta || 0);
  }
  return {
    clv_beat_pct: clvCount ? Number((clvBeats / clvCount * 100).toFixed(4)) : null,
    brier: brierCount ? Number((brierSum / brierCount).toFixed(6)) : null,
    units: Number(units.toFixed(4)),
    rows: rows.length,
    selected,
    selected_pct: rows.length ? Number((selected / rows.length * 100).toFixed(2)) : 0,
  };
}

export function promotionVerdict(candidate, champion, holdoutRows) {
  const minimumSelected = Math.max(
    MIN_SELECTED_ABSOLUTE,
    Math.ceil(Number(holdoutRows || 0) * MIN_SELECTED_FRACTION),
  );
  if (candidate.selected < minimumSelected) {
    return { promote: false, reason: `selected_sample_too_small:${candidate.selected}/${minimumSelected}` };
  }
  const c = candidate.clv_beat_pct, k = champion.clv_beat_pct;
  if (c === null || k === null) return { promote: false, reason: 'insufficient_clv_signal_for_comparison' };
  if (c >= k + CLV_IMPROVEMENT_POINTS) {
    return { promote: true, reason: `holdout_clv ${c} >= champion ${k} + ${CLV_IMPROVEMENT_POINTS}` };
  }
  if (Math.abs(c - k) <= CLV_TIE_TOLERANCE) {
    if (candidate.brier !== null && champion.brier !== null && candidate.brier < champion.brier) {
      return { promote: true, reason: `holdout_clv_tied (${c} vs ${k}); brier ${candidate.brier} < ${champion.brier}` };
    }
    return { promote: false, reason: `holdout_clv_tied (${c} vs ${k}); brier_not_improved` };
  }
  return { promote: false, reason: `holdout_clv ${c} did_not_clear champion ${k}` };
}

async function audit(env, eventType, version, detail) {
  try {
    await insert(env, 'nfl_prop_pick_audit_events', {
      pick_id: null,
      event_type: eventType,
      selector_version: version,
      detail: detail || {},
    }, { returning: 'minimal' });
  } catch (error) {
    console.error('[prop-tuner-audit] failed', errorClass(error));
  }
}
function finite(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function errorClass(error) { return String(error?.message || 'unknown').split(':')[0].slice(0, 80); }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
