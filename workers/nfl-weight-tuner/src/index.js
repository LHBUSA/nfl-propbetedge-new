/* nfl-weight-tuner — continuous production reweighting.
 *
 * Official publication does NOT wait on this worker. The promoted trained
 * champion stays live while finalized outcomes accumulate. This lane only
 * decides whether a measured confidence reweight is better than the incumbent.
 *
 * The production picker is a coherent one-margin model shared by moneyline and
 * spread. Replacing its coefficients with a generic pick-side classifier would
 * break that architecture, so v2 of the tuner learns one bounded
 * probability_scale from MONEYLINE outcomes only. Applying that scale to the
 * latent home-win probability moves moneyline and spread together.
 *
 * Every challenger is evaluated chronologically: oldest 80% fit, newest 20%
 * holdout. A weaker challenger is recorded and rejected. Promotion uses one
 * database RPC which demotes the incumbent and promotes the trained candidate
 * under an advisory lock.
 */

import { select, insert, audit, rpc } from '../../nfl-picks-engine-shared/supabase.mjs';
import { recordRun, readLane, laneHealth } from '../../nfl-picks-engine-shared/runs.mjs';

const SERVICE = 'nfl-weight-tuner';
const VERSION = 'v2.0.0';

export const MIN_MONEYLINE_DECISIONS = 24;
export const MIN_HOLDOUT_DECISIONS = 6;
export const HOLDOUT_FRACTION = 0.20;
export const MIN_BRIER_IMPROVEMENT = 0.001;
export const LOGLOSS_TOLERANCE = 0.00025;
export const SCALE_MIN = 0.50;
export const SCALE_MAX = 1.25;

const health = { last_cron_run: null, last_error_class: null, last_result: null, learning: null };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return json({
        service: SERVICE,
        version: VERSION,
        ledger: laneHealth(SERVICE, await readLane(env, SERVICE)),
        last_error_class: health.last_error_class,
        last_result: health.last_result,
        learning: health.learning,
        publication_gate: 'NONE',
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        },
      });
    }
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledTuning(env, event));
  },
};

async function scheduledTuning(env, event) {
  const startedAt = new Date().toISOString();
  await runTuning(env);
  await recordRun(env, SERVICE, {
    version: VERSION,
    cron: event?.cron || null,
    started_at: startedAt,
    status: health.last_error_class ? 'failed' : 'ok',
    reason: health.last_result,
    error_class: health.last_error_class,
    counts: health.learning,
  });
}

async function runTuning(env) {
  health.last_cron_run = new Date().toISOString();
  health.last_error_class = null;
  try {
    const champions = await select(
      env,
      'nfl_model_weights',
      'promoted=is.true&select=version,weights,training_rows&order=version.desc&limit=1',
    ) || [];
    const champion = champions[0];
    if (!champion) throw new Error('no_promoted_model');
    if (!trained(champion)) throw new Error('production_champion_not_trained');

    /* Learn only from the incumbent champion's own finalized moneyline calls.
       This makes an incremental scale mathematically interpretable even after
       previous reweights: each new fit acts on probabilities actually
       published by this champion. */
    const observations = await select(
      env,
      'nfl_learning_observations',
      `model_version=eq.${champion.version}&market=eq.moneyline&integrity_status=eq.eligible&is_final=is.true&outcome=in.(0,1)&select=pick_id,finalized_at,model_prob,outcome,season,week&order=finalized_at.asc&limit=5000`,
    ) || [];

    const learning = learningStatus(observations);
    health.learning = { champion_version: champion.version, ...learning };

    if (!learning.ready) {
      health.last_result = `learning:${learning.reason}`;
      return;
    }

    const { train, holdout } = chronologicalSplit(observations);
    const incrementalScale = fitCenterScale(train);
    const incumbentScale = boundedScale(champion?.weights?.meta?.probability_scale ?? 1);
    const absoluteScale = boundedScale(incumbentScale * incrementalScale);

    const incumbentScore = scoreRows(holdout, 1);
    const candidateScore = scoreRows(holdout, incrementalScale);
    const verdict = reweightVerdict(candidateScore, incumbentScore);

    const candidateWeights = JSON.parse(JSON.stringify(champion.weights || {}));
    candidateWeights.meta = {
      ...(candidateWeights.meta || {}),
      trained: true,
      source: 'continuous_holdout_reweight_v1',
      learning_mode: 'continuous_holdout_reweight_v1',
      probability_scale: Number(absoluteScale.toFixed(6)),
      parent_version: champion.version,
      training_rows: observations.length,
      train_rows: train.length,
      holdout_rows: holdout.length,
      fitted_incremental_scale: Number(incrementalScale.toFixed(6)),
    };

    const inserted = await insert(env, 'nfl_model_weights', {
      weights: candidateWeights,
      trained_through_week: latestWeek(observations),
      training_rows: observations.length,
      backtest_clv_beat_pct: null,
      backtest_brier: candidateScore.brier,
      backtest_units: null,
      promoted: false,
      promoted_at: null,
      notes: verdict.promote
        ? `continuous challenger accepted: ${verdict.reason}`
        : `continuous challenger rejected: ${verdict.reason}`,
    });
    const newVersion = Array.isArray(inserted) ? inserted[0]?.version : inserted?.version;
    if (!newVersion) throw new Error('candidate_insert_missing_version');

    await audit(env, {
      event_type: 'training_run',
      model_version: newVersion,
      detail: {
        mode: 'continuous_holdout_reweight_v1',
        incumbent: champion.version,
        train_rows: train.length,
        holdout_rows: holdout.length,
        incumbent_scale: incumbentScale,
        incremental_scale: incrementalScale,
        candidate_scale: absoluteScale,
      },
    });
    await audit(env, {
      event_type: 'challenger_evaluation',
      model_version: newVersion,
      detail: { incumbent: incumbentScore, candidate: candidateScore, verdict },
    });

    if (verdict.promote) {
      await rpc(env, 'nfl_promote_model_weight', { p_version: newVersion });
    }

    await audit(env, {
      event_type: verdict.promote ? 'champion_promoted' : 'champion_rejected',
      model_version: newVersion,
      detail: {
        previous_champion: champion.version,
        reason: verdict.reason,
        probability_scale: absoluteScale,
      },
    });

    health.last_result = verdict.promote
      ? `promoted v${newVersion}: ${verdict.reason}`
      : `rejected v${newVersion}: ${verdict.reason}`;
  } catch (error) {
    health.last_error_class = errorClass(error);
    health.last_result = `failed:${health.last_error_class}`;
    console.error(`[${SERVICE}] tuning failed class=${health.last_error_class}`);
  }
}

