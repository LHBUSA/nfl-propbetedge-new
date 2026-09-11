/* PBE Replay — nflverse post-game enrichment core (pure, no I/O).
 *
 * nflverse publishes play-by-play the day after a game: structured passer /
 * rusher / receiver, air yards, YAC, EPA, win probability and its delta, CPOE,
 * pass-over-expected. None of it exists in ESPN's live feed, and all of it is
 * CC-BY-4.0 (attribution: nflverse). It is POST-GAME data and is never merged
 * into the live layer or labelled live.
 *
 * THE JOIN IS EXACT. ESPN's play id is the ESPN event id followed by the
 * nflverse/GSIS play_id: ESPN 40187265740 == event 401872657 + play_id 40.
 * Measured on 2026_01_SF_LA: 147 of 157 nflverse plays join by key; the rest
 * are rows ESPN does not publish as plays (GAME start, timeouts, extra points
 * folded into the scoring play's text). No text matching, no clock guessing.
 */

/* The columns Replay uses — a deliberate subset of the 372 published. */
export const COLUMNS = [
  'game_id', 'play_id', 'qtr', 'play_type', 'posteam', 'defteam',
  'passer_player_name', 'passer_player_id', 'receiver_player_name', 'receiver_player_id',
  'rusher_player_name', 'rusher_player_id', 'interception_player_name', 'solo_tackle_1_player_name',
  'air_yards', 'yards_after_catch', 'yards_gained', 'epa', 'wp', 'wpa', 'cpoe', 'xpass', 'pass_oe',
  'touchdown', 'interception', 'fumble_lost', 'sack', 'drive'
];

/* RFC-4180 CSV: quoted fields, doubled quotes, embedded commas and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const NUMERIC = new Set(['qtr', 'air_yards', 'yards_after_catch', 'yards_gained', 'epa', 'wp', 'wpa', 'cpoe', 'xpass', 'pass_oe', 'drive']);
const FLAGS = new Set(['touchdown', 'interception', 'fumble_lost', 'sack']);

/* One game's plays, keyed by the ESPN play id they join to. NA stays null —
   an absent EPA is absent, never zero. */
export function extractGame(rows, gameId, espnEventId) {
  const header = rows[0] || [];
  const at = Object.fromEntries(COLUMNS.map(c => [c, header.indexOf(c)]));
  if (at.game_id < 0 || at.play_id < 0) throw new Error('nflverse_schema_changed');
  const plays = {};
  let count = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row[at.game_id] !== gameId) continue;
    const pid = row[at.play_id];
    if (!/^\d+$/.test(pid || '')) continue;
    const out = {};
    for (const c of COLUMNS) {
      if (c === 'game_id' || c === 'play_id' || at[c] < 0) continue;
      const raw = row[at[c]];
      if (raw === undefined || raw === '' || raw === 'NA') continue;
      if (NUMERIC.has(c)) { const n = Number(raw); if (Number.isFinite(n)) out[c] = Math.round(n * 1000) / 1000; }
      else if (FLAGS.has(c)) { if (raw === '1') out[c] = true; }
      else out[c] = raw;
    }
    out.play_id = Number(pid);
    plays[`${espnEventId}${pid}`] = out;
    count++;
  }
  return { plays, count };
}

/* How much of the ESPN play log the enrichment actually covers. */
export function joinRate(enrichedIds, espnPlayIds) {
  const set = new Set(enrichedIds);
  const ids = [...espnPlayIds];
  const joined = ids.filter(id => set.has(String(id))).length;
  return { joined, espn_plays: ids.length, rate: ids.length ? joined / ids.length : 0 };
}
