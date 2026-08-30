/* NFL venue table — roof type and coordinates, keyed by the gateway's home
 * team code.
 *
 * Needed because /api/schedule returns only game_id, season, week, gameday,
 * gametime and the two team codes. Without coordinates the wind15 and cold25
 * features could only ever be 0, which would silently disable two of the
 * brief's twelve features rather than compute them.
 *
 * roof: 'dome' and 'retractable' both suppress weather. Retractable roofs are
 * treated as closed because the operating decision is not knowable at pick
 * time, and assuming "open" would invent weather that may not apply.
 */

export const STADIUMS = {
  ARI: { roof: 'retractable', lat: 33.5277, lon: -112.2626 },
  ATL: { roof: 'retractable', lat: 33.7554, lon: -84.4008 },
  BAL: { roof: 'open', lat: 39.2780, lon: -76.6227 },
  BUF: { roof: 'open', lat: 42.7738, lon: -78.7870 },
  CAR: { roof: 'open', lat: 35.2258, lon: -80.8528 },
  CHI: { roof: 'open', lat: 41.8623, lon: -87.6167 },
  CIN: { roof: 'open', lat: 39.0955, lon: -84.5161 },
  CLE: { roof: 'open', lat: 41.5061, lon: -81.6995 },
  DAL: { roof: 'retractable', lat: 32.7473, lon: -97.0945 },
  DEN: { roof: 'open', lat: 39.7439, lon: -105.0201 },
  DET: { roof: 'dome', lat: 42.3400, lon: -83.0456 },
  GB: { roof: 'open', lat: 44.5013, lon: -88.0622 },
  HOU: { roof: 'retractable', lat: 29.6847, lon: -95.4107 },
  IND: { roof: 'retractable', lat: 39.7601, lon: -86.1639 },
  JAX: { roof: 'open', lat: 30.3239, lon: -81.6373 },
  KC: { roof: 'open', lat: 39.0489, lon: -94.4839 },
  LA: { roof: 'dome', lat: 33.9535, lon: -118.3392 },
  LAC: { roof: 'dome', lat: 33.9535, lon: -118.3392 },
  LV: { roof: 'dome', lat: 36.0909, lon: -115.1833 },
  MIA: { roof: 'open', lat: 25.9580, lon: -80.2389 },
  MIN: { roof: 'dome', lat: 44.9736, lon: -93.2575 },
  NE: { roof: 'open', lat: 42.0909, lon: -71.2643 },
  NO: { roof: 'dome', lat: 29.9511, lon: -90.0812 },
  NYG: { roof: 'open', lat: 40.8135, lon: -74.0745 },
  NYJ: { roof: 'open', lat: 40.8135, lon: -74.0745 },
  PHI: { roof: 'open', lat: 39.9008, lon: -75.1675 },
  PIT: { roof: 'open', lat: 40.4468, lon: -80.0158 },
  SEA: { roof: 'open', lat: 47.5952, lon: -122.3316 },
  SF: { roof: 'open', lat: 37.4033, lon: -121.9694 },
  TB: { roof: 'open', lat: 27.9759, lon: -82.5033 },
  TEN: { roof: 'open', lat: 36.1665, lon: -86.7713 },
  WAS: { roof: 'open', lat: 38.9077, lon: -76.8645 },
};

export function isIndoor(teamCode) {
  const venue = STADIUMS[teamCode];
  return Boolean(venue && venue.roof !== 'open');
}

export function venueFor(teamCode) {
  return STADIUMS[teamCode] || null;
}

/* Days of rest for each team going into every game, derived from the full
 * schedule. Week 1 has no prior game, so both sides get the league-standard 7
 * rather than a fabricated advantage.
 *
 * Returns Map<game_id, { [teamCode]: restDays }>.
 */
export function restDaysBySchedule(games) {
  /* Measured in CALENDAR days between game dates, which is the conventional
   * NFL definition: a Sunday team playing the following Thursday is on four
   * days' rest. Using elapsed hours would round that to three whenever the
   * Thursday kickoff is earlier in the day than the Sunday one. */
  const dayOf = g => Date.parse(`${g.gameday}T00:00:00Z`);
  const ordered = [...games]
    .map(g => ({ ...g, day: dayOf(g), ts: Date.parse(`${g.gameday}T${g.gametime || '00:00'}:00Z`) }))
    .filter(g => Number.isFinite(g.day))
    .sort((a, b) => a.day - b.day || a.ts - b.ts);

  const lastPlayed = new Map();
  const out = new Map();

  for (const game of ordered) {
    const entry = {};
    for (const team of [game.away_team, game.home_team]) {
      const previous = lastPlayed.get(team);
      entry[team] = previous === undefined
        ? 7
        : Math.round((game.day - previous) / 86400000);
    }
    out.set(game.game_id, entry);
    lastPlayed.set(game.away_team, game.day);
    lastPlayed.set(game.home_team, game.day);
  }
  return out;
}
