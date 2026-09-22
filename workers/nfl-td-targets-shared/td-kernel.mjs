/* PropBetEdge NFL — PBE Touchdown Targets probability kernel.
 *
 * ONE implementation of the arithmetic, imported by three callers that must
 * never disagree: the build script that fits the model, the orchestrator that
 * issues targets, and the test suite. A second copy of any line below would be
 * a second model.
 *
 * WHAT IT ESTIMATES
 *   P(the player scores at least one OFFENSIVE touchdown in this game
 *     | information available before kickoff)
 *
 * An offensive touchdown is a rushing touchdown or a receiving touchdown
 * credited to the player. A quarterback's passing touchdowns are not his own
 * score. Return and defensive touchdowns are outside the label; the grader
 * observes them separately so the divergence from a book's settlement rule is
 * recorded rather than hidden.
 *
 * SHAPE
 *   factual features
 *     -> lambda   expected offensive touchdowns, a rate with a real denominator
 *     -> p        1 - exp(-lambda), the Poisson probability of at least one
 *     -> p_cal    logistic recalibration of logit(p), fitted out of sample
 *
 * The market is deliberately NOT an input to the probability. A de-vigged
 * anytime-touchdown price is recorded in every snapshot, is used for edge, EV
 * and the qualification gate, and is available to a future challenger — but
 * the champion's number is generated from factual football inputs alone, so
 * "PBE probability" can never be the sportsbook's probability wearing our
 * name.
 *
 * MISSING IS MISSING
 * Every multiplier reports whether its input existed. A component with no
 * factual input contributes exactly 1 and says `available: false`. It is never
 * a guessed 1 presented as a measurement, and a missing rate never becomes 0.
 */

export const MODEL_VERSION = 'pbe-td-hazard-v1';
export const LABEL = 'at least one rushing or receiving touchdown credited to the player in the official final box score';

/* Recency: a game 10 games ago carries half the weight of the last one. The
 * same half-life the production passing baseline uses for its own game log. */
export const HALF_LIFE_GAMES = 10;

/* Shrinkage strength, in games. A player with six weighted games of history
 * sits halfway between his own rate and his position/role prior. This is what
 * keeps a player who scored twice last week from being crowned. */
export const SHRINK_PRIOR_GAMES = 6;

export const RZ_TIERS = Object.freeze(['low', 'mid', 'high', 'unknown']);

/* Integrity guard. A lambda outside this range means an input is wrong, not
 * that a player is about to score four touchdowns. */
export const LAMBDA_MAX = 3;

export function logistic(z) {
  const value = Number(z);
  if (!Number.isFinite(value)) throw new Error('bad_logit');
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const e = Math.exp(value);
  return e / (1 + e);
}

export function logit(p) {
  const value = Number(p);
  if (!(value > 0 && value < 1)) throw new Error('bad_prob');
  return Math.log(value / (1 - value));
}

export function poissonAtLeastOne(lambda) {
  if (lambda === null || lambda === undefined || lambda === '') throw new Error('bad_lambda');
  const value = Number(lambda);
  if (!Number.isFinite(value) || value < 0) throw new Error('bad_lambda');
  return 1 - Math.exp(-value);
}

export function normalizePlayerName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Market entries that are not a person. A book prices a team defence and a
 * "no touchdown scorer" line in the same market; neither is a target. */
const NON_PLAYER = /(\bd\/st\b|\bdefen[cs]e\b|\bno (scorer|touchdown)\b|\bany other\b|\bfield\b)/i;
export function isNonPlayerSelection(name) {
  return NON_PLAYER.test(String(name || ''));
}

/* ------------------------------------------------------------ game context */

/* `spread` is the SELECTED TEAM's handicap in the Player DNA convention:
 * positive means that team is favoured by that many points. The Odds API
 * reports the opposite sign (a seven-point favourite is -7), so a live caller
 * must pass `spreadFromOddsPoint(point)` and never the raw point. Getting this
 * backwards silently inverts every game-script coefficient. */
