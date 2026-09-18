/* Game identity: one canonical game, many provider names for it.
 *
 * The defect this exists for: PropBetEdge derives an nflverse-style id as
 * `season_week_AWAY_HOME` with postseason week = ESPN postseason week + 18.
 * Measured against nflverse's own data (data/warehouse/nfl_games.parquet,
 * 1,960 games, 2019-2025), the real rule is
 *
 *     postseason week = (number of regular-season weeks) + round
 *
 * which is 17 + round for 1999-2020 and 18 + round for 2021+:
 *
 *     2019, 2020   WC 18  DIV 19  CONF 20  SB 21
 *     2021-2025    WC 19  DIV 20  CONF 21  SB 22
 *
 * So `+18` is right only for Wild Card, Divisional and Conference in 2021+,
 * and the Super Bowl lands on week 23, which does not exist. ESPN also numbers
 * the Pro Bowl as postseason week 4, which `+18` maps onto 22 — the same slot
 * nflverse uses for the Super Bowl. The Pro Bowl is not a league game and is
 * refused here.
 *
 * Nothing in this module rewrites an id. Ids already issued stay exactly as
 * they are; `resolve()` reads both the legacy and the corrected spelling, and
 * `alias()` produces the crosswalk row that lets an old id keep resolving.
 * Pure, no I/O.
 */

export const ROUNDS = Object.freeze({ 1: 'wild_card', 2: 'divisional', 3: 'conference', 4: 'super_bowl' });
export const ROUND_LABEL = Object.freeze({ wild_card: 'Wild Card', divisional: 'Divisional', conference: 'Conference Championship', super_bowl: 'Super Bowl' });

/* ESPN seasontype 3 week numbers. 4 is the Pro Bowl, which is not a league
   game and has no nflverse row. */
export const ESPN_POSTSEASON_WEEK_TO_ROUND = Object.freeze({ 1: 1, 2: 2, 3: 3, 5: 4 });
export const ESPN_PRO_BOWL_WEEK = 4;
/* The all-star game is played by conference sides, which is how a legacy Pro
   Bowl id is told apart from a real game that happens to share its week. */
export const ALL_STAR_TEAMS = Object.freeze(new Set(['AFC', 'NFC']));

export class GameIdentityError extends Error {}

/** Regular-season week count, which is what postseason numbering counts from. */
export function regularSeasonWeeks(season) {
  const y = Number(season);
  if (!Number.isInteger(y)) throw new GameIdentityError('season_required');
  if (y >= 2021) return 18;
  if (y >= 1999) return 17;
  /* nflverse play-by-play starts at 1999; earlier eras had different schedule
     lengths (and strike seasons of their own). Unknown, not guessed. */
  throw new GameIdentityError(`regular_season_weeks_unknown_for_${y}`);
}

/** The week number nflverse uses for a postseason round. */
export function postseasonWeek(season, round) {
  const r = Number(round);
  if (!ROUNDS[r]) throw new GameIdentityError(`unknown_round:${round}`);
  return regularSeasonWeeks(season) + r;
}

/** ESPN's postseason week -> our round, refusing the Pro Bowl. */
export function roundFromEspnWeek(week) {
  const w = Number(week);
  if (w === ESPN_PRO_BOWL_WEEK) throw new GameIdentityError('pro_bowl_is_not_a_league_game');
  const round = ESPN_POSTSEASON_WEEK_TO_ROUND[w];
  if (!round) throw new GameIdentityError(`unknown_espn_postseason_week:${week}`);
  return round;
}

const TEAM = /^[A-Z]{2,3}$/;
const ID = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/;

function assertTeams(away, home) {
  if (!TEAM.test(String(away || '')) || !TEAM.test(String(home || ''))) throw new GameIdentityError('team_codes_required');
}

/**
 * The provider (nflverse) spelling of a game.
 * @param {{season:number, seasonType:'REG'|'POST', week?:number, round?:number, away:string, home:string}} g
 */
export function providerGameId({ season, seasonType, week, round, away, home }) {
  assertTeams(away, home);
  const type = String(seasonType || '').toUpperCase();
  if (type === 'REG') {
    const w = Number(week);
    if (!Number.isInteger(w) || w < 1 || w > regularSeasonWeeks(season)) throw new GameIdentityError(`bad_regular_week:${week}`);
    return `${season}_${String(w).padStart(2, '0')}_${away}_${home}`;
  }
  if (type !== 'POST') throw new GameIdentityError(`unsupported_season_type:${seasonType}`);
  const r = round != null ? Number(round) : roundFromEspnWeek(week);
  return `${season}_${String(postseasonWeek(season, r)).padStart(2, '0')}_${away}_${home}`;
}

