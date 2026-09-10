/* The picks engine's only view of "what is happening in the NFL right now".
 *
 * Every lane — issuance, market tape, closing, grading — reads game state from
 * nfl-current (/api/current-games), the authoritative current-season Worker.
 * There is deliberately no second copy of "what week is it" here, and no clock
 * arithmetic on a schedule file:
 *
 *   - nflverse `gametime` is Eastern time. Parsing it as UTC put every kickoff
 *     four hours early, which ended issuance and marked closing lines four
 *     hours before the real kickoff.
 *   - Joining the odds feed on the UTC date dropped every primetime game (an
 *     8:20 PM ET kickoff is the NEXT day in UTC), so NE @ SEA, SF @ LAR, SNF
 *     and MNF never had market tape and were never evaluated.
 *
 * Identity: decisions and tape are keyed by the nflverse game_id
 * (`2026_01_SF_LA`). That id is derived here from nfl-current's own season,
 * week and teams, so it needs no schedule lookup. ESPN ids are carried along
 * for box-score lookups; odds-provider ids are a third id space and are only
 * ever matched by team pair + kickoff.
 */

/* ESPN abbreviations that differ from nflverse codes. Everything else is equal. */
const ESPN_TO_NFLVERSE = Object.freeze({ LAR: 'LA', WSH: 'WAS' });

export function nflverseCode(abbr) {
  const code = String(abbr || '').trim().toUpperCase();
  if (!code) return null;
  return ESPN_TO_NFLVERSE[code] || code;
}

/* nflverse numbers postseason weeks after the 18-week regular season. */
export function nflverseGameId({ season, seasonType, week, away, home }) {
  const s = Number(season), w = Number(week);
  if (!Number.isInteger(s) || !Number.isInteger(w) || w < 1 || !away || !home) return null;
  const type = String(seasonType || '').toUpperCase();
  if (type !== 'REG' && type !== 'POST') return null; // preseason is never picked or graded
  const nflWeek = type === 'POST' ? w + 18 : w;
  return `${s}_${String(nflWeek).padStart(2, '0')}_${away}_${home}`;
}

const STATES = new Set(['SCHEDULE', 'LIVE', 'FINAL']);

export function normalizeCurrentGame(raw) {
  const season = numOrNull(raw?.season);
  const week = numOrNull(raw?.week);
  const seasonType = String(raw?.season_type || '').toUpperCase() || null;
  const away = nflverseCode(raw?.away?.abbreviation);
  const home = nflverseCode(raw?.home?.abbreviation);
  const kickoffMs = Date.parse(raw?.kickoff || '');
  const state = String(raw?.semantics || '').toUpperCase();
  return {
    game_id: nflverseGameId({ season, seasonType, week, away, home }),
    espn_id: raw?.id ? String(raw.id) : null,
    season, week, season_type: seasonType,
    away_team: away, home_team: home,
    kickoff_ts: Number.isFinite(kickoffMs) ? new Date(kickoffMs).toISOString() : null,
    kickoff_ms: Number.isFinite(kickoffMs) ? kickoffMs : null,
    state: STATES.has(state) ? state : (state || 'UNAVAILABLE'),
    detail: raw?.detail || null,
    away_score: numOrNull(raw?.away?.score),
    home_score: numOrNull(raw?.home?.score),
  };
}

/* Reads nfl-current through its service binding. Throws — never guesses — when
 * the authority cannot answer; the caller records that as a degraded run. */
export async function loadSlate(env) {
  if (!env?.NFL_CURRENT) throw new Error('current_binding_missing');
  const response = await env.NFL_CURRENT.fetch(
    new Request('https://nfl-current.internal/api/current-games', { headers: { accept: 'application/json' } }),
  );
  if (!response.ok) throw new Error(`current_state_${response.status}`);
  const body = await response.json();
  return parseSlate(body);
}

