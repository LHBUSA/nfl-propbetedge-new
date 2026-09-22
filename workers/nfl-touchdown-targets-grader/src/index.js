/* nfl-touchdown-targets-grader — settles PBE Touchdown Targets from official
 * final box scores, and nothing else.
 *
 * FINAL MEANS FINAL. nfl-current is the authority on whether a game is over;
 * the ESPN id it carries is used only to fetch that one game's published box
 * score. A live score, a fourth-quarter drive or a clock never settles a
 * target, and the grader has no route that could be asked to.
 *
 * DETERMINISTIC AND IDEMPOTENT. The same box score always produces the same
 * grade object; the stored grade is compared field by field before anything is
 * written, so a re-run writes nothing and logs nothing. When an official stat
 * correction genuinely changes the result, the previous and corrected grades
 * are both written into an auditable regrade event before the row is updated.
 * History is never quietly rewritten.
 *
 * MARKET SCOPE. Every read is filtered to player_anytime_td. This lane cannot
 * touch a passing-yards pick, a game pick, or either of their records.
 *
 * Runs every 15 minutes. A tick with no target past kickoff costs one indexed
 * query.
 */
import { select, upsert, patch, insert } from '../../nfl-picks-engine-shared/supabase.mjs';
import { teamCodeFromName } from '../../nfl-picks-engine-shared/odds-normalize.mjs';
import { loadSlate, gradable, matchGameForEvent } from '../../nfl-picks-engine-shared/current-slate.mjs';
import { recordRun, readLane, laneHealth } from '../../nfl-picks-engine-shared/runs.mjs';
import { TD_MARKET } from '../../nfl-td-targets-shared/td-selector.mjs';
import {
  readPlayerScoring, gradeTarget, sameGrade, gradeSummary, learningObservation, RESULT_DEFINITION,
} from '../../nfl-td-targets-shared/td-grading.mjs';

const SERVICE = 'nfl-touchdown-targets-grader';
const VERSION = 'v1.0.0';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/health') return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
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
      market: TD_MARKET,
      result_definition: RESULT_DEFINITION,
      requirements: {
        SUPABASE_URL: Boolean(env.SUPABASE_URL),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        NFL_SITE_URL: Boolean(env.NFL_SITE_URL),
        NFL_CURRENT_BINDING: Boolean(env.NFL_CURRENT),
        PICKS_KV_BINDING: Boolean(env.PICKS_KV),
      },
    });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runGrading(env, event?.cron)); },
};

async function runGrading(env, cron) {
  const base = { version: VERSION, cron: cron || null, started_at: new Date().toISOString() };
  const counts = {
    past_kickoff: 0, graded: 0, corrected: 0, unchanged: 0, awaiting_final: 0,
    wins: 0, losses: 0, voids: 0, learning_rows: 0, learning_blocked: 0,
  };
  try {
    const before = encodeURIComponent(new Date().toISOString());
    const targets = await select(
      env, 'nfl_prop_picks',
      `market=eq.${TD_MARKET}&status=in.(open,killed)&kickoff_ts=lt.${before}`
        + '&select=*&order=kickoff_ts.asc&limit=1000',
    ) || [];
    counts.past_kickoff = targets.length;
    if (!targets.length) {
      await recordRun(env, SERVICE, { ...base, status: 'ok', reason: 'nothing_past_kickoff', counts });
      return;
    }

    const slate = await loadSlate(env);
    const boxCache = new Map();
    for (const target of targets) {
      const observation = await finalObservation(env, target, slate, boxCache);
      if (!observation) { counts.awaiting_final += 1; continue; }
      const outcome = await gradeOne(env, target, observation, counts);
      if (outcome === 'graded') counts.graded += 1;
      else if (outcome === 'corrected') counts.corrected += 1;
      else counts.unchanged += 1;
    }

    await recordRun(env, SERVICE, {
      ...base,
      status: 'ok',
      reason: counts.graded || counts.corrected ? 'graded' : 'awaiting_final',
      counts,
      source_freshness: { current_state_updated: slate.last_updated },
      detail: { public: { market: TD_MARKET, result_definition: RESULT_DEFINITION } },
    });
  } catch (error) {
    console.error(`[${SERVICE}] grading failed class=${errorClass(error)}`);
    await recordRun(env, SERVICE, { ...base, status: 'failed', error_class: errorClass(error), counts });
  }
}

