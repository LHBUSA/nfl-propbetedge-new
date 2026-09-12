/* nfl-game-picks-orchestrator — emits official PBE game picks and serves the
 * read contract for the frontend.
 *
 * Decision rules come from the build brief; immutability and audit rules come
 * from NFL-PICKS-TRACK-RECORD-LEARNING-HANDOFF.md. Two invariants dominate:
 *
 *   1. A pick is written ONCE. Its line, price, features and model_version are
 *      never rewritten because the market later moved. Movement produces a
 *      kill or a supersede, never an edit.
 *   2. Only the highest promoted model version may publish. A challenger can
 *      never reach this code path.
 */

import {
  select, insert, patch, rpc, audit, latestPromotedWeights,
} from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  devigTwoWay, modelProbability, buildFeatureVector,
  confidenceBucket, qualifies, quarterKellyUnits, edgeThreshold,
  probToAmerican, KILL_THRESHOLD, selectedWinProbability, normalCdf,
  spreadCoverProbability, fairSpreadFromMargin, edgeAnomaly, monotonicityValid,
  expectedMarginFromWinProbability, SPREAD_SIGMA,
} from '../../nfl-picks-engine-shared/pick-math.mjs';
import {
  isIndoor, venueFor, restDaysBySchedule,
} from '../../nfl-picks-engine-shared/stadiums.mjs';
import { ratingUsable } from '../../nfl-picks-engine-shared/ratings.mjs';
import {
  loadSlate, issuable, cadenceDecision,
} from '../../nfl-picks-engine-shared/current-slate.mjs';
import {
  recordRun, readAllLanes, overallHealth, lastWorkRecord, readLane, laneHealth,
} from '../../nfl-picks-engine-shared/runs.mjs';
import {
  championPublishable, isTrainedChampion, issuanceScope, isCustomerFacing,
  UNTRAINED_STATE, SCOPE_OFFICIAL, SCOPE_TRACKING,
} from '../../nfl-picks-engine-shared/champion.mjs';

const SERVICE = 'nfl-game-picks-orchestrator';
const VERSION = 'v1.2.0';
const BOOTSTRAP_PROBABILITY_SHRINK = 0.20;
const MAX_BOOTSTRAP_MARGIN_RESIDUAL = 3.0;
const SIDE_FLIP_MIN_PROB_SHIFT = 0.05;
const SIDE_FLIP_MIN_LINE_SHIFT = 1.5;
const PICK_HORIZON_DAYS = 7;
/* The market tape is refreshed by the scheduled nfl-odds ingest (08/13/18 ET),
 * so the longest normal gap is ~14h (18:00 -> 08:00). A decision is never made
 * against a tape older than twice that. */
const TAPE_MAX_AGE_MS = 28 * 3600000;

/* Per-invocation scratch only. Nothing here is reported as evidence of a run —
 * /health reads the durable ledger in KV. */
let health = {};
function resetHealth() {
  health = {
    engine_state: 'ENGINE WAITING — upcoming slate not ready',
    last_result: null, last_error_class: null,
  };
}
resetHealth();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin, env) });
    }

    if (url.pathname === '/health') {
      /* Evidence comes from the persisted run ledger, never from this isolate. */
      const lane = laneHealth(SERVICE, await readLane(env, SERVICE));
      return json({
        service: SERVICE,
        version: VERSION,
        health: lane.state,
        health_reason: lane.reason,
        last_tick: lane.last_tick,
        last_work: lane.last_work,
        last_ok_at: lane.last_ok_at,
        last_error: lane.last_error,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          PICKS_INTERNAL_TOKEN: Boolean(env.PICKS_INTERNAL_TOKEN),
          NFL_CURRENT_BINDING: Boolean(env.NFL_CURRENT),
          PICKS_KV_BINDING: Boolean(env.PICKS_KV),
        },
      }, 200, origin, env);
    }

    /* Public-safe engine runtime evidence for the read contracts: per-lane
     * health from the durable ledger. Counts, timestamps and error classes
     * only — no pick, side, edge or feature ever appears here. */
    if (url.pathname === '/v1/engine/runs' && req.method === 'GET') {
      const lanes = await readAllLanes(env);
      return json({
        service: SERVICE, version: VERSION,
        generated_at: new Date().toISOString(),
        overall: overallHealth(lanes.filter(l => !l.lane.startsWith('nfl-prop'))),
        overall_props: overallHealth(lanes.filter(l => l.lane.startsWith('nfl-prop'))),
        lanes: lanes.map(publicLane),
      }, 200, origin, env);
    }

    if (url.pathname === '/v1/picks/current' && req.method === 'GET') {
      return currentPicks(req, env, origin);
    }

    if (url.pathname === '/v1/engine/state' && req.method === 'GET') {
      return engineState(req, env, origin);
    }

    /* Internal model read for the authenticated Pro backend. GET only, no CORS:
     * the browser never calls this and never holds the token. Separate secret
     * from PICKS_ADMIN_TOKEN on purpose — a read credential must not be able to
     * trigger a run, and an ops credential must not be spread to a web tier. */
    if (url.pathname === '/v1/evaluations/current') {
      if (req.method !== 'GET') {
        return json({ error: 'method_not_allowed', allow: 'GET', service: SERVICE, version: VERSION }, 405, origin, env);
      }
      return currentEvaluations(req, env, origin);
    }

    /* Ops-only manual run. POST only: a GET must never mutate the ledger, and
     * there is deliberately no CORS allowance — this is a server-to-server
     * curl path, not a browser one. */
    if (url.pathname === '/v1/engine/run-now') {
      if (req.method !== 'POST') {
        return json({ error: 'method_not_allowed', allow: 'POST', service: SERVICE, version: VERSION }, 405, origin, env);
      }
      return runNow(req, env, origin);
    }

    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404, origin, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledTick(env, event));
  },
};

/* Only the `public` block of a run's detail leaves the Worker. */
function publicLane(l) {
  const strip = r => r ? {
    status: r.status, reason: r.reason, error_class: r.error_class, started_at: r.started_at,
    finished_at: r.finished_at, version: r.version, counts: r.counts, source_freshness: r.source_freshness,
    detail: r.detail && r.detail.public ? r.detail.public : null,
  } : null;
  return { ...l, last_tick: strip(l.last_tick), last_work: strip(l.last_work) };
}

/* One cron (every 15 min). The cadence decision reads nfl-current and our own
 * persisted tape — neither costs a provider credit. */
async function scheduledTick(env, event) {
  const startedAt = new Date();
  const base = { version: VERSION, cron: event?.cron || null, started_at: startedAt.toISOString() };
  let slate;
  try {
    slate = await loadSlate(env);
  } catch (error) {
    await recordRun(env, SERVICE, { ...base, status: 'degraded', reason: 'current_state_unavailable', error_class: errorClass(error) });
    console.error(`[${SERVICE}] current state unavailable class=${errorClass(error)}`);
    return;
  }
  const last = await lastWorkRecord(env, SERVICE);
  const tape = await latestTapeCapturedAt(env).catch(() => null);
  const lastTape = last?.source_freshness?.tape_captured_at || null;
  const decision = cadenceDecision({
    games: slate.games,
    nowMs: startedAt.getTime(),
    lastWorkMs: Date.parse(last?.finished_at || '') || null,
    newTape: Boolean(tape && lastTape && Date.parse(tape) > Date.parse(lastTape)),
  });
  if (!decision.go) {
    await recordRun(env, SERVICE, {
      ...base, status: 'skipped', reason: decision.reason,
      detail: { public: { tier: decision.tier } },
      source_freshness: { tape_captured_at: tape, current_state_updated: slate.last_updated },
    });
    return;
  }
  await runOrchestration(env, slate, { ...base, tier: decision.tier, cadence_reason: decision.reason });
}

