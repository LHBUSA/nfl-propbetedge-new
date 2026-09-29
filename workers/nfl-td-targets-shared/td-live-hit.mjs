/* PropBetEdge NFL — PBE Touchdown Target LIVE HIT detection, as pure functions.
 *
 * ONE DEFINITION OF A TOUCHDOWN
 * Whether the target has scored is decided by readPlayerScoring() from
 * td-grading.mjs — the exact function the final grader settles with — run on
 * the live box score. A rushing or receiving touchdown credited to the player
 * counts; a passing touchdown thrown by a quarterback, a return touchdown and a
 * defensive touchdown do not. Nothing in this file re-decides that.
 *
 * WHAT THIS FILE ADDS
 *   identity   every box-score row the grader's name match reads must carry the
 *              ESPN athlete id frozen on the target at issuance. A same-name
 *              player with a different id is not the target.
 *   the play   the scoring play that put the touchdown on the board. ESPN's
 *              scoring summary names the SCORER first, in full ("Kenneth
 *              Walker III 10 Yd Rush", "Ja'Marr Chase 3 Yd pass from Joe
 *              Burrow"), so an exact normalised match against the verified
 *              box-score name identifies it. The passer only ever appears after
 *              "pass from" and is never read as the scorer. No surname or fuzzy
 *              matching anywhere.
 *   freshness  the play's wallclock, joined from the play log by play id. The
 *              celebration marks the moment the target CONNECTED — his first
 *              touchdown — and only when that play is at most five minutes old.
 *              A touchdown scored before this detector was watching is
 *              stale_existing_hit: it is PERSISTED (detection live_stale) so
 *              PBEcast can show the permanent HIT, and never announced.
 *   detection  live_fresh (announced) | live_stale | final_backfill. Only
 *              live_fresh ever reaches view=hits or a celebration.
 *
 * Deterministic: the same payload, target and clock always give the same
 * verdict. No I/O.
 */

import { readPlayerScoring, RESULT_DEFINITION } from './td-grading.mjs';
import { normalizePlayerName } from './td-kernel.mjs';

export const DETECTOR = 'nfl-touchdown-target-hit-alerts/v1';
export const FRESHNESS_MS = 5 * 60 * 1000;
/* A wallclock this far in the future is a clock problem, not a fresh play. */
export const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
/* ESPN play type ids for the two offensive touchdown plays. */
export const DETECTIONS = Object.freeze(['live_fresh', 'live_stale', 'final_backfill']);
export const OFFENSIVE_TD_TYPES = Object.freeze({ '67': 'Passing Touchdown', '68': 'Rushing Touchdown' });