export function parseSlate(body) {
  if (!body || body.ok !== true || !Array.isArray(body.games)) throw new Error('current_state_unavailable');
  const season = numOrNull(body.season);
  if (!season) throw new Error('current_state_season_missing');
  const games = body.games.map(normalizeCurrentGame).filter(g => g.game_id && g.kickoff_ms !== null);
  return {
    season,
    season_type: String(body.season_type || '').toUpperCase() || null,
    week: numOrNull(body.current_week),
    games,
    freshness: body.freshness || null,
    last_updated: body.last_updated || null,
  };
}

/* A game may receive a pregame decision only while the provider still calls it
 * scheduled AND its real kickoff is in the future by a safety margin. Both are
 * required: a stale authority must not re-open a game that has kicked off, and
 * a clock must not issue on a game the provider already calls LIVE. */
export const ISSUANCE_CUTOFF_MS = 5 * 60 * 1000;

export function issuable(game, nowMs = Date.now(), horizonMs = 7 * 86400000) {
  return Boolean(game)
    && game.state === 'SCHEDULE'
    && Number.isFinite(game.kickoff_ms)
    && game.kickoff_ms - nowMs > ISSUANCE_CUTOFF_MS
    && game.kickoff_ms - nowMs <= horizonMs;
}

/* Grading eligibility: the provider says FINAL and both scores exist. */
export function gradable(game) {
  return Boolean(game) && game.state === 'FINAL'
    && Number.isFinite(game.home_score) && Number.isFinite(game.away_score);
}

/* Odds-provider events carry full team names in their own id space. Match on
 * the nflverse team pair and the nearest kickoff within a few hours — never on
 * a calendar date, which is where the UTC/ET split dropped primetime games. */
export function matchGameForEvent(games, { away, home, commenceMs }, toleranceMs = 6 * 3600000) {
  if (!away || !home || !Number.isFinite(commenceMs)) return null;
  let best = null, bestDiff = Infinity;
  for (const g of games || []) {
    if (g.away_team !== away || g.home_team !== home) continue;
    const diff = Math.abs(g.kickoff_ms - commenceMs);
    if (diff <= toleranceMs && diff < bestDiff) { best = g; bestDiff = diff; }
  }
  return best;
}

/* Game-state-aware cadence. The Workers cron fires every 15 minutes; this says
 * whether that tick should do the (cheap, persisted-tape-only) work.
 *
 *   near_kickoff  a scheduled game kicks off within 3h   → every 15 min
 *   game_day      a game kicks off within 24h, or is live → hourly
 *   off_hours     otherwise                              → every 6h
 *
 * A new market batch always triggers a run, whatever the tier. No provider is
 * contacted by any tier — they only decide how often we re-read our own tape. */
export const CADENCE = Object.freeze({
  near_kickoff: 15 * 60 * 1000,
  game_day: 60 * 60 * 1000,
  off_hours: 6 * 60 * 60 * 1000,
});

export function cadenceTier(games, nowMs = Date.now()) {
  let tier = 'off_hours';
  for (const g of games || []) {
    if (g.state === 'LIVE') { if (tier === 'off_hours') tier = 'game_day'; continue; }
    if (g.state !== 'SCHEDULE' || !Number.isFinite(g.kickoff_ms)) continue;
    const until = g.kickoff_ms - nowMs;
    if (until <= 0) continue;
    if (until <= 3 * 3600000) return 'near_kickoff';
    if (until <= 24 * 3600000) tier = 'game_day';
  }
  return tier;
}

/* Slack absorbs cron jitter so an hourly tier does not slip to every 75 min. */
export function cadenceDecision({ games, nowMs = Date.now(), lastWorkMs = null, newTape = false }) {
  const tier = cadenceTier(games, nowMs);
  const interval = CADENCE[tier];
  if (!Number.isFinite(lastWorkMs)) return { go: true, tier, interval_ms: interval, reason: 'first_run' };
  if (newTape) return { go: true, tier, interval_ms: interval, reason: 'new_market_batch' };
  const due = nowMs - lastWorkMs >= interval - 2 * 60 * 1000;
  return { go: due, tier, interval_ms: interval, reason: due ? `cadence_${tier}` : 'not_due' };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