/** The id PropBetEdge issued before the fix: postseason week = ESPN week + 18. */
export function legacyPropBetEdgeGameId({ season, seasonType, week, away, home }) {
  assertTeams(away, home);
  const type = String(seasonType || '').toUpperCase();
  if (type !== 'REG' && type !== 'POST') return null;
  const w = Number(week);
  if (!Number.isInteger(w) || w < 1) return null;
  const legacyWeek = type === 'POST' ? w + 18 : w;
  return `${season}_${String(legacyWeek).padStart(2, '0')}_${away}_${home}`;
}

/**
 * Read an id of either spelling.
 *
 * Postseason ids can be genuinely ambiguous. Legacy week = ESPN week + 18 and
 * provider week = regular-season weeks + round, so in 1999-2020 (17 weeks) a
 * legacy Wild Card id (19) is byte-identical to a provider Divisional id (19).
 * The string alone cannot decide; `assume` states which system issued it, and
 * `ambiguous` reports when that mattered.
 *
 * @param {string} id
 * @param {{assume?:'provider'|'legacy'}} [opts] default 'provider'
 */
export function resolve(id, { assume = 'provider' } = {}) {
  const m = ID.exec(String(id || ''));
  if (!m) throw new GameIdentityError('unparseable_game_id');
  const season = Number(m[1]);
  const week = Number(m[2]);
  const [, , , away, home] = m;
  const regWeeks = regularSeasonWeeks(season);
  const base = { id: String(id), season, week, away, home, ambiguous: false, interpretations: [] };

  if (week >= 1 && week <= regWeeks) {
    return { ...base, season_type: 'REG', round: null, round_key: null, spelling: 'provider' };
  }

  /* An all-star game is never a league game, whatever week it claims. */
  if (ALL_STAR_TEAMS.has(away) && ALL_STAR_TEAMS.has(home)) {
    return { ...base, season_type: 'POST', round: null, round_key: 'pro_bowl', spelling: 'legacy' };
  }

  const providerRound = ROUNDS[week - regWeeks] ? week - regWeeks : null;
  const espnWeek = week - 18;
  const legacyRound = espnWeek === ESPN_PRO_BOWL_WEEK ? null : (ESPN_POSTSEASON_WEEK_TO_ROUND[espnWeek] || null);
  const interpretations = [];
  if (providerRound) interpretations.push({ spelling: 'provider', round: providerRound, round_key: ROUNDS[providerRound] });
  if (legacyRound) interpretations.push({ spelling: 'legacy', round: legacyRound, round_key: ROUNDS[legacyRound] });
  if (espnWeek === ESPN_PRO_BOWL_WEEK) interpretations.push({ spelling: 'legacy', round: null, round_key: 'pro_bowl' });

  if (!interpretations.length) {
    return { ...base, season_type: 'POST', round: null, round_key: null, spelling: 'unknown_week' };
  }
  const chosen = interpretations.find(i => i.spelling === assume) || interpretations[0];
  return {
    ...base, season_type: 'POST', round: chosen.round, round_key: chosen.round_key, spelling: chosen.spelling,
    ambiguous: interpretations.length > 1, interpretations,
  };
}

/** Does this id spell the round the way the provider does? */
export function isProviderSpelling(id) {
  try {
    const read = resolve(id);
    return read.spelling === 'provider' && read.round_key !== 'pro_bowl';
  } catch { return false; }
}

/**
 * The crosswalk row for an id that was issued in the legacy spelling. Additive:
 * the issued id is never rewritten, because the receipt hashes it and rewriting
 * it would fail verification and drop the pick from the track record.
 */
export function alias(issuedId, { spelling = 'legacy' } = {}) {
  const read = resolve(issuedId, { assume: spelling });
  if (read.spelling === 'provider' && read.round_key !== 'pro_bowl') return null;
  if (read.round_key === 'pro_bowl') {
    return { issued_id: read.id, provider_id: null, reason: 'pro_bowl_is_not_a_league_game', season: read.season, round_key: 'pro_bowl' };
  }
  if (!read.round) return { issued_id: read.id, provider_id: null, reason: 'week_outside_known_schedule', season: read.season, round_key: null };
  return {
    issued_id: read.id,
    provider_id: providerGameId({ season: read.season, seasonType: 'POST', round: read.round, away: read.away, home: read.home }),
    reason: 'legacy_postseason_week_offset',
    season: read.season,
    round_key: read.round_key,
    /* True when the issued string is also a valid provider id for a different
       round, so the crosswalk must be trusted over the string itself. */
    ambiguous: read.ambiguous === true,
  };
}