const arr = value => (Array.isArray(value) ? value : []);
const str = value => (value === null || value === undefined ? '' : String(value));
const groupName = group => str(group?.name || group?.display_name).toLowerCase().replace(/[^a-z]/g, '');
function statNumber(value) {
  const match = str(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}
const toInt = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/* Every box-score row the grader's name match would read for this player. */
function namedRows(playerStats, playerKey) {
  const target = normalizePlayerName(playerKey);
  const rows = [];
  for (const teamBlock of arr(playerStats)) {
    for (const group of arr(teamBlock?.groups)) {
      for (const row of arr(group?.athletes)) {
        const athlete = row?.athlete || {};
        const name = athlete.name || athlete.display_name || athlete.short_name || '';
        if (normalizePlayerName(name) === target) rows.push({ group: groupName(group), labels: arr(group?.labels), row, athlete, team: teamBlock?.team || {} });
      }
    }
  }
  return rows;
}

/* The box score's rows for this player, proven to be THIS player by ESPN id. */
export function boxIdentity(playerStats, playerKey, espnPlayerId) {
  const rows = namedRows(playerStats, playerKey);
  const wanted = str(espnPlayerId).trim();
  if (!/^\d+$/.test(wanted)) return { status: 'identity_missing', rows };
  if (!rows.length) return { status: 'absent', rows };
  if (rows.some(entry => str(entry.athlete.id).trim() !== wanted)) return { status: 'identity_mismatch', rows };
  const first = rows[0];
  return {
    status: 'ok',
    rows,
    name: first.athlete.name || first.athlete.display_name || null,
    team: first.athlete.team || first.team.abbreviation || null,
    headshot: rows.map(entry => entry.athlete.headshot).find(url => typeof url === 'string' && /^https:\/\//.test(url)) || null,
  };
}

/* The player's current line, from labelled columns only. A column the feed
 * does not label is absent from the result, never inferred. */
const STAT_COLUMNS = {
  rushing: { CAR: 'carries', YDS: 'rush_yards', TD: 'rushing_td' },
  receiving: { TGTS: 'targets', REC: 'receptions', YDS: 'receiving_yards', TD: 'receiving_td' },
};
export function liveStatLine(rows) {
  const out = {};
  for (const entry of arr(rows)) {
    const columns = STAT_COLUMNS[entry.group];
    if (!columns || entry.row?.did_not_play === true) continue;
    const labels = entry.labels.map(label => str(label).toUpperCase().trim());
    for (const [label, field] of Object.entries(columns)) {
      const index = labels.indexOf(label);
      if (index < 0) continue;
      const value = statNumber(arr(entry.row?.stats)[index]);
      if (value !== null) out[field] = value;
    }
  }
  return out;
}

/* "Kenneth Walker III 10 Yd Rush (Harrison Butker Kick)" -> "Kenneth Walker III".
 * "Ja'Marr Chase 3 Yd pass from Joe Burrow (...)"        -> "Ja'Marr Chase".
 * The scorer is everything before the yardage; the passer, when there is one,
 * sits after it and is never returned. */
const SCORER_RE = /^\s*(.+?)\s+(-?\d+)\s+Yd\b/i;
export function scorerFromScoringText(text) {
  const match = SCORER_RE.exec(str(text));
  return match ? { name: match[1].trim(), yards: Number(match[2]) } : null;
}

export function isOffensiveTouchdown(scoringPlay) {
  const typeId = str(scoringPlay?.type_id);
  if (OFFENSIVE_TD_TYPES[typeId]) return true;
  const type = str(scoringPlay?.type).toLowerCase();
  return type === 'rushing touchdown' || type === 'passing touchdown';
}

/* Scoring plays that credit THIS player (by exact normalised full name, the
 * name having already been proven by ESPN id), in game order, each joined to
 * the play log for its wallclock. */
export function targetScoringPlays(detail, verifiedName) {
  const want = normalizePlayerName(verifiedName);
  if (!want) return [];
  const log = new Map(arr(detail?.plays).map(play => [str(play?.id), play]));
  const out = [];
  arr(detail?.scoring_plays).forEach((scoring, order) => {
    if (!isOffensiveTouchdown(scoring)) return;
    const scorer = scorerFromScoringText(scoring?.text);
    if (!scorer || normalizePlayerName(scorer.name) !== want) return;
    const logged = log.get(str(scoring?.id)) || null;
    out.push({ order, scoring, scorer, logged });
  });
  return out;
}

/* The verdict for one target against one game payload.
 * Outcomes: hit | no_td | not_open | identity_missing | identity_mismatch |
 * play_unmatched | freshness_unproven | stale_existing_hit.
 *
 * mode 'live' (the Worker): statuses defaults to open only; a fresh play is a
 * hit (detection live_fresh), an older one is stale_existing_hit and carries a
 * live_stale row to persist, never to announce.
 * mode 'final_backfill' (one-off recovery): the caller names the statuses
 * (graded wins); freshness does not apply and the row says final_backfill. */
export function evaluateTarget({ target, detail, nowMs = Date.now(), freshnessMs = FRESHNESS_MS, mode = 'live', statuses = ['open'] }) {
  if (!statuses.includes(str(target?.status))) return { outcome: 'not_open' };
  const snapshot = target?.model_snapshot || {};
  const espnPlayerId = snapshot.player?.espn_id;
  if (!/^\d+$/.test(str(espnPlayerId).trim())) return { outcome: 'identity_missing' };

  /* THE definition. Same function, same arguments, as the final grader. */
  const seen = readPlayerScoring(detail?.player_stats, target.player_key || target.player_name);
  if (seen.matched !== true || !(seen.offensive_td > 0)) return { outcome: 'no_td', seen };

  const identity = boxIdentity(detail?.player_stats, target.player_key || target.player_name, espnPlayerId);
  if (identity.status !== 'ok') return { outcome: identity.status === 'absent' ? 'no_td' : identity.status, seen };

  const plays = targetScoringPlays(detail, identity.name);
  /* Every touchdown the box score credits must be accounted for by a scoring
   * play before the FIRST one can be named; otherwise an unmatched earlier
   * touchdown could make a later one look like the moment he connected. */
  if (plays.length < seen.offensive_td) return { outcome: 'play_unmatched', seen };

  const first = plays[0];
  if (first.logged && first.logged.scoring_play === false) return { outcome: 'play_unmatched', seen };
  const wallMs = Date.parse(first.logged?.wallclock || '');
  if (mode === 'final_backfill') {
    /* The game is over and graded; the play is history, so its age is not a
       question. The wallclock is kept when the log has it, never invented. */
    const known = Number.isFinite(wallMs);
    return {
      outcome: 'hit',
      seen,
      row: hitRow({ target, detail, identity, seen, first, wallMs: known ? wallMs : null, ageMs: known ? nowMs - wallMs : null, detection: 'final_backfill' }),
    };
  }
  if (!Number.isFinite(wallMs)) return { outcome: 'freshness_unproven', seen };
  const ageMs = nowMs - wallMs;
  if (ageMs < -FUTURE_TOLERANCE_MS) return { outcome: 'freshness_unproven', seen };
  if (ageMs > freshnessMs) {
    return {
      outcome: 'stale_existing_hit',
      seen,
      play_age_s: ageMs === null ? null : Math.round(ageMs / 1000),
      row: hitRow({ target, detail, identity, seen, first, wallMs, ageMs, detection: 'live_stale' }),
    };
  }

  return {
    outcome: 'hit',
    seen,
    row: hitRow({ target, detail, identity, seen, first, wallMs, ageMs, detection: 'live_fresh' }),
  };
}

function hitRow({ target, detail, identity, seen, first, wallMs, ageMs, detection }) {
  const snapshot = target.model_snapshot || {};
  const game = detail?.game || {};
  const away = game.teams?.away || {};
  const home = game.teams?.home || {};
  const scoring = first.scoring;
  const team = identity.team || snapshot.player?.team || null;
  const opponent = team && team === away.abbreviation ? home.abbreviation
    : team && team === home.abbreviation ? away.abbreviation
    : snapshot.player?.opponent || null;
  const awayScore = toInt(scoring?.away_score) ?? toInt(away.score);
  const homeScore = toInt(scoring?.home_score) ?? toInt(home.score);
  return {
    pick_id: target.id,
    market: 'player_anytime_td',
    event_id: str(target.event_id),
    espn_id: str(game.id),
    season: target.season,
    week: target.week,
    kickoff_ts: target.kickoff_ts,
    player_name: target.player_name,
    player_key: target.player_key,
    espn_player_id: str(snapshot.player.espn_id),
    gsis_id: snapshot.player?.gsis_id ? str(snapshot.player.gsis_id) : null,
    position: snapshot.player?.position || null,
    team,
    opponent,
    target_rank: target.target_rank,
    publication_scope: target.publication_scope || 'tracking',
    model_prob: target.model_prob ?? null,
    market_price: toInt(target.market_price),
    confidence_bucket: target.confidence_bucket ?? null,
    play_id: str(scoring?.id) || null,
    play_type: scoring?.type || OFFENSIVE_TD_TYPES[str(scoring?.type_id)] || null,
    play_text: scoring?.text || null,
    period: toInt(scoring?.period) ?? toInt(game.status?.period),
    clock: scoring?.clock || null,
    play_wallclock: wallMs === null ? null : new Date(wallMs).toISOString(),
    away_team: away.abbreviation || null,
    home_team: home.abbreviation || null,
    away_score: awayScore,
    home_score: homeScore,
    /* A real photograph from the feed, of the athlete proven by id, or none. */
    headshot_url: identity.headshot,
    live_stats: liveStatLine(identity.rows),
    detection,
    source: {
      provider: detail?.source?.provider || null,
      result_definition: RESULT_DEFINITION,
      detector: DETECTOR,
      player_identity: 'espn_player_id',
      live_status: game.status?.semantics || null,
      scoring_play_id: str(scoring?.id) || null,
      play_yards: Number.isFinite(first.scorer?.yards) ? first.scorer.yards : null,
      play_age_s: ageMs === null ? null : Math.round(ageMs / 1000),
      freshness_limit_s: Math.round(FRESHNESS_MS / 1000),
      box_offensive_td: seen.offensive_td,
      box_rushing_td: seen.rushing_td,
      box_receiving_td: seen.receiving_td,
      headshot_authority: identity.headshot ? 'box_score_athlete' : 'none',
      fetched_at: detail?.source?.fetched_at || null,
    },
  };
}
