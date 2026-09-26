/* Runtime evidence for the PBE Picks read contracts.
 *
 * Publication state (GATED / ALLOWED) comes from the champion row. Runtime
 * health comes from somewhere else entirely: the durable run ledger each engine
 * lane writes to KV, served public-safe by the game orchestrator at
 * /v1/engine/runs. The two are never conflated — an engine can be GATED and
 * perfectly healthy, or trained and dead — and an unreachable ledger is
 * reported as UNKNOWN, never as healthy.
 *
 * Season, week and the next game come from nfl-current (/api/season via the
 * gateway), the same authority the engine itself uses.
 */

const DEFAULT_ENGINE_URL = 'https://nfl-game-picks-orchestrator.sales-fd3.workers.dev';
const DEFAULT_NFL_GATEWAY = 'https://nfl-api.propbetedge.ai';

/* process.env exists on Vercel; a Cloudflare Worker passes its own bindings in
 * `opts` instead (a Worker cannot fetch another Worker's workers.dev URL in the
 * same account — error 1042 — so it supplies a service-binding fetch). Callers
 * that pass nothing behave exactly as before. */
const processEnv = () => (typeof process !== 'undefined' && process && process.env) || {};

async function fetchJson(url, timeoutMs = 4000, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function currentSeason(opts = {}) {
  const base = String(opts.gatewayUrl || processEnv().NFL_GATEWAY || DEFAULT_NFL_GATEWAY).replace(/\/$/, '');
  const body = await fetchJson(`${base}/api/season`, 4000, opts.fetchImpl || fetch);
  const season = Number(body?.season);
  const week = Number(body?.current_week);
  if (!Number.isFinite(season) || season < 2000) throw new Error('current_season_unavailable');
  const next = body?.next_game || null;
  return {
    season,
    week: Number.isFinite(week) ? week : null,
    season_type: body?.season_type || null,
    freshness: body?.freshness?.state || null,
    latest_final: body?.latest_final
      ? { name: body.latest_final.name, kickoff: body.latest_final.kickoff, away: body.latest_final.away?.abbreviation, home: body.latest_final.home?.abbreviation, away_score: body.latest_final.away?.score, home_score: body.latest_final.home?.score }
      : null,
    next_game: next ? { name: next.name, kickoff: next.kickoff, state: next.semantics } : null,
  };
}

/* nflverse ids encode the matchup: 2026_01_SF_LA -> SF @ LA. */
export function matchupFromGameId(gameId) {
  const m = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(gameId || ''));
  return m ? { game_id: gameId, season: Number(m[1]), week: Number(m[2]), away_team: m[3], home_team: m[4] } : null;
}

function laneSummary(lane) {
  if (!lane) return null;
  const work = lane.last_work || null;
  return {
    lane: lane.lane,
    label: lane.label,
    critical: lane.critical === true,
    state: lane.state,
    reason: lane.reason,
    last_tick_at: lane.last_tick?.finished_at || null,
    last_work_at: work?.finished_at || null,
    last_work_status: work?.status || null,
    last_ok_at: lane.last_ok_at || null,
    last_error: lane.last_error || null,
    counts: work?.counts || null,
    detail: work?.detail || null,
    source_freshness: work?.source_freshness || null,
  };
}

/* lanesWanted: which engine lanes this contract reports on. An entry may be a
 * lane name, or `{ lane, critical }` when the contract knows a lane's weight
 * before the ledger does — which is the case for a lane that has not been
 * deployed yet.
 *
 * A LANE THIS CONTRACT ASKED FOR AND COULD NOT FIND IS NOT HEALTH. The filter
 * used to drop an absent lane silently, so a contract whose own engine had
 * never run once reported HEALTHY on the strength of the lanes it shares with
 * another product. A missing lane is now reported as UNKNOWN, with the reason,
 * and counts against the verdict exactly as a stale one would. */
export async function engineRuntime(lanesWanted, opts = {}) {
  const wanted = (Array.isArray(lanesWanted) ? lanesWanted : []).map(entry => (
    typeof entry === 'string' ? { lane: entry, critical: true } : { lane: entry.lane, critical: entry.critical !== false }
  ));
  const url = `${String(opts.engineUrl || processEnv().PICKS_ENGINE_URL || DEFAULT_ENGINE_URL).replace(/\/$/, '')}/v1/engine/runs`;
  try {
    const body = await fetchJson(url, 4000, opts.fetchImpl || fetch);
    const reported = new Map((Array.isArray(body?.lanes) ? body.lanes : []).map(l => [l.lane, l]));
    const lanes = wanted.map(entry => reported.get(entry.lane) || {
      lane: entry.lane,
      label: entry.lane,
      critical: entry.critical,
      state: 'UNKNOWN',
      reason: 'lane_not_in_run_ledger',
      last_tick: null,
      last_work: null,
      last_ok_at: null,
      last_error: null,
    });
    const critical = lanes.filter(l => l.critical);
    let health = 'HEALTHY';
    if (!critical.length) health = 'UNKNOWN';
    else if (critical.some(l => l.state === 'STALE' || l.state === 'UNKNOWN')) health = 'STALE';
    else if (critical.some(l => l.state === 'DEGRADED')) health = 'DEGRADED';
    return {
      health,
      checked_at: body?.generated_at || new Date().toISOString(),
      source: 'durable_run_ledger',
      lanes: Object.fromEntries(lanes.map(l => [l.lane, laneSummary(l)])),
    };
  } catch (error) {
    return {
      health: 'UNKNOWN',
      checked_at: new Date().toISOString(),
      source: 'durable_run_ledger',
      unavailable_reason: `run_ledger_unreachable:${String(error?.message || error).slice(0, 60)}`,
      lanes: {},
    };
  }
}

/* The customer-facing engine state. Health dominates publication: a dead or
 * stale engine is DEGRADED even when publication is also gated, because
 * "validation in progress" would be a false claim about an engine that is not
 * running. */
export function composeEngineState({ health, trained, hasPicks, gatedState }) {
  if (health !== 'HEALTHY') return 'ENGINE DEGRADED — source unavailable';
  if (!trained) return gatedState;
  return hasPicks ? 'ENGINE LIVE — PICKS AVAILABLE' : 'ENGINE LIVE — NO QUALIFIED PBE PICKS';
}