export function spreadFromOddsPoint(point) {
  if (point === null || point === undefined || point === '') return null;
  const value = Number(point);
  return Number.isFinite(value) ? -value : null;
}

export function scriptBucketOf(spread) {
  /* No spread is no bucket. Without the explicit null check this would call a
   * game with no published handicap a pick'em and apply a real coefficient to
   * it on no evidence at all. */
  if (spread === null || spread === undefined || spread === '') return null;
  const value = Number(spread);
  if (!Number.isFinite(value)) return null;
  if (value >= 7) return 'heavy_favourite';
  if (value >= 3) return 'favourite';
  if (value > -3) return 'pickem';
  if (value > -7) return 'underdog';
  return 'heavy_underdog';
}

/* Weather applies to an open-air game with an observed forecast and nothing
 * else. A game under a roof is not "benign weather", it is no weather: it
 * returns null and the weather component reports itself unavailable. */
export function weatherBucketOf(context) {
  const roof = String(context?.roof || '').toLowerCase();
  const indoor = context?.indoor === true || roof === 'dome' || roof === 'closed';
  if (indoor || (roof && roof !== 'outdoors' && roof !== 'open')) return null;
  if (context?.weather_status && context.weather_status !== 'ok') return null;
  const wind = Number(context?.wind_mph);
  const temp = Number(context?.temp_f);
  if (!Number.isFinite(wind) && !Number.isFinite(temp)) return null;
  if (Number.isFinite(wind) && wind >= 15) return 'wind_15_plus';
  if (Number.isFinite(temp) && temp <= 32) return 'cold_32_or_below';
  return 'benign_outdoor';
}

/* ------------------------------------------------------------- the lambda */

/* MISSING IS NOT ZERO, and JavaScript disagrees: Number(null) is 0, Number('')
 * is 0, and both are finite. A tolerant helper here would have turned a game
 * with no published spread into a pick'em and a player with no rate into a
 * player who never scores. Null, undefined and empty string are missing. */
function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function damped(ratio, weight) {
  const r = finite(ratio);
  const w = finite(weight);
  if (r === null || w === null || !(r > 0)) return null;
  return 1 + w * (r - 1);
}

/* The rate a thin sample is shrunk toward: the player's own position AND his
 * red-zone opportunity tier, because a goal-line back and a third-down back
 * are not the same population. A tier without its own measured sample falls
 * back to the position, which always has one. */
export function priorRateFor(prior, rzTier) {
  const tier = prior?.rz_tiers?.[rzTier];
  const tierRate = finite(tier?.offensive_td_per_game);
  if (tierRate !== null) return { rate: tierRate, basis: `position_rz_${rzTier}`, rows: tier.rows };
  const positionRate = finite(prior?.offensive_td_per_game);
  if (positionRate !== null) return { rate: positionRate, basis: 'position', rows: prior.rows };
  return null;
}

/* Historical weighted rate, the current season's observed rate and the prior,
 * combined by their own weights. The current-season block is present only when
 * the current-season authority actually published this player; when it did not,
 * its weight is zero — which is the correct treatment of an absent sample and
 * is not the same as a zero rate. */
export function blendedRate({ baseline, currentSeason, prior, rzTier, priorGames = SHRINK_PRIOR_GAMES }) {
  const priorInfo = priorRateFor(prior, rzTier);
  if (!priorInfo) return null;
  const historyWeight = finite(baseline?.weighted_games) ?? 0;
  const historyRate = finite(baseline?.offensive_td_per_game);
  if (historyRate === null && historyWeight > 0) return null;

  const currentGames = finite(currentSeason?.games);
  const currentTds = finite(currentSeason?.offensive_td);
  const currentAvailable = currentSeason?.available === true && currentGames !== null && currentGames > 0 && currentTds !== null;
  const currentWeight = currentAvailable ? currentGames : 0;
  const currentRate = currentAvailable ? currentTds / currentGames : null;

  const weight = historyWeight + priorGames + currentWeight;
  if (!(weight > 0)) return null;
  const value = ((historyRate ?? 0) * historyWeight
    + priorInfo.rate * priorGames
    + (currentRate ?? 0) * currentWeight) / weight;
  return {
    rate: value,
    history: { weight: historyWeight, rate: historyRate, available: historyWeight > 0 },
    current_season: {
      weight: currentWeight,
      rate: currentRate,
      available: currentAvailable,
      unavailable_reason: currentAvailable ? null : (currentSeason?.unavailable_reason || 'current_season_layer_unavailable'),
    },
    prior: { weight: priorGames, rate: priorInfo.rate, basis: priorInfo.basis, rows: priorInfo.rows ?? null },
  };
}

