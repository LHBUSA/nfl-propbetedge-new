/* Neutral public identifiers (PropSports data contract, 2026-10-03).
 *
 * Additive only. Legacy collection-lane identifiers (espn_id, espn_athlete_id, espn_event_id, espn_team_id and the
 * ?espn_id= query parameter) keep working and keep their values; they are deprecated, compatibility-only and will be
 * removed in a future versioned contract (docs/SOURCE_BRAND.md).
 *
 *   player_id  canonical NFL player id (gsis, e.g. "00-0033873"): the same id the DNA endpoints already accept as
 *              ?player_id=. Added ONLY when the crosswalk proves the pair; never filled with a lane value.
 *   game_id    PropSports scoreboard game id: the opaque value of scoreboard games[].id. Not `event_id`, which
 *              already means the MARKET (odds) event on /api/game-intel and /api/matchup-intel.
 *   team_id    team abbreviation (e.g. "KC"), the id every NFL surface already keys teams by.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let CROSSWALK = null;
function crosswalk() {
  if (CROSSWALK) return CROSSWALK;
  try {
    const j = JSON.parse(readFileSync(join(process.cwd(), 'data', 'dist', 'player-id-crosswalk.json'), 'utf8'));
    const toPlayer = new Map(Object.entries(j.lane_to_player_id || {}));
    CROSSWALK = { toPlayer, toLane: new Map([...toPlayer].map(([e, g]) => [g, e])) };
  } catch {
    CROSSWALK = { toPlayer: new Map(), toLane: new Map() };
  }
  return CROSSWALK;
}

export const GSIS_RE = /^00-\d{7}$/;

/** Canonical player_id for a lane athlete id, or null when unproven. */
export function playerIdFor(laneId) {
  if (laneId == null || laneId === '') return null;
  return crosswalk().toPlayer.get(String(laneId)) || null;
}

/** Lane athlete id for a canonical player_id, or null. */
export function laneIdFor(playerId) {
  if (!GSIS_RE.test(String(playerId || ''))) return null;
  return crosswalk().toLane.get(String(playerId)) || null;
}

/** Route input: the lane athlete id a request identifies, from ?espn_id= (deprecated) or ?player_id= (neutral). */
export function athleteParam(query = {}) {
  const legacy = String(query.espn_id ?? '').trim();
  if (legacy) return { laneId: legacy, via: 'espn_id' };
  const pid = String(query.player_id ?? '').trim();
  if (pid) return { laneId: laneIdFor(pid), via: 'player_id', player_id: pid };
  return { laneId: '', via: null };
}

/** Route input: the scoreboard game a request identifies, from ?game_id= (neutral) or legacy keys. */
export function gameParam(query = {}, legacyKeys = ['espn_id', 'event']) {
  const g = String(query.game_id ?? '').trim();
  if (g) return g;
  for (const k of legacyKeys) { const v = String(query[k] ?? '').trim(); if (v) return v; }
  return '';
}

export const DEPRECATED_ID_NOTE = 'Legacy collection-lane identifiers are compatibility-only and will be removed in a future versioned contract; use player_id / game_id / team_id.';

/** The deprecated identifier keys present on a body (shallow + one level of arrays/objects), for meta. */
export function deprecatedIdFields(body) {
  const keys = new Set();
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (Array.isArray(o)) { for (const x of o.slice(0, 50)) visit(x, depth + 1); return; }
    for (const [k, v] of Object.entries(o)) {
      if (/(?:^|_)espn(?:_|$)/.test(k) || k === 'espnId') keys.add(k);
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(body, 0);
  return [...keys].sort();
}

/** Adds deprecated_fields + note to an envelope when legacy id keys are present. Mutates and returns body. */
export function markDeprecatedIds(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const found = deprecatedIdFields(body);
  if (found.length) {
    body.deprecated_fields = [...new Set([...(body.deprecated_fields || []), ...found])].sort();
    body.deprecation_note = body.deprecation_note || DEPRECATED_ID_NOTE;
  }
  return body;
}