export function learningStatus(observations) {
  const rows = Array.isArray(observations) ? observations : [];
  const decided = rows.filter(validDecision);
  const holdout = Math.floor(decided.length * HOLDOUT_FRACTION);
  if (decided.length < MIN_MONEYLINE_DECISIONS) {
    return { rows: decided.length, holdout, ready: false, reason: `collecting_moneyline_outcomes:${decided.length}/${MIN_MONEYLINE_DECISIONS}` };
  }
  if (holdout < MIN_HOLDOUT_DECISIONS) {
    return { rows: decided.length, holdout, ready: false, reason: `collecting_holdout:${holdout}/${MIN_HOLDOUT_DECISIONS}` };
  }
  return { rows: decided.length, holdout, ready: true, reason: null };
}

export function chronologicalSplit(observations) {
  const rows = (Array.isArray(observations) ? observations : [])
    .filter(validDecision)
    .slice()
    .sort((a, b) => Date.parse(a.finalized_at || 0) - Date.parse(b.finalized_at || 0)
      || String(a.pick_id || '').localeCompare(String(b.pick_id || '')));
  const holdoutSize = Math.max(MIN_HOLDOUT_DECISIONS, Math.floor(rows.length * HOLDOUT_FRACTION));
  const cut = Math.max(1, rows.length - holdoutSize);
  return { train: rows.slice(0, cut), holdout: rows.slice(cut) };
}

/* Least-squares center scaling of the probabilities actually published by the
   incumbent: p' = .5 + scale * (p - .5). This is deterministic, bounded, and
   cannot flip a side. */
export function fitCenterScale(rows) {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows || []) {
    if (!validDecision(row)) continue;
    const x = Number(row.model_prob) - 0.5;
    const y = Number(row.outcome) - 0.5;
    numerator += x * y;
    denominator += x * x;
  }
  if (!(denominator > 0)) return 1;
  return boundedScale(numerator / denominator);
}

export function scoreRows(rows, incrementalScale = 1) {
  let brier = 0;
  let logloss = 0;
  let n = 0;
  for (const row of rows || []) {
    if (!validDecision(row)) continue;
    const raw = Number(row.model_prob);
    const p = Math.max(1e-6, Math.min(1 - 1e-6, 0.5 + incrementalScale * (raw - 0.5)));
    const y = Number(row.outcome);
    brier += (p - y) ** 2;
    logloss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    n += 1;
  }
  return {
    rows: n,
    brier: n ? Number((brier / n).toFixed(6)) : null,
    logloss: n ? Number((logloss / n).toFixed(6)) : null,
  };
}

export function reweightVerdict(candidate, incumbent) {
  if (!candidate?.rows || !incumbent?.rows || candidate.rows !== incumbent.rows) {
    return { promote: false, reason: 'holdout_unavailable' };
  }
  const brierGain = Number(incumbent.brier) - Number(candidate.brier);
  const loglossDelta = Number(candidate.logloss) - Number(incumbent.logloss);
  if (brierGain >= MIN_BRIER_IMPROVEMENT && loglossDelta <= LOGLOSS_TOLERANCE) {
    return {
      promote: true,
      reason: `holdout_brier_improved_${brierGain.toFixed(6)}_logloss_delta_${loglossDelta.toFixed(6)}`,
    };
  }
  return {
    promote: false,
    reason: `holdout_not_better_brier_gain_${brierGain.toFixed(6)}_logloss_delta_${loglossDelta.toFixed(6)}`,
  };
}

function validDecision(row) {
  const p = Number(row?.model_prob);
  const y = Number(row?.outcome);
  return Number.isFinite(p) && p > 0 && p < 1 && (y === 0 || y === 1);
}

function boundedScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, n));
}

function trained(champion) {
  const value = champion?.weights?.meta?.trained;
  return value === true || value === 'true';
}

function latestWeek(rows) {
  const values = (rows || []).map(r => Number(r.week)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
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