/* The player's own touchdown mix decides how much of the opponent adjustment
 * comes from rushing touchdowns allowed and how much from receiving. A player
 * with no touchdowns in his sample has no mix of his own and borrows his
 * position's, which is measured. */
export function rushMixOf(baseline, prior) {
  const rush = finite(baseline?.rushing_td_per_game);
  const total = finite(baseline?.offensive_td_per_game);
  if (rush !== null && total !== null && total > 0) {
    return { mix: Math.min(1, Math.max(0, rush / total)), basis: 'player' };
  }
  const positionMix = finite(prior?.rush_share_of_td);
  if (positionMix !== null) return { mix: Math.min(1, Math.max(0, positionMix)), basis: 'position' };
  return null;
}

/* Expected offensive touchdowns for this player in this game.
 *
 *   lambda = blended per-game rate
 *            x team scoring environment
 *            x opponent concession
 *            x game script
 *            x weather
 *
 * Each multiplier is a measured ratio damped by a weight chosen on a held-out
 * season. A multiplier with no factual input is exactly 1 and says so. */
export function lambdaFor({
  baseline, currentSeason, prior, rzTier, team, leagueScored, opponent, leagueAllowed,
  scriptBucket, weatherBucket, coefficients, weights,
}) {
  const blended = blendedRate({ baseline, currentSeason, prior, rzTier, priorGames: weights?.shrink_prior_games ?? SHRINK_PRIOR_GAMES });
  if (!blended) {
    return { lambda: null, unavailable_reason: 'no_baseline_or_prior', components: null };
  }

  const components = {};

  const teamRatio = finite(team?.offensive_td_per_game) !== null && finite(leagueScored?.offensive_td_per_game) > 0
    ? team.offensive_td_per_game / leagueScored.offensive_td_per_game : null;
  const teamFactor = damped(teamRatio, weights?.team);
  components.team_environment = {
    available: teamFactor !== null,
    factor: teamFactor ?? 1,
    ratio: teamRatio === null ? null : round(teamRatio, 6),
    team_offensive_td_per_game: finite(team?.offensive_td_per_game),
    league_offensive_td_per_game: finite(leagueScored?.offensive_td_per_game),
    weight: finite(weights?.team),
    unavailable_reason: teamFactor === null ? 'team_scoring_profile_unavailable' : null,
  };

  /* ROLE. Red-zone opportunity is the most stable thing a scoring product can
   * observe: a back's goal-line carries move far less week to week than the
   * touchdowns they produce. The term is the player's own red-zone
   * opportunities per game against his position's mean, so a player whose
   * touchdown luck ran behind his usage is not written off for it. Available
   * only where the source recorded red-zone opportunities. */
  const roleRatio = finite(baseline?.rz_opportunities_per_game) !== null
    && finite(prior?.rz_opportunities_per_game) > 0
    ? baseline.rz_opportunities_per_game / prior.rz_opportunities_per_game : null;
  const roleFactor = damped(roleRatio, weights?.role);
  components.red_zone_role = {
    available: roleFactor !== null,
    factor: roleFactor ?? 1,
    ratio: roleRatio === null ? null : round(roleRatio, 6),
    player_rz_opportunities_per_game: finite(baseline?.rz_opportunities_per_game),
    position_rz_opportunities_per_game: finite(prior?.rz_opportunities_per_game),
    rz_td_conversion: finite(baseline?.rz_td_conversion),
    rz_target_share: finite(baseline?.rz_target_share),
    weight: finite(weights?.role),
    unavailable_reason: roleFactor === null ? 'red_zone_opportunities_not_recorded_for_this_player' : null,
  };

  const mix = rushMixOf(baseline, prior);
  let opponentRatio = null;
  if (mix
    && finite(opponent?.rushing_td_per_game) !== null && finite(opponent?.receiving_td_per_game) !== null
    && finite(leagueAllowed?.rushing_td_per_game) > 0 && finite(leagueAllowed?.receiving_td_per_game) > 0) {
    opponentRatio = mix.mix * (opponent.rushing_td_per_game / leagueAllowed.rushing_td_per_game)
      + (1 - mix.mix) * (opponent.receiving_td_per_game / leagueAllowed.receiving_td_per_game);
  }
  const opponentFactor = damped(opponentRatio, weights?.opponent);
  components.opponent = {
    available: opponentFactor !== null,
    factor: opponentFactor ?? 1,
    ratio: opponentRatio === null ? null : round(opponentRatio, 6),
    rush_mix: mix ? round(mix.mix, 6) : null,
    rush_mix_basis: mix?.basis ?? null,
    opponent_rushing_td_allowed_per_game: finite(opponent?.rushing_td_per_game),
    opponent_receiving_td_allowed_per_game: finite(opponent?.receiving_td_per_game),
    weight: finite(weights?.opponent),
    unavailable_reason: opponentFactor === null ? 'opponent_concession_profile_unavailable' : null,
  };

  const scriptRatio = scriptBucket ? finite(coefficients?.script?.[scriptBucket]?.ratio) : null;
  const scriptFactor = damped(scriptRatio, weights?.script);
  components.game_script = {
    available: scriptFactor !== null,
    factor: scriptFactor ?? 1,
    bucket: scriptBucket ?? null,
    ratio: scriptRatio,
    sample_rows: scriptBucket ? (coefficients?.script?.[scriptBucket]?.rows ?? null) : null,
    weight: finite(weights?.script),
    unavailable_reason: scriptFactor === null
      ? (scriptBucket ? 'game_script_coefficient_below_sample_gate' : 'spread_unavailable') : null,
  };

  const weatherRatio = weatherBucket ? finite(coefficients?.weather?.[weatherBucket]?.ratio) : null;
  const weatherFactor = damped(weatherRatio, weights?.weather);
  components.weather = {
    available: weatherFactor !== null,
    factor: weatherFactor ?? 1,
    bucket: weatherBucket ?? null,
    ratio: weatherRatio,
    sample_rows: weatherBucket ? (coefficients?.weather?.[weatherBucket]?.rows ?? null) : null,
    weight: finite(weights?.weather),
    unavailable_reason: weatherFactor === null
      ? (weatherBucket ? 'weather_coefficient_below_sample_gate' : 'roofed_or_no_forecast') : null,
  };
  components.precipitation = {
    available: false,
    factor: 1,
    unavailable_reason: coefficients?.precipitation?.unavailable_reason
      || 'precipitation_not_populated_in_source',
  };

  const raw = blended.rate
    * components.red_zone_role.factor
    * components.team_environment.factor
    * components.opponent.factor
    * components.game_script.factor
    * components.weather.factor;

  if (!Number.isFinite(raw) || raw < 0) {
    return { lambda: null, unavailable_reason: 'lambda_not_finite', components, base: blended };
  }
  const guard = raw > LAMBDA_MAX;
  return {
    lambda: guard ? null : round(raw, 8),
    unavailable_reason: guard ? 'model_integrity_guard_lambda_out_of_range' : null,
    base: blended,
    components,
    rz_tier: rzTier ?? null,
  };
}

