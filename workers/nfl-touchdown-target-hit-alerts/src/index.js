/* nfl-touchdown-target-hit-alerts — the ONE detector and publisher of live
 * PBE Touchdown Target hits.
 *
 * THE BROWSER NEVER DETECTS A HIT. This Worker is the only thing that decides
 * a locked target has scored, and the database is the only thing that decides
 * it has not already been announced: the insert is ON CONFLICT (pick_id) DO
 * NOTHING against a UNIQUE constraint, so two overlapping ticks, two isolates
 * or a retried cron can never publish a second event for the same pick.
 *
 * WHAT IT DOES, EVERY MINUTE
 *   1. reads open player_anytime_td targets whose kickoff is inside the game
 *      window (bounded, indexed, never the full history)
 *   2. groups them by ESPN game id and reads each game's live package ONCE
 *      from the existing /api/nfl-live contract, however many targets it holds
 *   3. judges each target with td-live-hit.mjs, whose touchdown test IS the
 *      final grader's readPlayerScoring() — one football definition
 *   4. announces a hit only when the scoring play is fresh (<= 5 minutes), so
 *      a touchdown scored before this Worker was watching is never replayed;
 *      that older touchdown is still PERSISTED (detection live_stale) so the
 *      PBEcast target card shows its permanent HIT with the real play
 *   5. writes an auditable run record to the durable ledger
 *
 * Targets are read while OPEN or already GRADED inside the game window: if the
 * grader settles a game before this Worker saw the touchdown, the hit row is
 * still recorded (live_stale) from the same package, never announced.
 *
 * WHAT IT NEVER DOES
 * Issue, replace, grade, close or supersede a target; write a grade, receipt,
 * audit event or learning observation; post to Slack or Discord. Its only
 * write is one table, nfl_td_target_hit_events. Settlement remains the final
 * grader's, from the FINAL box score.
 */
import { select, supabaseAdminHeaders } from '../../nfl-picks-engine-shared/supabase.mjs';
import { recordRun, readLane, laneHealth } from '../../nfl-picks-engine-shared/runs.mjs';
import { RESULT_DEFINITION } from '../../nfl-td-targets-shared/td-grading.mjs';
import { evaluateTarget, DETECTOR, FRESHNESS_MS } from '../../nfl-td-targets-shared/td-live-hit.mjs';

export const SERVICE = 'nfl-touchdown-target-hit-alerts';
export const VERSION = 'v1.1.0';
export const TD_MARKET = 'player_anytime_td';
export const HITS_TABLE = 'nfl_td_target_hit_events';
/* Kickoff inside the last six hours: every regulation and overtime game. */
export const GAME_WINDOW_MS = 6 * 3600 * 1000;
const TARGET_FIELDS = [
  'id', 'event_id', 'season', 'week', 'kickoff_ts', 'player_name', 'player_key', 'market',
  'model_prob', 'market_price', 'confidence_bucket', 'target_rank', 'publication_scope',
  'status', 'model_snapshot',
].join(',');

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
      counts: lane.last_work?.counts || null,
      market: TD_MARKET,
      detector: DETECTOR,
      result_definition: RESULT_DEFINITION,
      freshness_limit_s: FRESHNESS_MS / 1000,
      writes: [HITS_TABLE],
      requirements: {
        SUPABASE_URL: Boolean(env.SUPABASE_URL),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        NFL_SITE_URL: Boolean(env.NFL_SITE_URL),
        PICKS_KV_BINDING: Boolean(env.PICKS_KV),
      },
    });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runDetection(env, { cron: event?.cron })); },
};

export function emptyCounts() {
  return {
    targets_checked: 0,
    games_checked: 0,
    live_games: 0,
    hits_detected: 0,
    duplicate_hits: 0,
    already_published: 0,
    stale_existing_hits: 0,
    stale_recorded: 0,
    no_td_yet: 0,
    play_unmatched: 0,
    freshness_unproven: 0,
    source_unavailable: 0,
    identity_missing: 0,
    identity_mismatch: 0,
    not_live: 0,
  };
}

