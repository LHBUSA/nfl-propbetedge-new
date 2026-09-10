/* nfl-prop-picks-grader — settles Algorithm #2 from authoritative FINAL box scores.
 *
 * v1 supports player_pass_yds only. Odds-provider event IDs are NEVER treated
 * as ESPN game IDs: the grader matches the frozen away/home matchup and kickoff
 * against nfl-current, requires nfl-current's FINAL, then reads the labeled
 * Passing/YDS box-score field for that ESPN game.
 *
 * Runs every 15 minutes. A tick with no decision past kickoff costs one
 * indexed query.
 */
import { select, upsert, patch, insert } from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  unitsDelta, brierScore, devigTwoWay, clvProb, clvBeat, outcomeBit,
} from '../../nfl-picks-engine-shared/pick-math.mjs';
import { playerKey, PROP_MARKET } from '../../nfl-prop-picks-shared/prop-math.mjs';
import { teamCodeFromName } from '../../nfl-picks-engine-shared/odds-normalize.mjs';
import { loadSlate, gradable, matchGameForEvent } from '../../nfl-picks-engine-shared/current-slate.mjs';
import { recordRun, readLane, laneHealth } from '../../nfl-picks-engine-shared/runs.mjs';

const SERVICE = 'nfl-prop-picks-grader';
const VERSION = 'v1.1.0';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/health') return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
    const lane = laneHealth(SERVICE, await readLane(env, SERVICE));
    return json({
      service: SERVICE, version: VERSION,
      health: lane.state,
      health_reason: lane.reason,
      last_tick: lane.last_tick,
      last_work: lane.last_work,
      last_ok_at: lane.last_ok_at,
      last_error: lane.last_error,
      market: PROP_MARKET,
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
  const counts = { past_kickoff: 0, graded: 0, corrected: 0, unchanged: 0, awaiting_final: 0 };
  try {
    const before = encodeURIComponent(new Date().toISOString());
    const picks = await select(
      env, 'nfl_prop_picks',
      `market=eq.${PROP_MARKET}&status=in.(open,killed)&kickoff_ts=lt.${before}&select=*&order=kickoff_ts.asc&limit=1000`,
    ) || [];
    counts.past_kickoff = picks.length;
    if (!picks.length) {
      await recordRun(env, SERVICE, { ...base, status: 'ok', reason: 'nothing_past_kickoff', counts });
      return;
    }

    const slate = await loadSlate(env);
    const finalCache = new Map();
    for (const pick of picks) {
      const final = await finalPlayerResult(env, pick, slate, finalCache);
      if (!final) { counts.awaiting_final += 1; continue; }
      const outcome = await gradeOne(env, pick, final);
      if (outcome === 'graded') counts.graded += 1;
      else if (outcome === 'corrected') counts.corrected += 1;
      else counts.unchanged += 1;
    }

    await recordRun(env, SERVICE, {
      ...base, status: 'ok', reason: counts.graded || counts.corrected ? 'graded' : 'awaiting_final', counts,
      source_freshness: { current_state_updated: slate.last_updated },
    });
  } catch (error) {
    console.error(`[${SERVICE}] grading failed class=${errorClass(error)}`);
    await recordRun(env, SERVICE, { ...base, status: 'failed', error_class: errorClass(error), counts });
  }
}

export function computePropGrade(pick, final, closing) {
  let result;
  if (pick.status === 'killed' || final.void === true) result = 'void';
  else {
    const side = String(pick.side || '').toUpperCase();
    const actual = Number(final.final_value), line = Number(pick.market_line);
    if (!Number.isFinite(actual) || !Number.isFinite(line)) throw new Error('grade_value_unavailable');
    if (actual === line) result = 'push';
    else if (side === 'OVER') result = actual > line ? 'win' : 'loss';
    else if (side === 'UNDER') result = actual < line ? 'win' : 'loss';
    else throw new Error('unsupported_prop_side');
  }

  const killedOrVoid = result === 'void';
  const units = killedOrVoid ? 0 : unitsDelta(pick.stake_units, pick.market_price, result);
  const brier = killedOrVoid ? null : brierScore(pick.model_prob, result);
  const closingProb = closing?.price != null && closing?.opposite_price != null
    ? devigTwoWay(closing.price, closing.opposite_price)
    : null;
  const probabilityClv = clvProb({ closingProb, pickMarketProb: pick.market_prob });
  const pointsClv = closing?.line == null ? null : propClvPoints(pick.side, pick.market_line, closing.line);

  return {
    pick_id: pick.id,
    final_value: final.final_value ?? null,
    result,
    units_delta: units,
    closing_line: closing?.line ?? null,
    closing_price: closing?.price ?? null,
    closing_opposite_price: closing?.opposite_price ?? null,
    closing_market_prob: closingProb,
    clv_points: pointsClv,
    clv_prob: probabilityClv,
    clv_beat: clvBeat(probabilityClv),
    brier,
    source: final.source || 'espn_cdn_gamepackage',
  };
}

export function propClvPoints(side, pickLine, closeLine) {
  const pick = finiteOrNull(pickLine), close = finiteOrNull(closeLine);
  if (pick === null || close === null) return null;
  const s = String(side || '').toUpperCase();
  if (s === 'OVER') return Number((close - pick).toFixed(4));
  if (s === 'UNDER') return Number((pick - close).toFixed(4));
  return null;
}

async function gradeOne(env, pick, final) {
  const closing = await closingFor(env, pick);
  const grade = computePropGrade(pick, final, closing);
  const existingRows = await select(env, 'nfl_prop_pick_grades', `pick_id=eq.${pick.id}&select=*&limit=1`) || [];
  const existing = existingRows[0] || null;

  if (existing && sameGrade(existing, grade)) return 'skipped';

  if (existing) {
    await auditProp(env, pick, 'prop_correction_regrade', {
      previous: gradeSummary(existing), corrected: gradeSummary(grade),
    });
  }

  await upsert(env, 'nfl_prop_pick_grades', grade, 'pick_id', { returning: 'minimal' });

  if (!existing) {
    await auditProp(env, pick,
      pick.publication_scope === 'official' ? 'prop_official_final_result' : 'prop_tracking_final_result',
      { publication_scope: pick.publication_scope || 'tracking', final_value: final.final_value, result: grade.result });
    await auditProp(env, pick, 'prop_first_grade', {
      result: grade.result, units_delta: grade.units_delta, clv_beat: grade.clv_beat,
    });
  }

  if (pick.status !== 'graded') {
    await patch(env, 'nfl_prop_picks', `id=eq.${pick.id}`, { status: 'graded', closed_at: new Date().toISOString() });
  }

  await upsert(env, 'nfl_prop_learning_observations', {
    pick_id: pick.id,
    season: pick.season,
    week: pick.week,
    market: pick.market,
    phase: pick.phase,
    publication_scope: pick.publication_scope || 'tracking',
    features: pick.model_snapshot?.selector_features || {},
    model_prob: pick.model_prob,
    market_prob: pick.market_prob,
    edge_pct: pick.edge_pct,
    ev_pct: pick.ev_pct,
    confidence_bucket: pick.confidence_bucket,
    outcome: outcomeBit(grade.result),
    clv_beat: grade.clv_beat,
    units_delta: grade.units_delta,
    brier: grade.brier,
    finalized_at: new Date().toISOString(),
    is_final: true,
  }, 'pick_id', { returning: 'minimal' });

  return existing ? 'corrected' : 'graded';
}

async function closingFor(env, pick) {
  const before = encodeURIComponent(pick.kickoff_ts);
  const rows = await select(
    env, 'nfl_prop_closing_snapshots',
    `pick_id=eq.${pick.id}&observed_at=lt.${before}`
      + '&select=point,price,opposite_price,observed_at&order=observed_at.desc&limit=1',
  ) || [];
  const row = rows[0];
  if (!row) return null;
  return { line: finiteOrNull(row.point), price: finiteOrNull(row.price), opposite_price: finiteOrNull(row.opposite_price) };
}

async function finalPlayerResult(env, pick, slate, cache) {
  const snapshot = pick.model_snapshot || {};
  const event = snapshot.event || {};
  const away = teamCodeFromName(event.away_team), home = teamCodeFromName(event.home_team);
  if (!away || !home) return null;
  /* nfl-current is the FINAL authority. The ESPN id it carries is used only to
   * fetch that one game's published box score. */
  const game = matchGameForEvent(slate.games, { away, home, commenceMs: Date.parse(pick.kickoff_ts) });
  if (!gradable(game) || !/^\d+$/.test(String(game.espn_id || ''))) return null;
  const cacheKey = game.espn_id;

  let detail = cache.get(cacheKey);
  if (detail === undefined) {
    detail = await getJson(`${siteBase(env)}/api/nfl-live?event=${encodeURIComponent(game.espn_id)}`).catch(() => null);
    if (!detail || String(detail?.game?.status?.semantics || '').toUpperCase() !== 'FINAL') detail = null;
    cache.set(cacheKey, detail);
  }
  if (!detail) return null;

  const found = passingYards(detail.player_stats, pick.player_key);
  if (!found) return null;
  return {
    final_value: found.did_not_play ? null : found.yards,
    void: found.did_not_play === true,
    source: detail?.source?.provider || 'espn_cdn_gamepackage',
  };
}

export function passingYards(playerStats, targetPlayerKey) {
  const target = playerKey(targetPlayerKey);
  for (const team of Array.isArray(playerStats) ? playerStats : []) {
    for (const group of Array.isArray(team?.groups) ? team.groups : []) {
      const groupName = String(group?.name || group?.display_name || '').toLowerCase();
      if (!groupName.includes('pass')) continue;
      const labels = (Array.isArray(group?.labels) ? group.labels : []).map(label => String(label).toUpperCase());
      const ydsIndex = labels.findIndex(label => label === 'YDS' || label.includes('YDS'));
      if (ydsIndex < 0) continue;
      for (const row of Array.isArray(group?.athletes) ? group.athletes : []) {
        const name = row?.athlete?.name || row?.athlete?.display_name || '';
        if (playerKey(name) !== target) continue;
        if (row?.did_not_play === true) return { did_not_play: true, yards: null };
        const raw = Array.isArray(row?.stats) ? row.stats[ydsIndex] : null;
        const yards = statNumber(raw);
        return yards === null ? null : { did_not_play: false, yards };
      }
    }
  }
  return null;
}

async function auditProp(env, pick, eventType, detail) {
  try {
    await insert(env, 'nfl_prop_pick_audit_events', {
      pick_id: pick?.id || null,
      event_type: eventType,
      selector_version: pick?.selector_version ?? null,
      detail: detail || {},
    }, { returning: 'minimal' });
  } catch (error) {
    console.error('[prop-grade-audit] failed', errorClass(error));
  }
}

function sameGrade(a, b) {
  const fields = ['final_value','result','units_delta','closing_line','closing_price','closing_opposite_price','closing_market_prob','clv_points','clv_prob','clv_beat','brier'];
  return fields.every(field => equalValue(a?.[field], b?.[field]));
}
function equalValue(a, b) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return Number(a) === Number(b) || String(a) === String(b);
}
function gradeSummary(row) {
  return { result: row?.result ?? null, final_value: row?.final_value ?? null, units_delta: row?.units_delta ?? null, clv_points: row?.clv_points ?? null, clv_prob: row?.clv_prob ?? null, brier: row?.brier ?? null };
}
function statNumber(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function siteBase(env) { return String(env.NFL_SITE_URL || 'https://nfl.propbetedge.ai').replace(/\/$/, ''); }
async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}
function errorClass(error) { return String(error?.message || 'unknown').split(':')[0].slice(0, 80); }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