async function gradeOne(env, target, observation, counts) {
  const closing = await closingFor(env, target);
  const grade = gradeTarget({ target, seen: observation.seen, closing });

  const existingRows = await select(env, 'nfl_prop_pick_grades', `pick_id=eq.${target.id}&select=*&limit=1`) || [];
  const existing = existingRows[0] || null;

  if (existing && sameGrade(existing, grade)) return 'skipped';

  /* A changed grade is a correction, and a correction is an event before it is
   * an update. Both states are written to the audit ledger first. */
  if (existing) {
    await audit(env, target, 'td_target_correction_regrade', {
      previous: gradeSummary(existing),
      corrected: gradeSummary(grade),
      source: grade.source,
    });
  }

  await upsert(env, 'nfl_prop_pick_grades', grade, 'pick_id', { returning: 'minimal' });

  if (!existing) {
    await audit(env, target, target.publication_scope === 'official' ? 'td_official_final_result' : 'td_tracking_final_result', {
      publication_scope: target.publication_scope || 'tracking',
      result: grade.result,
      offensive_td: grade.final_value,
      non_offensive_td: grade.non_offensive_td,
      result_definition: grade.result_definition,
      box_score_source: observation.source,
    });
    await audit(env, target, 'td_target_first_grade', {
      target_rank: target.target_rank,
      player_name: target.player_name,
      result: grade.result,
      units_delta: grade.units_delta,
      model_prob: target.model_prob,
      brier: grade.brier,
      settlement_note: grade.settlement_note,
    });
  }

  if (grade.result === 'win') counts.wins += 1;
  else if (grade.result === 'loss') counts.losses += 1;
  else counts.voids += 1;

  if (target.status !== 'graded') {
    await patch(env, 'nfl_prop_picks', `id=eq.${target.id}`, { status: 'graded', closed_at: new Date().toISOString() });
  }

  /* Only a finalized target becomes a learning observation, and only with the
   * feature vector frozen at issuance. A target whose snapshot is missing its
   * features is NOT quietly trained on: the failure is recorded and the row is
   * left out of the learning set. */
  try {
    await upsert(env, 'nfl_prop_learning_observations', learningObservation({ target, grade }), 'pick_id', { returning: 'minimal' });
    counts.learning_rows += 1;
  } catch (error) {
    counts.learning_blocked += 1;
    await audit(env, target, 'td_learning_observation_blocked', { error_class: errorClass(error) });
  }

  return existing ? 'corrected' : 'graded';
}

/* The last price observed strictly before kickoff. A post-kick price is never
 * a closing price, which is why the query bounds on kickoff_ts. */
async function closingFor(env, target) {
  const before = encodeURIComponent(target.kickoff_ts);
  const rows = await select(
    env, 'nfl_prop_closing_snapshots',
    `pick_id=eq.${target.id}&observed_at=lt.${before}`
      + '&select=price,opposite_price,observed_at&order=observed_at.desc&limit=1',
  ) || [];
  const row = rows[0];
  if (!row) return null;
  return { price: numOrNull(row.price), opposite_price: numOrNull(row.opposite_price) };
}

/* nfl-current says whether the game is over. Only then is that one game's
 * published box score read. */
async function finalObservation(env, target, slate, cache) {
  const snapshot = target.model_snapshot || {};
  const event = snapshot.event || {};
  const away = teamCodeFromName(event.away_team) || String(event.away_team || '').toUpperCase();
  const home = teamCodeFromName(event.home_team) || String(event.home_team || '').toUpperCase();
  if (!away || !home) return null;

  const game = matchGameForEvent(slate.games, { away, home, commenceMs: Date.parse(target.kickoff_ts) });
  if (!gradable(game) || !/^\d+$/.test(String(game.espn_id || ''))) return null;

  const key = String(game.espn_id);
  let detail = cache.get(key);
  if (detail === undefined) {
    detail = await getJson(`${siteBase(env)}/api/nfl-live?event=${encodeURIComponent(key)}`).catch(() => null);
    if (!detail || String(detail?.game?.status?.semantics || '').toUpperCase() !== 'FINAL') detail = null;
    cache.set(key, detail);
  }
  if (!detail) return null;

  return {
    seen: readPlayerScoring(detail.player_stats, target.player_key || target.player_name),
    source: detail?.source?.provider || 'espn_cdn_gamepackage',
    espn_id: key,
  };
}

async function audit(env, target, eventType, detail) {
  try {
    await insert(env, 'nfl_prop_pick_audit_events', {
      pick_id: target?.id || null,
      event_type: eventType,
      selector_version: target?.selector_version ?? null,
      detail: detail || {},
    }, { returning: 'minimal' });
  } catch (error) {
    console.error('[td-grade-audit] failed', errorClass(error));
  }
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function siteBase(env) { return String(env.NFL_SITE_URL || 'https://nfl.propbetedge.ai').replace(/\/$/, ''); }
async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}
function errorClass(error) { return String(error?.message || 'unknown').split(':')[0].slice(0, 80); }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
