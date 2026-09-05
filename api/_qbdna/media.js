/* Identity-safe media URLs. ONE place builds these, and both /api/nfl-media
 * and the QB DNA routes use it — this is not a second resolver.
 * =============================================================================
 * The rule QB DNA adds on top of the product-wide media layer:
 *
 *   a picture attached to a player must BE that player.
 *
 * So a headshot is built from the STABLE ESPN ATHLETE ID and nothing else. The
 * name-search path in /api/nfl-media stays where it is for generic surfaces;
 * QB DNA never uses it, because a fuzzy name match that returns the wrong face
 * is worse than no face at all.
 *
 * There is deliberately no fallback here. No PBE mark, no initials avatar, no
 * generic helmet. An identity with no resolvable photo returns null and the UI
 * renders an explicit "photo unavailable" state.
 * ========================================================================== */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADSHOT = 'https://a.espncdn.com/i/headshots/nfl/players/full';
const TEAM_LOGO = 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard';

/** Real ESPN headshot for a known athlete id. Null when there is no id. */
export function headshotUrl(espnId) {
  const id = String(espnId ?? '').replace(/[^0-9]/g, '');
  return id ? `${HEADSHOT}/${id}.png` : null;
}

/** Real ESPN team logo for a team abbreviation. Null when there is none. */
export function teamLogoUrl(abbr) {
  const clean = String(abbr ?? '').replace(/[^A-Za-z]/g, '').toLowerCase();
  return clean ? `${TEAM_LOGO}/${clean}.png` : null;
}

/** The media block attached to a player identity in a QB DNA response. */
export function playerMedia(espnId) {
  const url = headshotUrl(espnId);
  return url
    ? { headshot_url: url, source: 'ESPN', resolved_by: 'espn_athlete_id' }
    : { headshot_url: null, source: null, resolved_by: null,
        unavailable_reason: 'no ESPN athlete id on this identity' };
}

/** The media block attached to a team in a QB DNA response. */
export function teamMedia(abbr) {
  const url = teamLogoUrl(abbr);
  return url
    ? { logo_url: url, source: 'ESPN', resolved_by: 'team_abbreviation' }
    : { logo_url: null, source: null, resolved_by: null,
        unavailable_reason: 'no team abbreviation on this identity' };
}

/* Real franchise names come from our own venue table (built from the ESPN
   teams API), so a crest is always captioned with the actual club rather than
   a bare abbreviation. */
let TEAMS = null;
function teamTable() {
  if (TEAMS) return TEAMS;
  try {
    const p = join(process.cwd(), 'data', 'dist', 'nfl-venues.json');
    TEAMS = JSON.parse(readFileSync(p, 'utf8')).teams || {};
  } catch { TEAMS = {}; }
  return TEAMS;
}

/* nflverse and ESPN disagree on a handful of abbreviations. Aliased explicitly
   so a crest is never dropped for a team we plainly have. */
const ABBR_ALIAS = { LA: 'LAR', WAS: 'WSH', OAK: 'LV', SD: 'LAC', STL: 'LAR' };

export function canonicalAbbr(abbr) {
  const a = String(abbr ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return ABBR_ALIAS[a] || a;
}

/** A full team identity block: abbreviation, real name and media. */
export function teamBlock(abbr, name) {
  const a = canonicalAbbr(abbr);
  if (!a) return null;
  const row = teamTable()[a];
  return {
    abbreviation: a,
    name: name || (row && row.team_name) || null,
    espn_team_id: (row && row.espn_team_id) || null,
    media: teamMedia(a)
  };
}
