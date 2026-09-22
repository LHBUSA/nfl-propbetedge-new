/* nfl-touchdown-targets-tuner — the PBE Touchdown Targets learning loop.
 *
 * ONE JOB, AND A LOT OF REFUSALS.
 *
 * Once a week it reads the finalized touchdown observations, and if — and only
 * if — the hard gate is open, it trains a challenger, evaluates it against the
 * champion on a chronological holdout, and promotes it only when every
 * criterion passes. Everything it does is written to the audit ledger whether
 * it promotes or not, so a rejection is as reviewable as a promotion.
 *
 * THE HARD GATE IS NOT NEGOTIABLE
 *   >= 100 finalized observations AND >= 4 distinct weeks.
 * The same gate the game-picks and passing-yards lanes use. Touchdown targets
 * produce observations faster than either of them, which is a reason to keep
 * the gate, not to lower it: a fast denominator is exactly when a lucky
 * numerator is most convincing.
 *
 * THERE IS NO TRAIN ROUTE AND NO PROMOTE ROUTE
 * Promotion happens inside a scheduled invocation, through an RPC that demotes
 * the incumbent and promotes one already-trained candidate under an advisory
 * lock. A candidate is always inserted UNPROMOTED, so a challenger cannot
 * publish a target even for the minutes between training and evaluation.
 *
 * MARKET SCOPE
 * Every read and every write is filtered to player_anytime_td. This lane
 * cannot read, train on, or promote anything belonging to passing yards or to
 * the game-picks engine, and their champions are invisible to it.
 */
import { select, insert, rpc } from '../../nfl-picks-engine-shared/supabase.mjs';
import { recordRun, readLane, laneHealth } from '../../nfl-picks-engine-shared/runs.mjs';
import { TD_MARKET, SELECTOR_VERSION_TAG } from '../../nfl-td-targets-shared/td-selector.mjs';
import { MODEL_VERSION } from '../../nfl-td-targets-shared/td-kernel.mjs';
import {
  MIN_FINALIZED, MIN_WEEKS, HOLDOUT_FRACTION, gateStatus, holdoutSplit,
  trainOverride, evaluate, promotionVerdict, promotedOverride,
} from '../../nfl-td-targets-shared/td-learning.mjs';

const SERVICE = 'nfl-touchdown-targets-tuner';
const VERSION = 'v1.0.0';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/health') return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
    return json({
      service: SERVICE,
      version: VERSION,
      market: TD_MARKET,
      model_version: MODEL_VERSION,
      selector: SELECTOR_VERSION_TAG,
      /* Health from the durable ledger, not from isolate memory: a module
       * variable is not evidence that a cron ran. */
      ledger: laneHealth(SERVICE, await readLane(env, SERVICE)),
      gate_requirements: {
        min_finalized: MIN_FINALIZED,
        min_distinct_weeks: MIN_WEEKS,
        holdout_fraction: HOLDOUT_FRACTION,
        roi_is_a_promotion_criterion: false,
      },
      routes: ['/health'],
      no_train_or_promote_route: true,
      requirements: {
        SUPABASE_URL: Boolean(env.SUPABASE_URL),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        PICKS_KV_BINDING: Boolean(env.PICKS_KV),
      },
    });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(scheduledTuning(env, event)); },
};

async function scheduledTuning(env, event) {
  const base = { version: VERSION, cron: event?.cron || null, started_at: new Date().toISOString() };
  try {
    const outcome = await runTuning(env);
    await recordRun(env, SERVICE, {
      ...base,
      status: 'ok',
      reason: outcome.result,
      counts: outcome.gate ? { finalized: outcome.gate.finalized, distinct_weeks: outcome.gate.distinct_weeks } : null,
      detail: { public: { market: TD_MARKET, gate: outcome.gate, verdict: outcome.verdict } },
    });
  } catch (error) {
    console.error(`[${SERVICE}] tuning failed class=${errorClass(error)}`);
    await recordRun(env, SERVICE, { ...base, status: 'failed', error_class: errorClass(error) });
  }
}