/* The published probability. Calibration is a two-parameter recalibration of
 * the Poisson log-odds fitted on held-out seasons; without it the artefact is
 * incomplete and this returns null rather than an uncalibrated number dressed
 * up as the model's answer. */
export function calibratedProbability(lambda, calibration) {
  /* A null lambda is an unavailable estimate, never a lambda of zero. */
  const value = finite(lambda);
  if (value === null || value < 0) return null;
  const a = finite(calibration?.a);
  const b = finite(calibration?.b);
  if (a === null || b === null) return null;
  const poisson = poissonAtLeastOne(value);
  const clamped = Math.min(1 - 1e-9, Math.max(1e-9, poisson));
  const p = logistic(a + b * logit(clamped));
  if (!(p > 0 && p < 1)) return null;
  return round(p, 6);
}

/* ------------------------------------------------------------ market maths */

export function americanToImpliedProbability(price) {
  const value = finite(price);
  if (value === null || value === 0) return null;
  return value > 0 ? 100 / (value + 100) : Math.abs(value) / (Math.abs(value) + 100);
}

/* Exported so every module in this feature shares one definition of "this
 * number is actually present", rather than each re-deriving it and one of them
 * getting Number(null) wrong. */
export { finite as finiteOrNull };

export function americanToDecimal(price) {
  const value = finite(price);
  if (value === null || value === 0) return null;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

/* A two-way anytime-touchdown quote (Yes and No at the same book) is the only
 * form from which the vig can honestly be removed. Many books post only the
 * Yes; for those the raw implied probability is used and the row says
 * `vig_removed: false`, because pretending a one-sided price is vig-free
 * inflates every edge against it. */
export function yesProbabilityFromQuote({ yesPrice, noPrice }) {
  const yes = americanToImpliedProbability(yesPrice);
  if (yes === null) return null;
  const no = americanToImpliedProbability(noPrice);
  if (no === null) return { probability: round(yes, 6), vig_removed: false, hold_pct: null };
  const total = yes + no;
  if (!(total > 0)) return null;
  return {
    probability: round(yes / total, 6),
    vig_removed: true,
    hold_pct: round((total - 1) * 100, 4),
  };
}

export function median(values) {
  const xs = values.map(finite).filter(v => v !== null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const middle = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[middle] : (xs[middle - 1] + xs[middle]) / 2;
}

/* Consensus across books: the median of each book's own Yes probability, so a
 * single outlier book cannot move the market number the edge is measured
 * against. `vig_removed` is true only when every contributing book gave a
 * two-way price. */
export function consensusYesProbability(bookQuotes) {
  const rows = (Array.isArray(bookQuotes) ? bookQuotes : [])
    .map(quote => ({ book: quote.book, ...(yesProbabilityFromQuote(quote) || {}) }))
    .filter(row => finite(row.probability) !== null);
  if (!rows.length) return null;
  return {
    probability: round(median(rows.map(r => r.probability)), 6),
    books: rows.length,
    vig_removed: rows.every(r => r.vig_removed === true),
    two_way_books: rows.filter(r => r.vig_removed === true).length,
    hold_pct: median(rows.map(r => r.hold_pct).filter(v => v !== null && v !== undefined)),
    disagreement_pp: rows.length > 1
      ? round((Math.max(...rows.map(r => r.probability)) - Math.min(...rows.map(r => r.probability))) * 100, 4)
      : 0,
  };
}

/* The best executable Yes price across books: the longest odds, which is the
 * price a customer would actually take. Never a default, never -110. */
export function bestYesPrice(bookQuotes) {
  let best = null;
  for (const quote of Array.isArray(bookQuotes) ? bookQuotes : []) {
    const decimal = americanToDecimal(quote?.yesPrice);
    if (decimal === null) continue;
    if (!best || decimal > best.decimal) {
      best = { decimal, price: Math.round(Number(quote.yesPrice)), book: quote.book || null, book_key: quote.book_key || null, opposite_price: finite(quote.noPrice) };
    }
  }
  return best;
}

export function expectedValuePct(modelProbability, price) {
  const p = finite(modelProbability);
  const decimal = americanToDecimal(price);
  if (p === null || decimal === null || !(p > 0 && p < 1)) return null;
  return round((p * decimal - 1) * 100, 4);
}

export function round(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}