async function latestTapeCapturedAt(env) {
  const rows = await select(env, 'nfl_odds_snapshots', 'select=captured_at&order=captured_at.desc&limit=1');
  return Array.isArray(rows) && rows[0] ? rows[0].captured_at : null;
}

/* ---------------------------------------------------------------------------
 * Internal evaluations read (Phase 4B)
 *
 * Serves the sanitized Best Line model snapshot to ONE caller: the
 * authenticated NFL Pro backend in api/pbe-picks.js. Auth is
 * PICKS_INTERNAL_TOKEN as the x-pbe-internal-token header — the same secret
 * isInternal() already documents, now with a real consumer.
 *
 * Unset => 503, fail closed. An unconfigured secret is a misconfiguration, not
 * permission. The token is never echoed and never reaches a browser: the
 * browser talks to Vercel, Vercel talks to this endpoint.
 * ------------------------------------------------------------------------ */

async function currentEvaluations(req, env, origin) {
  const token = String(env.PICKS_INTERNAL_TOKEN || '').trim();
  if (!token) {
    return json({ error: 'internal_token_not_configured', service: SERVICE, version: VERSION }, 503, origin, env);
  }
  if (!isInternal(req, env)) {
    const presented = String(req.headers.get('x-pbe-internal-token') || '').trim();
    return json({
      error: presented ? 'invalid_internal_token' : 'missing_internal_token',
      service: SERVICE, version: VERSION,
    }, presented ? 403 : 401, origin, env);
  }
  if (!env.PICKS_KV) {
    return json({ error: 'picks_kv_unavailable', service: SERVICE, version: VERSION }, 503, origin, env);
  }
  const snapshot = await env.PICKS_KV.get(BESTLINE_EVAL_KEY, { type: 'json' }).catch(() => null);
  if (!snapshot) {
    return json({
      service: SERVICE, version: VERSION, contract: 'bestline-model-v2',
      evaluated_at: null, games: [], reason: 'no_evaluation_snapshot',
    }, 200, origin, env);
  }
  return json({ service: SERVICE, version: VERSION, ...snapshot }, 200, origin, env);
}

/* ---------------------------------------------------------------------------
 * Manual run (ops)
 *
 * Why this exists: the cron honours a cadence (6h off-hours), so triggering the
 * scheduled path while debugging usually records `skipped/not_due` and does not
 * refresh last_work. This endpoint bypasses the CADENCE and NOTHING ELSE. It
 * calls the same runOrchestration() the cron calls, so every champion,
 * publication, integrity, anomaly and totals gate applies unchanged.
 *
 * Auth is a dedicated Worker secret, PICKS_ADMIN_TOKEN, presented as
 * `Authorization: Bearer <token>`. Unset => fail closed (503): an unconfigured
 * secret must never mean "open". The token is never echoed in any response.
 * ------------------------------------------------------------------------ */

const RUN_NOW_LOCK_KEY = `lock:run-now:${SERVICE}`;
/* Guards a hung run from admitting a second one. */
const RUN_NOW_LOCK_TTL_S = 300;
/* Cooldown written once a run settles. 60s is the KV minimum expirationTtl. */
const RUN_NOW_COOLDOWN_S = 60;

