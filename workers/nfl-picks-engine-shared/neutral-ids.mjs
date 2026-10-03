// Neutral public identifiers for Worker responses (PropSports data contract, 2026-10-03). Pure, no I/O: the caller
// passes the bundled crosswalk (data/dist/player-id-crosswalk.json). Mirrors api/_neutral-ids.js.
//   player_id  canonical NFL player id (gsis), added next to a deprecated lane `espn_id` on PLAYER objects only, and
//              only when the crosswalk proves the pair (never filled with a lane value).
// Legacy fields keep their values; deprecated_fields + deprecation_note are added to object envelopes.
export const DEPRECATED_ID_NOTE = 'Legacy collection-lane identifiers are compatibility-only and will be removed in a future versioned contract; use player_id / game_id / team_id.';

export function laneToPlayer(crosswalk) {
  return new Map(Object.entries(crosswalk?.lane_to_player_id || {}));
}

export function playerIdFrom(map, laneId) {
  return laneId == null || laneId === '' ? null : map.get(String(laneId)) || null;
}

export function laneIdFrom(map, playerId) {
  if (!/^00-\d{7}$/.test(String(playerId || ''))) return null;
  for (const [lane, pid] of map) if (pid === playerId) return lane;
  return null;
}

// Adds player_id to player objects (key `player`, or rows of `players`/`leaders`) carrying espn_id, and marks the
// envelope's deprecated id fields. Mutates and returns body.
export function neutralizeIds(body, map) {
  if (!body || typeof body !== 'object') return body;
  const found = new Set();
  const visit = (o, parentKey, depth) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) { for (const x of o) visit(x, parentKey, depth + 1); return; }
    const isPlayer = parentKey === 'player' || parentKey === 'players' || parentKey === 'leaders' || parentKey === 'athletes';
    if (isPlayer && 'espn_id' in o && !('player_id' in o)) {
      const pid = playerIdFrom(map, o.espn_id);
      if (pid) o.player_id = pid;
    }
    scanKeys(o, found);
    for (const [k, v] of Object.entries(o)) visit(v, k, depth + 1);
  };
  visit(body, null, 0);
  if (!Array.isArray(body) && found.size) {
    body.deprecated_fields = [...new Set([...(body.deprecated_fields || []), ...found])].sort();
    body.deprecation_note = body.deprecation_note || DEPRECATED_ID_NOTE;
  }
  return body;
}

function scanKeys(o, found) {
  for (const k of Object.keys(o)) if (/(?:^|_)espn(?:_|$)/.test(k) || k === 'espnId') found.add(k);
}