async function runTuning(env) {
  const observations = await select(
    env,
    'nfl_prop_learning_observations',
    `market=eq.${TD_MARKET}&is_final=eq.true&select=*&order=finalized_at.asc&limit=5000`,
  ) || [];

  const gate = gateStatus(observations);
  if (!gate.open) {
    /* A closed gate is a normal, healthy outcome and is recorded as one. It is
     * written to the ledger so the lane's liveness is provable during the
     * weeks — possibly months — when there is nothing to train. */
    await audit(env, 'td_tuner_gate_closed', null, { gate });
    return { result: `gated:${gate.reason}`, gate, verdict: null };
  }

  const championRows = await select(
    env,
    'nfl_prop_selector_models',
    `market=eq.${TD_MARKET}&promoted=is.true&select=*&order=version.desc&limit=1`,
  ) || [];
  const champion = championRows[0];
  if (!champion) throw new Error('no_promoted_td_selector');

  const split = holdoutSplit(observations);
  const candidateModel = trainOverride(split.train);

  /* Both are scored on the SAME holdout rows with the same code path. The
   * champion is scored as it actually publishes: through its override if it has
   * a trained one, and otherwise on the committed artefact's own probability,
   * which is the `model_prob` feature every observation carries. */
  const candidateScore = evaluate(candidateModel, split.test);
  const championScore = evaluate(promotedOverride(champion), split.test);
  const verdict = promotionVerdict({ candidate: candidateScore, champion: championScore, gate });

  /* Refit on the whole finalized sample only after the verdict is known. The
   * reported metrics stay the holdout metrics — refitting does not get to
   * improve the score that decided the promotion. */
  const retained = trainOverride(observations);

  const config = {
    ...(champion.config || {}),
    source: 'trained_td_override',
    selector: SELECTOR_VERSION_TAG,
    probability_model: MODEL_VERSION,
    probability_override: retained,
    validation: {
      method: 'chronological_holdout',
      train_rows: split.train.length,
      holdout_rows: split.test.length,
      candidate_holdout: candidateScore,
      champion_holdout: championScore,
      verdict_checks: verdict.checks,
      roi_reported_not_used: verdict.roi_reported_not_used,
    },
  };

  const inserted = await insert(env, 'nfl_prop_selector_models', {
    market: TD_MARKET,
    projection_model: MODEL_VERSION,
    config,
    trained: true,
    /* Always false. Promotion is a separate, locked, audited step. */
    promoted: false,
    training_rows: observations.length,
    trained_through_week: Math.max(...observations.map(row => Number(row.week) || 0)),
    backtest_brier: candidateScore?.brier ?? null,
    backtest_units: candidateScore?.roi?.units ?? null,
    backtest_clv_beat_pct: null,
    notes: verdict.promote
      ? `touchdown challenger passed the holdout: ${verdict.reason}`
      : `touchdown challenger rejected: ${verdict.reason}`,
  });
  const newVersion = Array.isArray(inserted) ? inserted[0]?.version : inserted?.version;
  if (!newVersion) throw new Error('td_candidate_insert_failed');

  await audit(env, 'td_training_run', newVersion, {
    gate,
    train_rows: split.train.length,
    holdout_rows: split.test.length,
    trainable_rows: candidateModel.training_rows,
    objective: candidateModel.objective,
  });
  await audit(env, 'td_selector_evaluation', newVersion, {
    candidate: candidateScore,
    champion: championScore,
    verdict,
    previous_champion: champion.version,
  });

  if (!verdict.promote) {
    await audit(env, 'td_selector_rejected', newVersion, { previous_champion: champion.version, reason: verdict.reason, checks: verdict.checks });
    return { result: `rejected v${newVersion}: ${verdict.reason}`, gate, verdict };
  }

  await rpc(env, 'nfl_promote_prop_selector', { p_version: newVersion, p_market: TD_MARKET });
  await audit(env, 'td_selector_promoted', newVersion, {
    previous_champion: champion.version,
    reason: verdict.reason,
    checks: verdict.checks,
    holdout: candidateScore,
  });
  return { result: `promoted v${newVersion}: ${verdict.reason}`, gate, verdict };
}

async function audit(env, eventType, version, detail) {
  try {
    await insert(env, 'nfl_prop_pick_audit_events', {
      pick_id: null,
      event_type: eventType,
      selector_version: version ?? null,
      detail: detail || {},
    }, { returning: 'minimal' });
  } catch (error) {
    console.error('[td-tuner-audit] failed', errorClass(error));
  }
}

function errorClass(error) { return String(error?.message || 'unknown').split(':')[0].slice(0, 80); }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