function adminAuth(req, env) {
  const token = String(env.PICKS_ADMIN_TOKEN || '').trim();
  /* Fail closed. An absent secret is a misconfiguration, not permission. */
  if (!token) return { ok: false, status: 503, error: 'admin_token_not_configured' };
  const header = String(req.headers.get('authorization') || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const presented = match ? match[1].trim() : '';
  if (!presented) return { ok: false, status: 401, error: 'missing_bearer_token' };
  if (presented.length !== token.length) return { ok: false, status: 403, error: 'invalid_token' };
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ presented.charCodeAt(i);
  if (diff !== 0) return { ok: false, status: 403, error: 'invalid_token' };
  return { ok: true };
}

async function runNow(req, env, origin) {
  const auth = adminAuth(req, env);
  if (!auth.ok) {
    return json({ error: auth.error, service: SERVICE, version: VERSION }, auth.status, origin, env);
  }
  if (!env.PICKS_KV) {
    return json({ error: 'picks_kv_unavailable', service: SERVICE, version: VERSION }, 503, origin, env);
  }

  /* Duplicate-run guard. Two manual runs racing would both reconcile the same
   * games against the same tape. */
  const held = await env.PICKS_KV.get(RUN_NOW_LOCK_KEY).catch(() => null);
  if (held) {
    return json({
      error: 'run_already_in_progress', service: SERVICE, version: VERSION, locked_at: held,
    }, 429, origin, env);
  }
  await env.PICKS_KV.put(RUN_NOW_LOCK_KEY, new Date().toISOString(), { expirationTtl: RUN_NOW_LOCK_TTL_S });

  const startedAt = new Date();
  const base = {
    version: VERSION,
    cron: null,
    trigger: 'manual_admin',
    started_at: startedAt.toISOString(),
    tier: 'manual',
    cadence_reason: 'manual_admin',
  };

  try {
    /* nfl-current remains the only slate authority for a manual run too. */
    const slate = await loadSlate(env);
    const record = await runOrchestration(env, slate, base);
    return json({
      service: SERVICE,
      version: VERSION,
      trigger: 'manual_admin',
      status: record?.status ?? null,
      reason: record?.reason ?? null,
      error_class: record?.error_class ?? null,
      counts: record?.counts ?? null,
      source_freshness: record?.source_freshness ?? null,
      started_at: base.started_at,
      finished_at: record?.finished_at ?? null,
      detail: record?.detail?.public ?? null,
    }, 200, origin, env);
  } catch (error) {
    const cls = errorClass(error);
    await recordRun(env, SERVICE, {
      ...base, status: 'failed', reason: 'current_state_unavailable', error_class: cls,
    });
    return json({
      service: SERVICE, version: VERSION, trigger: 'manual_admin',
      status: 'failed', reason: 'current_state_unavailable', error_class: cls,
    }, 502, origin, env);
  } finally {
    /* Release the run guard but keep a short cooldown so a fat-fingered repeat
     * does not immediately re-run. */
    await env.PICKS_KV
      .put(RUN_NOW_LOCK_KEY, new Date().toISOString(), { expirationTtl: RUN_NOW_COOLDOWN_S })
      .catch(() => {});
  }
}

/* ---------------------------------------------------------------------------
 * Read contract
 *
 * Proprietary fields are stripped SERVER-SIDE for anyone without the internal
 * token. A free user never receives edge, sizing, model probability or the
 * feature snapshot — it is not hidden with CSS, it is never sent.
 * ------------------------------------------------------------------------ */

const PUBLIC_FIELDS = [
  'id', 'game_id', 'season', 'week', 'kickoff_ts', 'market', 'side',
  'market_line', 'market_price', 'confidence_bucket', 'model_version',
  'status', 'created_at',
];

const PRO_ONLY_FIELDS = [
  'model_prob', 'market_prob', 'edge_pct', 'stake_units', 'model_line', 'features',
];

function isInternal(req, env) {
  const token = String(env.PICKS_INTERNAL_TOKEN || '').trim();
  if (!token) return false;
  const presented = String(req.headers.get('x-pbe-internal-token') || '').trim();
  if (presented.length !== token.length) return false;
  /* Constant-time-ish compare; lengths already match. */
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

function publicView(pick) {
  const out = {};
  for (const field of PUBLIC_FIELDS) out[field] = pick[field] ?? null;
  return out;
}

function proView(pick) {
  const out = publicView(pick);
  for (const field of PRO_ONLY_FIELDS) out[field] = pick[field] ?? null;
  return out;
}

async function currentPicks(req, env, origin) {
  const full = isInternal(req, env);
  try {
    const { season, week } = await loadSlate(env);

    /* Customer-facing surfaces filter on publication_scope, NOT on the
     * champion's current trained flag. A bootstrap tracking row must stay
     * excluded even after the model is later trained — the classification at
     * issuance is authoritative. Filtered in the QUERY so tracking rows never
     * reach this Worker's memory, let alone the response. */
    const picks = await select(
      env, 'nfl_game_picks',
      `publication_scope=eq.${SCOPE_OFFICIAL}`
      + `&or=(status.eq.open,and(status.eq.graded,season.eq.${season},week.eq.${week}))`
      + '&select=*&order=kickoff_ts.asc&limit=200',
    ) || [];

    /* Defence in depth: even if the query filter were ever loosened, nothing
     * that is not classified official may be returned. */
    const customerFacing = picks.filter(isCustomerFacing);

    const ids = customerFacing.map(p => `"${p.id}"`).join(',');
    const grades = ids
      ? (await select(env, 'nfl_pick_grades', `pick_id=in.(${ids})&select=*`) || [])
      : [];
    const gradeById = new Map(grades.map(g => [g.pick_id, g]));

    const champion = await latestPromotedWeights(env).catch(() => null);
    const gate = championPublishable(champion);

    const rows = customerFacing.map(pick => {
      const view = full ? proView(pick) : publicView(pick);
      const grade = gradeById.get(pick.id) || null;
      view.grade = grade
        ? {
            result: grade.result,
            units_delta: grade.units_delta,
            clv_beat: grade.clv_beat,
            /* CLV magnitude and Brier are model diagnostics, not public. */
            ...(full ? { clv_points: grade.clv_points, clv_prob: grade.clv_prob, brier: grade.brier } : {}),
          }
        : null;
      return view;
    });

    /* An untrained champion is GATED, never "no qualified picks". Those are
     * different truths: one says the engine may not publish at all, the other
     * says a healthy trained champion evaluated the slate and declined. */
    const engineState = !gate.publishable
      ? gate.state
      : rows.length
        ? 'ENGINE LIVE — picks available'
        : 'ENGINE LIVE — no qualified picks';

    return json({
      service: SERVICE,
      version: VERSION,
      engine_state: engineState,
      publication_blocked_reason: gate.publishable ? null : gate.reason,
      season,
      week,
      model_version: champion?.version ?? null,
      champion_trained: isTrainedChampion(champion),
      /* The Verified Track Record begins at the first official pick. Bootstrap
       * tracking decisions are never part of it. */
      truth: 'verified_live_official_only',
      publication_scope: SCOPE_OFFICIAL,
      entitlement: full ? 'pro' : 'public',
      count: rows.length,
      picks: rows,
    }, 200, origin, env);
  } catch (error) {
    /* A backend failure must never render as "no picks". */
    return json({
      service: SERVICE,
      version: VERSION,
      engine_state: 'ENGINE DEGRADED — source unavailable',
      error_class: errorClass(error),
      picks: null,
    }, 503, origin, env);
  }
}

/* Governance state, from factual backend counts only. */
async function engineState(req, env, origin) {
  try {
    const champion = await latestPromotedWeights(env).catch(() => null);
    const observations = await select(
      env, 'nfl_learning_observations', 'integrity_status=eq.eligible&select=week,season,publication_scope&limit=5000',
    ) || [];
    const weeks = new Set(observations.map(o => `${o.season}-${o.week}`));
    const graded = observations.length;
    const trackingSample = observations.filter(o => o.publication_scope === SCOPE_TRACKING).length;
    const officialSample = observations.filter(o => o.publication_scope === SCOPE_OFFICIAL).length;
    const gateOpen = graded >= 100 && weeks.size >= 4;

    return json({
      service: SERVICE,
      version: VERSION,
      champion_version: champion?.version ?? null,
      champion_notes: champion?.notes ?? null,
      champion_trained: isTrainedChampion(champion),
      publication: championPublishable(champion).publishable ? 'ALLOWED' : 'GATED',
      publication_blocked_reason: championPublishable(champion).reason,
      challenger: 'Evaluating',
      auto_tuner: gateOpen ? 'ELIGIBLE' : 'GATED',
      graded_sample: graded,
      graded_sample_required: 100,
      graded_sample_tracking: trackingSample,
      graded_sample_official: officialSample,
      issuance_mode: issuanceScope(champion).mode,
      distinct_weeks: weeks.size,
      distinct_weeks_required: 4,
    }, 200, origin, env);
  } catch (error) {
    return json({ engine_state: 'ENGINE DEGRADED — source unavailable', error_class: errorClass(error) },
      503, origin, env);
  }
}

/* ---------------------------------------------------------------------------
 * Orchestration
 * ------------------------------------------------------------------------ */

/* Stamp the completion time ONCE, on the record that is both persisted and
 * returned. safeRecord() would otherwise mint it inside recordRun, leaving the
 * caller's copy with finished_at undefined — which is why POST /v1/engine/run-now
 * reported a null completion time for a run that had plainly finished. One
 * timestamp, one object: the response and the durable ledger cannot disagree. */
/* ---------------------------------------------------------------------------
 * Best Line model snapshot (Phase 4A)
 *
 * Derived from the SAME evaluate() outputs the orchestration loop already
 * produced. There is no second model path here and no recalculation: this only
 * reshapes what evaluate() returned into the minimum Best Line needs.
 *
 * Deliberately NOT stored: features, raw ratings, coefficient vectors, secrets,
 * admin metadata. A fair value is carried ONLY for an ELIGIBLE evaluation —
 * ANOMALY_REVIEW, MODEL_DISABLED and INPUT_UNAVAILABLE keep their status and
 * reason so the surface can explain itself, but carry no model numbers at all.
 * ------------------------------------------------------------------------ */

const BESTLINE_EVAL_KEY = 'eval:bestline:v2:current';

function sanitizeEvaluation(d, { market, tapeAt, evaluatedAt }) {
  const base = {
    market,
    side: d.side ?? null,
    team: d.selection_team ?? null,
    over_under: d.selection_over_under ?? null,
    side_is_home: d.side_is_home ?? null,
    integrity_status: d.integrity_status ?? null,
    integrity_reason: d.integrity_reason ?? null,
    integrity_warning: d.integrity_warning ?? null,
    market_line: d.market_line ?? null,
    market_price: d.market_price ?? null,
    evaluated_at: evaluatedAt,
    tape_captured_at: tapeAt,
  };
  /* Model numbers travel only with an ELIGIBLE evaluation. */
  if (d.integrity_status !== 'ELIGIBLE') {
    return { ...base, model_prob: null, model_line: null, market_prob: null, edge_pct: null };
  }
  return {
    ...base,
    model_prob: finiteOrNull(d.model_prob),
    model_line: finiteOrNull(d.model_line),
    market_prob: finiteOrNull(d.market_prob),
    edge_pct: finiteOrNull(d.edge_pct),
  };
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function persistRun(env, record) {
  record.finished_at = record.finished_at || new Date().toISOString();
  await recordRun(env, SERVICE, record);
  return record;
}

async function runOrchestration(env, slate, base) {
  resetHealth();
  const evaluations = [];
  /* Sanitized Best Line model snapshot, built from the same evaluate() calls. */
  const blGames = [];
  /* One evaluation instant for the whole run, so every stored side agrees. */
  const evaluatedAtIso = new Date().toISOString();
  const counts = {
    eligible_games: 0, evaluated_games: 0, no_tape: 0, stale_tape: 0,
    emitted: 0, kept: 0, killed: 0, superseded: 0, pass: 0, ratings_blocked: 0, scope_drain: 0,
    anomaly_review: 0, totals_disabled: 0,
  };
  let issuance = null;
  let newestTape = null;
  try {
    /* latestPromotedWeights THROWS 'no_promoted_model' when the table holds no
     * promoted row. That is a publication gate, not a source failure, so it is
     * converted to a null champion here — at this call site only, and for that
     * exact message only. Every other error (Supabase 5xx, network, bad query)
     * is rethrown so it still lands in the catch below as a runtime failure.
     * A blanket `.catch(() => null)` would hide real outages behind the gate. */
    let champion;
    try {
      champion = await latestPromotedWeights(env);
    } catch (error) {
      if (String(error?.message || error) !== 'no_promoted_model') throw error;
      champion = null;
    }

    /* ISSUANCE SCOPE. Decided from the champion row's own state before any
     * slate work. An untrained champion still evaluates real slates and
     * persists real pregame decisions, but as `tracking` — never as an
     * official customer-facing pick. */
    issuance = issuanceScope(champion);

    /* RUNTIME vs DECISION. Reaching this line means the Worker ran, its
     * bindings resolved and Supabase answered with the champion row — the
     * runtime did its job. "No promoted champion" is a PUBLICATION gate, not a
     * runtime fault, so it records status 'ok' and carries the gate in
     * detail.public. Recording it as 'degraded' pinned laneHealth to DEGRADED
     * forever (runs.mjs laneHealth), which made a correctly-gated engine
     * indistinguishable from a broken one. The gate itself is untouched:
     * nothing is issued below. */
    if (!issuance.canIssue) {
      health.engine_state = issuance.state;
      const record = {
        ...base, status: 'ok', reason: `decision_gated:${issuance.reason}`,
        counts,
        source_freshness: {
          current_state_updated: slate.last_updated,
          current_state_freshness: slate.freshness?.state || null,
        },
        detail: {
          public: {
            tier: base.tier,
            cadence_reason: base.cadence_reason ?? null,
            engine_state: issuance.state,
            issuance_mode: issuance.mode,
            decision_state: 'GATED',
            decision_reason: issuance.reason,
            publication: 'GATED',
            season: slate.season,
            week: slate.week,
          },
        },
      };
      console.log(`[${SERVICE}] decision gated ${issuance.reason} — runtime ok, emitting nothing`);
      return await persistRun(env, record);
    }

    /* Season and week come from nfl-current. So does eligibility: a game is
     * issuable only while the provider still calls it scheduled and its REAL
     * kickoff is ahead of us — a completed game can never be re-opened. */
    const season = slate.season;
    const now = Date.now();
    const games = slate.games
      .filter(g => issuable(g, now, PICK_HORIZON_DAYS * 86400000))
      .sort((a, b) => a.kickoff_ms - b.kickoff_ms);
    counts.eligible_games = games.length;

    if (!games.length) {
      health.engine_state = issuance.scope === SCOPE_TRACKING
        ? UNTRAINED_STATE
        : 'ENGINE WAITING — upcoming slate not ready';
      const record = {
        ...base, status: 'ok', reason: 'no_issuable_games', counts,
        detail: { public: { tier: base.tier, engine_state: health.engine_state, next_game: null } },
      };
      return await persistRun(env, record);
    }

    const ratings = await teamRatings(env, season);
    /* Rest days are calendar arithmetic on the published schedule; they do not
     * depend on live state. A failure here is not fatal — every team is then
     * scored on the documented 7-day default, which the snapshot records. */
    const rest = await restDays(env).catch(() => new Map());
    const blockedReasons = new Set();

    for (const game of games) {
      const week = game.week;
      /* Rest is derived from the full schedule, not the 7-day window, so a
       * team's previous game is visible even when it falls outside it. */
      const gameRest = rest.get(game.game_id) || {};
      game.rest_home = gameRest[game.home_team] ?? 7;
      game.rest_away = gameRest[game.away_team] ?? 7;

      const odds = await latestOddsFor(env, game.game_id);
      const tapeAt = odds.captured_at || null;
      if (tapeAt && (!newestTape || Date.parse(tapeAt) > Date.parse(newestTape))) newestTape = tapeAt;
      const record = {
        game_id: game.game_id,
        espn_id: game.espn_id,
        matchup: `${game.away_team} @ ${game.home_team}`,
        kickoff_ts: game.kickoff_ts,
        tape_captured_at: tapeAt,
        books: odds.books || 0,
        markets: [],
      };
      evaluations.push(record);

      const blGame = {
        game_id: game.game_id,
        away: game.away_team,
        home: game.home_team,
        kickoff_ts: game.kickoff_ts,
        tape_captured_at: tapeAt,
        books: odds.books || 0,
        markets: [],
      };
      blGames.push(blGame);

      if (!odds.size) { counts.no_tape += 1; record.outcome = 'no_market_tape'; blGame.outcome = 'no_market_tape'; continue; }
      /* Never decide on a market we have not observed recently. */
      if (!tapeAt || now - Date.parse(tapeAt) > TAPE_MAX_AGE_MS) {
        counts.stale_tape += 1;
        record.outcome = 'stale_market_tape';
        continue;
      }
      const weather = await weatherFor(game);
      /* One market anchor per game. ML is preferred because it directly
       * prices straight-up win probability; the current spread is the
       * fallback. Every market then shares the same latent home margin. */
      const marketAnchor = marketAnchorFor(odds);
      counts.evaluated_games += 1;
      record.outcome = 'evaluated';

      for (const market of ['spread', 'moneyline', 'total']) {
        const quotes = odds.get(market);
        if (!quotes || !quotes.length) { record.markets.push({ market, outcome: 'no_quote' }); continue; }

        const evaluated = quotes.map(quote =>
          evaluate({ game, market, quote, ratings, weather, champion, season, week, marketAnchor }));

        /* Snapshot EVERY evaluated side — issued or not. Best Line shows model
         * value whenever the engine evaluated the market successfully; it does
         * not require the edge to have qualified for issuance. */
        for (const d of evaluated) {
          blGame.markets.push(sanitizeEvaluation(d, { market, tapeAt, evaluatedAt: evaluatedAtIso }));
        }

        const disabled = evaluated.find(d => d.integrity_status === 'MODEL_DISABLED');
        if (disabled) {
          counts.totals_disabled += 1;
          record.markets.push({ market, outcome: 'model_disabled', reason: disabled.integrity_reason });
          continue;
        }

        const anomalies = evaluated.filter(d => d.integrity_status === 'ANOMALY_REVIEW');
        if (anomalies.length) {
          counts.anomaly_review += 1;
          await queueAnomaly(env, { game, market, champion, decisions: anomalies, season, week });
          const worst = anomalies.slice().sort((a, b) => Number(b.edge_pct || 0) - Number(a.edge_pct || 0))[0];
          record.markets.push({
            market, outcome: 'anomaly_review', side: worst?.side || null,
            edge_pct: worst?.edge_pct ?? null, reason: worst?.integrity_reason || 'decision_integrity_failure',
          });
          continue;
        }

        const decision = evaluated
          .slice()
          .sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || Number(b.edge_pct || -99) - Number(a.edge_pct || -99))[0];

        if (decision.ratings_available === false) {
          counts.ratings_blocked += 1;
          blockedReasons.add(decision.unavailable_reason);
          record.markets.push({ market, outcome: 'ratings_unavailable', reason: decision.unavailable_reason });
          continue;
        }

        const open = await openPickFor(env, game.game_id, market);
        const result = await reconcile(env, {
          open, decision, champion, game, market, season, week,
          scope: issuance.scope,
        });

        counts.emitted += result.emitted;
        counts.killed += result.killed;
        counts.superseded += result.superseded;
        counts.kept += result.kept;
        counts.scope_drain += result.scope_drain || 0;
        const outcome = result.superseded ? 'superseded'
          : result.emitted ? 'emitted'
            : result.killed ? 'killed'
              : result.kept ? 'kept'
                : result.scope_drain ? 'scope_drain' : 'pass';
        if (outcome === 'pass') counts.pass += 1;
        record.markets.push({
          market,
          outcome,
          side: decision.side,
          edge_pct: decision.edge_pct,
          threshold: edgeThreshold(market),
          qualifies: decision.qualifies,
          stake_units: decision.stake_units,
          confidence_bucket: decision.confidence_bucket,
          integrity_warning: decision.integrity_warning || null,
          pass_reason: outcome === 'pass'
            ? (decision.qualifies ? 'stake_zero' : `edge_${decision.edge_pct}_below_threshold_${edgeThreshold(market)}`)
            : null,
        });
      }
    }

    /* Three distinct internal truths, never conflated:
     *   - source degradation  : we could not evaluate
     *   - bootstrap tracking  : we evaluated, but the model may not publish
     *   - genuinely zero      : a trained champion evaluated and declined
     * "no qualified picks" is reserved for the last case alone. */
    const couldNotLook = counts.evaluated_games === 0
      || (counts.ratings_blocked > 0 && !counts.emitted && !counts.kept && !counts.pass);
    if (couldNotLook) {
      health.engine_state = 'ENGINE DEGRADED — source unavailable';
    } else if (issuance.scope === SCOPE_TRACKING) {
      health.engine_state = UNTRAINED_STATE;
    } else if (counts.emitted || counts.kept) {
      health.engine_state = 'ENGINE LIVE — picks available';
    } else {
      health.engine_state = 'ENGINE LIVE — no qualified picks';
    }

    /* Detailed per-market evaluation (sides, edges) stays PRIVATE in KV — it
     * describes tracking decisions that must never reach a public surface. */
    try {
      await env.PICKS_KV?.put(`eval:last:${SERVICE}`, JSON.stringify({
        at: new Date().toISOString(), scope: issuance.scope, season, games: evaluations,
      }), { expirationTtl: 30 * 86400 });
    } catch (_) { /* the ledger write below still records the run */ }

    /* Best Line model snapshot: the sanitized, stable contract. Same evaluate()
     * outputs as above, reshaped — never recomputed. Read back only through the
     * internal-token endpoint, never served publicly. */
    try {
      await env.PICKS_KV?.put(BESTLINE_EVAL_KEY, JSON.stringify({
        contract: 'bestline-model-v2',
        evaluated_at: evaluatedAtIso,
        tape_captured_at: newestTape,
        season,
        week: slate.week,
        model_version: champion?.version ?? null,
        trained: isTrainedChampion(champion),
        issuance_scope: issuance.scope,
        games: blGames,
      }), { expirationTtl: 7 * 86400 });
    } catch (_) { /* non-fatal: Best Line falls back to its locked state */ }

    const next = games[0];
    const record = {
      ...base,
      status: couldNotLook ? 'degraded' : 'ok',
      reason: couldNotLook
        ? (counts.ratings_blocked ? 'ratings_unavailable' : counts.stale_tape ? 'stale_market_tape' : 'no_market_tape')
        : `scope=${issuance.scope}`,
      counts,
      source_freshness: {
        tape_captured_at: newestTape,
        current_state_updated: slate.last_updated,
        current_state_freshness: slate.freshness?.state || null,
      },
      detail: {
        public: {
          tier: base.tier,
          cadence_reason: base.cadence_reason,
          engine_state: health.engine_state,
          issuance_mode: issuance.mode,
          season,
          week: slate.week,
          next_game: next
            ? { game_id: next.game_id, matchup: `${next.away_team} @ ${next.home_team}`, kickoff_ts: next.kickoff_ts }
            : null,
          /* Per-game coverage without any decision content. */
          games: evaluations.map(e => ({
            game_id: e.game_id,
            matchup: e.matchup,
            kickoff_ts: e.kickoff_ts,
            tape_captured_at: e.tape_captured_at,
            books: e.books,
            coverage: e.outcome,
            markets_evaluated: e.markets.filter(m => !['no_quote', 'ratings_unavailable'].includes(m.outcome)).length,
          })),
          ratings_blocked_reasons: [...blockedReasons].slice(0, 5),
        },
      },
    };
    return await persistRun(env, record);
  } catch (error) {
    health.engine_state = 'ENGINE DEGRADED — source unavailable';
    health.last_error_class = errorClass(error);
    console.error(`[${SERVICE}] orchestration failed class=${health.last_error_class}`);
    const record = {
      ...base,
      status: 'failed',
      error_class: health.last_error_class,
      counts,
      detail: { public: { tier: base?.tier, engine_state: health.engine_state } },
    };
    return persistRun(env, record);
  }
}

/* Pure decision step — exported so acceptance tests can drive it with fixtures
 * and no network. */
export function evaluate({ game, market, quote, ratings, weather, champion, season, week, marketAnchor = null }) {
  const selectedIsHome = quote.selected_is_home === true;

  /* Totals are intentionally unavailable until they have a dedicated expected-
   * total model. The former implementation scored OVER and UNDER from the same
   * feature vector, which made opposite sides receive identical probabilities. */
  if (market === 'total') {
    return {
      qualifies: false, ratings_available: true, unavailable_reason: null,
      integrity_status: 'MODEL_DISABLED', integrity_reason: 'dedicated_total_model_required',
      integrity_warning: null, side: quote.side, market_line: quote.line ?? null,
      market_price: quote.price, model_line: null, model_prob: null, market_prob: null,
      edge_pct: 0, confidence_bucket: null, stake_units: 0, features: null,
      selection_team: null, selection_over_under: quote.over_under ?? null, side_is_home: null,
      kickoff_ts: game.kickoff_ts, season, week,
    };
  }

  const homeRating = ratings.get(game.home_team);
  const awayRating = ratings.get(game.away_team);
  const homeCheck = ratingUsable(homeRating);
  const awayCheck = ratingUsable(awayRating);
  if (!homeCheck.usable || !awayCheck.usable) {
    return {
      qualifies: false, ratings_available: false,
      unavailable_reason: !homeCheck.usable ? `${game.home_team}:${homeCheck.reason}` : `${game.away_team}:${awayCheck.reason}`,
      integrity_status: 'INPUT_UNAVAILABLE', integrity_reason: 'ratings_unavailable', integrity_warning: null,
      side: quote.side, edge_pct: 0, stake_units: 0, confidence_bucket: null, features: null,
      selection_team: quote.team ?? null, selection_over_under: null, side_is_home: selectedIsHome,
    };
  }

  if (typeof quote.selected_is_home !== 'boolean' || !quote.team) {
    return {
      qualifies: false, ratings_available: true, integrity_status: 'ANOMALY_REVIEW',
      integrity_reason: 'missing_side_attribution', integrity_warning: null, side: quote.side,
      market_line: quote.line ?? null, market_price: quote.price, model_line: null, model_prob: null,
      market_prob: null, edge_pct: 0, confidence_bucket: null, stake_units: 0, features: null,
      selection_team: quote.team ?? null, selection_over_under: null, side_is_home: null,
      kickoff_ts: game.kickoff_ts, season, week,
    };
  }

  const integrityVersion = Number(champion?.weights?.meta?.integrity_version || 0);
  const dome = isIndoor(game.home_team);
  /* One canonical HOME-perspective vector drives both moneyline and spread.
   * No quote direction or current market tick is allowed to change the latent
   * team-strength projection, which prevents paired-market contradictions. */
  const features = buildFeatureVector({
    off_epa_diff: num(homeRating.off_epa_play) - num(awayRating.def_epa_play),
    def_epa_diff: num(awayRating.off_epa_play) - num(homeRating.def_epa_play),
    qb_tier_diff: num(awayRating.qb_tier) - num(homeRating.qb_tier),
    rest_diff: num(game.rest_home) - num(game.rest_away),
    home: true,
    dome,
    wind15: !dome && weather?.wind_mph >= 15,
    cold25: !dome && weather?.temp_f <= 25,
    proe_diff: num(homeRating.proe) - num(awayRating.proe),
    pace_sum: num(homeRating.pace) + num(awayRating.pace),
    line_move: 0,
    week,
  });

  const anchor = validAnchor(marketAnchor) ? marketAnchor : quoteMarketAnchor(market, quote);
  if (!validAnchor(anchor)) {
    return {
      qualifies: false, ratings_available: true, integrity_status: 'ANOMALY_REVIEW',
      integrity_reason: 'market_anchor_unavailable', integrity_warning: null, side: quote.side,
      market_line: quote.line ?? null, market_price: quote.price, model_line: null, model_prob: null,
      market_prob: null, edge_pct: 0, confidence_bucket: null, stake_units: 0, features,
      selection_team: quote.team ?? null, selection_over_under: null, side_is_home: selectedIsHome,
      kickoff_ts: game.kickoff_ts, season, week,
    };
  }

  const rawHomeWin = modelProbability(champion.weights, features);
  const priorMargin = expectedMarginFromWinProbability(rawHomeWin);
  const anchorMargin = expectedMarginFromWinProbability(anchor.home_win_prob);
  const requestedWeight = Number(champion?.weights?.meta?.market_anchor_weight ?? BOOTSTRAP_PROBABILITY_SHRINK);
  const residualWeight = Number.isFinite(requestedWeight)
    ? Math.max(0, Math.min(0.50, requestedWeight)) : BOOTSTRAP_PROBABILITY_SHRINK;
  const requestedCap = Number(champion?.weights?.meta?.max_margin_residual_points ?? MAX_BOOTSTRAP_MARGIN_RESIDUAL);
  const residualCap = Number.isFinite(requestedCap) ? Math.max(0.5, Math.min(7, requestedCap)) : MAX_BOOTSTRAP_MARGIN_RESIDUAL;
  const rawResidual = (priorMargin - anchorMargin) * residualWeight;
  const residual = Math.max(-residualCap, Math.min(residualCap, rawResidual));
  const modelHomeMargin = anchorMargin + residual;
  const homeWin = normalCdf(modelHomeMargin / SPREAD_SIGMA);
  const selectedWin = selectedWinProbability(homeWin, selectedIsHome);

  let modelProb;
  let modelLine;
  if (market === 'moneyline') {
    modelProb = selectedWin;
    modelLine = Number(probToAmerican(modelProb));
  } else if (market === 'spread') {
    const line = Number(quote.line);
    if (!Number.isFinite(line)) {
      return {
        qualifies: false, ratings_available: true, integrity_status: 'ANOMALY_REVIEW',
        integrity_reason: 'spread_line_missing', integrity_warning: null, side: quote.side,
        market_line: quote.line ?? null, market_price: quote.price, model_line: null, model_prob: null,
        market_prob: null, edge_pct: 0, confidence_bucket: null, stake_units: 0, features,
        selection_team: quote.team ?? null, selection_over_under: null, side_is_home: selectedIsHome,
        kickoff_ts: game.kickoff_ts, season, week,
      };
    }
    modelProb = spreadCoverProbability({ homeWinProb: homeWin, selectedIsHome, line });
    modelLine = Number(fairSpreadFromMargin({ homeWinProb: homeWin, selectedIsHome }).toFixed(2));
  } else {
    throw new Error(`bad_market:${market}`);
  }

  const marketProb = devigTwoWay(quote.price, quote.opposite_price);
  const edge = Number((modelProb - marketProb).toFixed(6));
  const edgeState = edgeAnomaly(edge);
  const coherent = market !== 'spread' || monotonicityValid({
    winProb: selectedWin, coverProb: modelProb, line: Number(quote.line),
  });

  let integrityStatus = 'ELIGIBLE';
  let integrityReason = null;
  if (integrityVersion < 2) { integrityStatus = 'ANOMALY_REVIEW'; integrityReason = 'model_integrity_version_lt_2'; }
  else if (!coherent) { integrityStatus = 'ANOMALY_REVIEW'; integrityReason = 'spread_moneyline_monotonicity_failure'; }
  else if (edgeState.hard) { integrityStatus = 'ANOMALY_REVIEW'; integrityReason = edgeState.reason; }

  const bucket = integrityStatus === 'ELIGIBLE' ? confidenceBucket(edge, market) : null;
  const doesQualify = integrityStatus === 'ELIGIBLE' && qualifies(edge, market) && bucket !== null;

  return {
    qualifies: doesQualify, ratings_available: true, unavailable_reason: null,
    integrity_status: integrityStatus, integrity_reason: integrityReason,
    integrity_warning: edgeState.warn && !edgeState.hard ? edgeState.reason : null,
    integrity_context: { anchor_source: anchor.source, anchor_home_win_prob: Number(anchor.home_win_prob.toFixed(6)), model_home_margin: Number(modelHomeMargin.toFixed(3)), residual_points: Number(residual.toFixed(3)) },
    side: quote.side, selection_team: quote.team ?? null, selection_over_under: null,
    side_is_home: selectedIsHome, market_line: quote.line ?? null, market_price: quote.price,
    model_line: modelLine, model_prob: Number(modelProb.toFixed(6)),
    market_prob: Number(marketProb.toFixed(6)), edge_pct: edge, confidence_bucket: bucket,
    stake_units: bucket ? quarterKellyUnits(modelProb, quote.price) : 0, features,
    kickoff_ts: game.kickoff_ts, season, week,
  };
}

/* Lifecycle. This is the only place a pick's status changes, and it never
 * edits an issued pick's economic terms. */
async function reconcile(env, { open, decision, champion, game, market, season, week, scope }) {
  const tally = { emitted: 0, killed: 0, superseded: 0, kept: 0, scope_drain: 0 };

  /* Defence in depth: anomaly/model-disabled outputs can never reach the pick ledger. */
  if (decision.integrity_status && decision.integrity_status !== 'ELIGIBLE') return tally;

  const issuanceRow = {
    game_id: game.game_id,
    season, week,
    kickoff_ts: decision.kickoff_ts,
    market,
    side: decision.side,
    market_line: decision.market_line,
    market_price: decision.market_price,
    model_line: decision.model_line,
    model_prob: decision.model_prob,
    market_prob: decision.market_prob,
    edge_pct: decision.edge_pct,
    stake_units: decision.stake_units,
    confidence_bucket: decision.confidence_bucket,
    features: decision.features,
    model_version: champion.version,
    publication_scope: scope,
    integrity_status: 'eligible',
    integrity_reason: null,
    /* Canonical attribution, persisted at issuance and frozen by the database.
     * Grading reads these, never the display string. */
    selection_team: decision.selection_team,
    selection_over_under: decision.selection_over_under,
    side_is_home: decision.side_is_home,
    status: 'open',
  };

  async function auditIssuance(pickId) {
    await audit(env, {
      pick_id: pickId, event_type: 'pick_created', model_version: champion.version,
      detail: {
        market, side: decision.side, edge_pct: decision.edge_pct,
        publication_scope: scope,
        selection_team: decision.selection_team,
        selection_over_under: decision.selection_over_under,
        side_is_home: decision.side_is_home,
      },
    });
    await audit(env, {
      pick_id: pickId, event_type: 'features_locked', model_version: champion.version,
      detail: { features: decision.features },
    });
    await audit(env, {
      pick_id: pickId, event_type: 'issuance_market_state', model_version: champion.version,
      detail: {
        line: decision.market_line, price: decision.market_price,
        market_prob: decision.market_prob,
      },
    });
  }

  if (!open) {
    if (!decision.qualifies || decision.stake_units <= 0) return tally;
    const row = await insert(env, 'nfl_game_picks', issuanceRow);
    const pickId = Array.isArray(row) ? row[0]?.id : row?.id;
    await auditIssuance(pickId);
    tally.emitted = 1;
    return tally;
  }

  /* SCOPE TRANSITION — "bootstrap drain".
   *
   * one_open_pick_per_market is scope-agnostic, so an open tracking decision
   * and an open official decision cannot coexist for the same (game_id,
   * market). When the champion becomes trained, the incumbent tracking
   * decision is deliberately LEFT ALONE: it stays open, plays out, and is
   * graded, which preserves the learning observation that earned the gate.
   *
   * It is never superseded by the official pick (that would destroy the
   * observation) and never reclassified (the database forbids it). Official
   * issuance simply begins with the next (game_id, market) that has no open
   * tracking decision — normally the following week.
   */
  if (open.publication_scope && open.publication_scope !== scope) {
    tally.scope_drain = 1;
    return tally;
  }

  const sideFlipped = decision.side && decision.side !== open.side;

  if (sideFlipped && decision.qualifies && decision.stake_units > 0 && !flipAllowed(open, decision, market)) {
    /* Hysteresis: a one-tick price wobble cannot reverse a frozen decision.
     * The old side remains until the latent probability meaningfully moves,
     * or a spread crosses by at least 1.5 points. Totals are disabled. */
    tally.kept = 1;
    return tally;
  }

  if (sideFlipped && decision.qualifies && decision.stake_units > 0) {
    /* Atomic: the function supersedes the incumbent and inserts the
     * replacement in one transaction, so the partial unique index never sees
     * two open rows. Doing this as two PostgREST calls conflicts. */
    const newId = await rpc(env, 'nfl_replace_open_pick', {
      p_open_id: open.id,
      p_game_id: issuanceRow.game_id,
      p_season: issuanceRow.season,
      p_week: issuanceRow.week,
      p_kickoff_ts: issuanceRow.kickoff_ts,
      p_market: issuanceRow.market,
      p_side: issuanceRow.side,
      p_market_line: issuanceRow.market_line,
      p_market_price: issuanceRow.market_price,
      p_model_line: issuanceRow.model_line,
      p_model_prob: issuanceRow.model_prob,
      p_market_prob: issuanceRow.market_prob,
      p_edge_pct: issuanceRow.edge_pct,
      p_stake_units: issuanceRow.stake_units,
      p_confidence_bucket: issuanceRow.confidence_bucket,
      p_features: issuanceRow.features,
      p_model_version: issuanceRow.model_version,
      p_publication_scope: issuanceRow.publication_scope,
      p_selection_team: issuanceRow.selection_team,
      p_selection_over_under: issuanceRow.selection_over_under,
      p_side_is_home: issuanceRow.side_is_home,
    });
    await auditIssuance(newId);
    await audit(env, {
      pick_id: open.id, event_type: 'pick_superseded', model_version: champion.version,
      detail: { superseded_by: newId, from_side: open.side, to_side: decision.side },
    });
    tally.superseded = 1; tally.emitted = 1;
    return tally;
  }

  if (!decision.qualifies && decision.edge_pct < KILL_THRESHOLD) {
    await patch(env, 'nfl_game_picks', `id=eq.${open.id}`, { status: 'killed' });
    await audit(env, {
      pick_id: open.id, event_type: 'pick_killed', model_version: champion.version,
      detail: { reason: 'edge_collapsed', edge_pct: decision.edge_pct },
    });
    tally.killed = 1;
    return tally;
  }

  /* Still qualified and same side: leave the original pick exactly as issued.
   * Re-emitting at a better number would be rewriting history. */
  tally.kept = 1;
  return tally;
}

export function marketAnchorFor(odds) {
  const ml = odds?.get?.('moneyline') || [];
  const homeMl = ml.find(q => q.selected_is_home === true);
  if (homeMl) {
    try {
      const p = devigTwoWay(homeMl.price, homeMl.opposite_price);
      if (p > 0 && p < 1) return { home_win_prob: p, source: 'consensus_moneyline' };
    } catch (_) {}
  }
  const spread = odds?.get?.('spread') || [];
  const homeSpread = spread.find(q => q.selected_is_home === true && Number.isFinite(Number(q.line)));
  if (homeSpread) {
    const homeMargin = -Number(homeSpread.line);
    const p = normalCdf(homeMargin / SPREAD_SIGMA);
    if (p > 0 && p < 1) return { home_win_prob: p, source: 'consensus_spread' };
  }
  return null;
}

function quoteMarketAnchor(market, quote) {
  try {
    if (market === 'moneyline') {
      const selected = devigTwoWay(quote.price, quote.opposite_price);
      return { home_win_prob: quote.selected_is_home === true ? selected : 1 - selected, source: 'quote_moneyline_fallback' };
    }
    if (market === 'spread' && Number.isFinite(Number(quote.line))) {
      const selectedMargin = -Number(quote.line);
      const homeMargin = quote.selected_is_home === true ? selectedMargin : -selectedMargin;
      return { home_win_prob: normalCdf(homeMargin / SPREAD_SIGMA), source: 'quote_spread_fallback' };
    }
  } catch (_) {}
  return null;
}

function validAnchor(anchor) {
  const p = Number(anchor?.home_win_prob);
  return Number.isFinite(p) && p > 0.01 && p < 0.99;
}

export function flipAllowed(open, decision, market) {
  if (!open || !decision || market === 'total') return false;
  const oldProb = Number(open.model_prob);
  const newProb = Number(decision.model_prob);
  if (!Number.isFinite(oldProb) || !Number.isFinite(newProb)) return false;
  /* Compare the new opposite-side probability with the complement of what the
   * old model believed at issuance. Market-only price noise produces ~0. */
  const probabilityShift = Math.abs(newProb - (1 - oldProb));
  let lineShift = 0;
  if (market === 'spread') {
    const oldLine = Number(open.market_line), newLine = Number(decision.market_line);
    if (Number.isFinite(oldLine) && Number.isFinite(newLine)) {
      lineShift = Math.abs(Math.abs(newLine) - Math.abs(oldLine));
    }
  }
  return probabilityShift >= SIDE_FLIP_MIN_PROB_SHIFT
    || (probabilityShift >= 0.02 && lineShift >= SIDE_FLIP_MIN_LINE_SHIFT);
}

async function queueAnomaly(env, { game, market, champion, decisions, season, week }) {
  const first = decisions[0] || {};
  const type = first.integrity_reason || 'decision_integrity_failure';
  try {
    const existing = await select(
      env, 'nfl_pick_anomalies',
      `game_id=eq.${encodeURIComponent(game.game_id)}&market=eq.${market}&model_version=eq.${champion.version}&anomaly_type=eq.${encodeURIComponent(type)}&status=eq.open&select=id&limit=1`,
    ) || [];
    if (existing.length) return;
    await insert(env, 'nfl_pick_anomalies', {
      game_id: game.game_id, season, week, market, model_version: champion.version,
      anomaly_type: type, status: 'open',
      detail: {
        matchup: `${game.away_team} @ ${game.home_team}`,
        candidates: decisions.map(d => ({
          side: d.side, line: d.market_line, model_prob: d.model_prob, market_prob: d.market_prob,
          edge_pct: d.edge_pct, reason: d.integrity_reason, warning: d.integrity_warning || null,
        })),
      },
    });
  } catch (error) {
    console.error(`[${SERVICE}] anomaly queue failed class=${errorClass(error)}`);
  }
}

/* ---------------------------------------------------------------------------
 * Inputs
 * ------------------------------------------------------------------------ */

async function openPickFor(env, gameId, market) {
  const rows = await select(
    env, 'nfl_game_picks',
    `game_id=eq.${encodeURIComponent(gameId)}&market=eq.${market}&status=eq.open&select=*&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function restDays(env) {
  const base = String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
  const response = await fetch(`${base}/api/schedule`, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`gateway_${response.status}`);
  const body = await response.json();
  return restDaysBySchedule(Array.isArray(body?.games) ? body.games : []);
}

async function teamRatings(env, season) {
  const rows = await select(
    env, 'nfl_team_ratings',
    `season=eq.${season}&select=*&order=as_of_week.desc&limit=600`,
  ) || [];
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.team)) latest.set(row.team, row);
  return latest;
}

/* Latest snapshot per market for a game, paired with its opposite side so the
 * price can be de-vigged. */
async function latestOddsFor(env, gameId) {
  const rows = await select(
    env, 'nfl_odds_snapshots',
    `game_id=eq.${encodeURIComponent(gameId)}&select=*&order=captured_at.desc&limit=300`,
  ) || [];

  const byMarket = new Map();
  for (const row of rows) {
    if (!byMarket.has(row.market)) byMarket.set(row.market, []);
    byMarket.get(row.market).push(row);
  }

  /* Returns EVERY current side per market, each with its true home/away
   * attribution as recorded at capture time. The caller evaluates both sides
   * and lets the edge decide — there is no default side and no assumption
   * that the selection is the home team. */
  const out = new Map();
  /* Which market observation this decision rests on, carried into the run
   * ledger so staleness is provable rather than assumed. */
  out.captured_at = rows[0]?.captured_at || null;
  out.books = new Set(rows.filter(r => r.captured_at === out.captured_at).map(r => r.book)).size;
  for (const [market, list] of byMarket) {
    const newest = list[0]?.captured_at;
    const current = list.filter(r => r.captured_at === newest);
    if (current.length < 2) continue;

    const quotes = [];
    for (const row of current) {
      const opposite = current.find(r => otherSide(market, row, r));
      if (!opposite) continue;

      /* Line movement for THIS side: oldest observation of the same
       * selection, compared to now. */
      const history = list.filter(r => sameSelection(market, r, row));
      const oldest = history[history.length - 1];
      const lineMove = Number.isFinite(Number(row.line)) && Number.isFinite(Number(oldest?.line))
        ? Number(row.line) - Number(oldest.line)
        : 0;

      quotes.push({
        side: row.side,
        line: row.line,
        price: row.price,
        opposite_price: opposite.price,
        line_move: lineMove,
        /* Attribution comes from the stored column, never from position.
         * Totals carry null, which the feature builder treats as not-home. */
        selected_is_home: row.is_home === true,
        team: row.team,
        over_under: row.over_under,
        book: row.book,
      });
    }
    if (quotes.length) out.set(market, quotes);
  }
  return out;
}

function sameSelection(market, a, b) {
  return market === 'total' ? a.over_under === b.over_under : a.team === b.team;
}

function otherSide(market, a, b) {
  return market === 'total'
    ? Boolean(a.over_under && b.over_under && a.over_under !== b.over_under)
    : Boolean(a.team && b.team && a.team !== b.team);
}

/* Open-Meteo needs no API key. It is a NEW external dependency, distinct from
 * the odds provider the brief told us not to duplicate. If it is unavailable
 * the weather features degrade to 0 rather than blocking a pick, and the
 * feature snapshot records exactly the zeros that were used. */
async function weatherFor(game) {
  if (isIndoor(game.home_team)) return { wind_mph: 0, temp_f: 60, source: 'roofed' };
  try {
    const venue = venueFor(game.home_team);
    if (!venue) return null;
    const { lat, lon } = venue;
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${lat}&longitude=${lon}`
      + '&hourly=temperature_2m,wind_speed_10m&temperature_unit=fahrenheit'
      + '&wind_speed_unit=mph&forecast_days=8';
    const response = await fetch(url, { cf: { cacheTtl: 1800 } });
    if (!response.ok) return null;
    const body = await response.json();
    const idx = nearestHourIndex(body?.hourly?.time, game.kickoff_ts);
    if (idx < 0) return null;
    return {
      wind_mph: Number(body.hourly.wind_speed_10m?.[idx] ?? 0),
      temp_f: Number(body.hourly.temperature_2m?.[idx] ?? 60),
      source: 'open-meteo',
    };
  } catch (_) {
    return null;
  }
}

function nearestHourIndex(times, kickoffIso) {
  if (!Array.isArray(times) || !kickoffIso) return -1;
  const target = Date.parse(kickoffIso);
  let best = -1, bestDiff = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const diff = Math.abs(Date.parse(times[i]) - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errorClass(error) {
  return String(error?.message || 'unknown').split(':')[0].slice(0, 60);
}

function cors(origin, env) {
  const app = String(env?.APP_ORIGIN || 'https://nfl.propbetedge.ai').replace(/\/$/, '');
  return {
    'access-control-allow-origin': !origin || origin === app ? app : 'null',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'content-type,x-pbe-internal-token',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(body, status = 200, origin = '', env = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...cors(origin, env),
    },
  });
}