export async function runDetection(env, { cron = null, nowMs = Date.now() } = {}) {
  const base = { version: VERSION, cron, started_at: new Date(nowMs).toISOString() };
  const counts = emptyCounts();
  const published = [];
  try {
    const upper = encodeURIComponent(new Date(nowMs).toISOString());
    const lower = encodeURIComponent(new Date(nowMs - GAME_WINDOW_MS).toISOString());
    const targets = await select(
      env, 'nfl_prop_picks',
      `market=eq.${TD_MARKET}&status=in.(open,graded)&kickoff_ts=lt.${upper}&kickoff_ts=gt.${lower}`
        + `&select=${TARGET_FIELDS}&order=kickoff_ts.asc&limit=200`,
    ) || [];
    if (!targets.length) {
      await recordRun(env, SERVICE, { ...base, status: 'skipped', reason: 'no_active_targets', counts });
      return { counts, published };
    }

    /* Already announced: counted, never re-judged, never re-inserted. */
    const ids = targets.map(target => target.id).filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
    const existing = ids.length ? await select(
      env, HITS_TABLE, `pick_id=in.(${ids.join(',')})&select=pick_id`,
    ) || [] : [];
    const announced = new Set(existing.map(row => row.pick_id));

    const games = new Map();
    for (const target of targets) {
      counts.targets_checked += 1;
      if (announced.has(target.id)) { counts.already_published += 1; continue; }
      const espn = String(target.model_snapshot?.event?.espn_id || '').trim();
      if (!/^\d{6,12}$/.test(espn)) { counts.identity_missing += 1; continue; }
      if (!games.has(espn)) games.set(espn, []);
      games.get(espn).push(target);
    }

    for (const [espn, gameTargets] of games) {
      counts.games_checked += 1;
      let detail = null;
      try {
        detail = await getJson(`${siteBase(env)}/api/nfl-live?event=${encodeURIComponent(espn)}`);
      } catch (_) { detail = null; }
      if (!detail || String(detail?.game?.id || '') !== espn) {
        counts.source_unavailable += gameTargets.length;
        continue;
      }
      const semantics = String(detail?.game?.status?.semantics || '').toUpperCase();
      if (semantics === 'LIVE') counts.live_games += 1;
      /* A final whistle inside the freshness window still counts: a walk-off
       * touchdown is the most important one. Anything not yet started is not. */
      if (semantics !== 'LIVE' && semantics !== 'FINAL') { counts.not_live += gameTargets.length; continue; }
      if (!Array.isArray(detail.scoring_plays)) { counts.source_unavailable += gameTargets.length; continue; }

      for (const target of gameTargets) {
        const verdict = evaluateTarget({ target, detail, nowMs, statuses: ['open', 'graded'] });
        if (verdict.outcome === 'hit') {
          const claimed = await claim(env, verdict.row);
          if (claimed) {
            counts.hits_detected += 1;
            published.push({ pick_id: target.id, target_rank: target.target_rank, play_id: verdict.row.play_id, espn_id: espn });
          } else counts.duplicate_hits += 1;
        } else if (verdict.outcome === 'stale_existing_hit') {
          counts.stale_existing_hits += 1;
          /* Persisted for the permanent PBEcast HIT, never announced. */
          if (verdict.row && await claim(env, verdict.row)) counts.stale_recorded += 1;
        }
        else if (verdict.outcome === 'no_td') counts.no_td_yet += 1;
        else if (verdict.outcome === 'play_unmatched') counts.play_unmatched += 1;
        else if (verdict.outcome === 'freshness_unproven') counts.freshness_unproven += 1;
        else if (verdict.outcome === 'identity_missing') counts.identity_missing += 1;
        else if (verdict.outcome === 'identity_mismatch') counts.identity_mismatch += 1;
      }
    }

    const degraded = counts.source_unavailable > 0;
    await recordRun(env, SERVICE, {
      ...base,
      status: degraded ? 'degraded' : 'ok',
      reason: counts.hits_detected ? 'hit_published' : degraded ? 'source_unavailable' : 'watching',
      error_class: degraded ? 'live_source_unavailable' : null,
      counts,
      detail: { public: { market: TD_MARKET, detector: DETECTOR, published } },
    });
    return { counts, published };
  } catch (error) {
    console.error(`[${SERVICE}] detection failed class=${errorClass(error)}`);
    await recordRun(env, SERVICE, { ...base, status: 'failed', error_class: errorClass(error), counts });
    return { counts, published, error: errorClass(error) };
  }
}

/* The atomic claim. The UNIQUE (pick_id) constraint decides; a conflict
 * returns no row, which is how a duplicate is recognised. A second target
 * credited on the SAME scoring play hits the (espn_id, play_id) unique index
 * instead, which PostgREST reports as 409: also a duplicate, never a failure
 * that would stop the rest of the tick. */
export async function claim(env, row) {
  const url = `${String(env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/${HITS_TABLE}?on_conflict=pick_id`;
  const response = await fetch(url, {
    method: 'POST',
    headers: supabaseAdminHeaders(String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(), {
      'content-type': 'application/json',
      prefer: 'resolution=ignore-duplicates,return=representation',
    }),
    body: JSON.stringify([row]),
    cache: 'no-store',
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error(`supabase_${response.status}:${HITS_TABLE}`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
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
