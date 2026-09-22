/* PropBetEdge NFL — PBE Touchdown Targets selector.
 *
 * The probability model answers "how likely is this player to score?".
 * This file answers a different question: "which player should PBE publish
 * for this game?" — and it is deliberately a separate file so either can be
 * improved without touching the other.
 *
 * THE PRODUCT RULE
 * Every eligible game ends in exactly one of two states, and never in silence:
 *
 *   PRIMARY TARGET   one player, named, with his probability frozen
 *   MODEL ABSTAIN    a reason code, recorded with the pool it evaluated
 *
 * A game may additionally carry ONE SECONDARY target, which has to clear a
 * strictly higher standard. The primary record is kept separately measurable
 * so the question "if PBE named one scorer in every game, how often was it
 * right?" always has an exact answer, un-inflated by second guesses.
 *
 * SOURCE FAILURE IS NOT ABSTENTION
 * A missing market, an unreachable slate authority or a model that could not
 * be built is `degraded` — a different outcome from `abstained`, reported
 * differently, and excluded from the abstention rate. Turning a broken
 * upstream into "the model had no opinion" is the single most dishonest thing
 * this file could do.
 *
 * WEATHER IS A FEATURE, NOT A VETO
 * There is no rule here that says snow means no pick. Conditions reach the
 * decision only through the probability model. If a game's whole scoring pool
 * falls under the publication floor, the abstention reason names the binding
 * cause from the components that actually moved — it is never asserted.
 */

import {
  MODEL_VERSION, calibratedProbability, isNonPlayerSelection, normalizePlayerName,
  consensusYesProbability, bestYesPrice, expectedValuePct, americanToImpliedProbability, round,
} from './td-kernel.mjs';

export const TD_MARKET = 'player_anytime_td';
export const SELECTOR_VERSION_TAG = 'pbe-td-selector-v1';

/* Defaults. Every one of these is overridden by the promoted selector row's
 * `config`, which is where a governed change belongs; they exist so the engine
 * has a defined shape before the first row is written and so the tests can
 * name a threshold without reaching into the database. */
export const SELECTOR_DEFAULTS = Object.freeze({
  /* A primary target is a real prediction, not a shrug. Below this the model
   * is saying "nobody here is a credible scorer" and it abstains. */
  primary_min_prob: 0.22,
  /* A secondary is optional and must clear a higher bar on BOTH the model's
   * own number and the market it is measured against. */
  secondary_min_prob: 0.30,
  secondary_min_edge: 0.03,
  secondary_min_books: 3,
  /* Publication floors that are about evidence, not about the player. */
  min_books: 2,
  /* Availability: a player his team has reported OUT cannot be the target.
   * DOUBTFUL is treated the same way. QUESTIONABLE is a real risk but not a
   * disqualification, and is recorded on the target. */
  block_statuses: ['out', 'doubtful', 'injured reserve', 'ir', 'suspension', 'physically unable to perform'],
  warn_statuses: ['questionable'],
  /* If this share of the pool's probability mass is blocked by availability,
   * the game is not a model call any more — it is an unresolved roster. */
  availability_abstain_share: 0.6,
  /* Integrity guard. A published probability above this is an input fault. */
  max_publishable_prob: 0.92,
  /* Issuance windows, mirroring the passing-yards lane so the two engines
   * behave the same way in the pregame window. */
  early_bird_min_hours: 12,
  locked_max_hours: 4,
  /* A target already published is replaced only when the newcomer is better by
   * more than noise. Without this the target would churn on every tick. */
  replace_min_prob_gap: 0.025,
});

export function selectorConfig(selector) {
  return { ...SELECTOR_DEFAULTS, ...(selector?.config && typeof selector.config === 'object' ? selector.config : {}) };
}

export const ABSTAIN_REASONS = Object.freeze({
  NO_CREDIBLE_SCORER: 'no_credible_scorer_probability',
  IDENTITY_UNRESOLVED: 'identity_unresolved',
  AVAILABILITY_UNCERTAIN: 'widespread_availability_uncertainty',
  LOW_SCORING_ENVIRONMENT: 'extreme_low_scoring_environment',
  INTEGRITY_GUARD: 'model_integrity_guard',
  EMPTY_POOL: 'no_eligible_scoring_pool',
});

export const DEGRADED_REASONS = Object.freeze({
  NO_MARKET: 'market_snapshot_unavailable',
  STALE_MARKET: 'market_snapshot_stale',
  NO_MODEL: 'model_artefact_unavailable',
  NO_SLATE: 'current_slate_unavailable',
});

/* ---------------------------------------------------------------- identity */

/* A market name is matched to a player only through the model's own name
 * index, which was built with ambiguous names deliberately removed. Two
 * players who share a normalised name resolve to nobody, and the game reports
 * identity_unresolved rather than guessing which one a book meant. */
export function resolveIdentity(model, marketName) {
  const raw = String(marketName || '').trim();
  if (!raw) return { resolved: false, reason: 'empty_name' };
  if (isNonPlayerSelection(raw)) return { resolved: false, reason: 'not_a_player_selection' };
  const key = normalizePlayerName(raw);
  if (!key) return { resolved: false, reason: 'empty_name' };
  if (model?.ambiguous_names?.[key]) {
    return { resolved: false, reason: 'ambiguous_name', candidates: model.ambiguous_names[key].length };
  }
  const gsisId = model?.name_index?.[key];
  if (!gsisId) return { resolved: false, reason: 'not_in_model_player_index' };
  const player = model?.players?.[gsisId];
  if (!player) return { resolved: false, reason: 'player_row_missing' };
  return { resolved: true, gsis_id: gsisId, player };
}

/* Which side of this game the player is on. The model carries his 2026 team
 * and the team of his last recorded game; a live current-season team, when the
 * caller has one, outranks both. A player who cannot be placed on either side
 * of this matchup is not a candidate for it. */
export function resolveTeam({ player, currentTeam, awayTeam, homeTeam }) {
  const candidates = [currentTeam, player?.team_2026, player?.last_team]
    .map(value => String(value || '').toUpperCase())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === awayTeam) return { team: awayTeam, opponent: homeTeam, at_home: false, basis: basisOf(candidate, currentTeam, player) };
    if (candidate === homeTeam) return { team: homeTeam, opponent: awayTeam, at_home: true, basis: basisOf(candidate, currentTeam, player) };
  }
  return null;
}

function basisOf(candidate, currentTeam, player) {
  if (candidate === String(currentTeam || '').toUpperCase()) return 'current_season_authority';
  if (candidate === String(player?.team_2026 || '').toUpperCase()) return 'roster_team_2026';
  return 'last_recorded_game';
}

/* -------------------------------------------------------------- the market */

/* Book-by-book Yes/No pairs for one player, from the flat board quotes the
 * odds snapshot serves. A book that posted only the Yes still contributes; the
 * consensus records that its vig could not be removed. */
export function bookQuotesFor(quotes, playerName) {
  const key = normalizePlayerName(playerName);
  const byBook = new Map();
  for (const quote of Array.isArray(quotes) ? quotes : []) {
    if (String(quote?.market || '') !== TD_MARKET) continue;
    if (normalizePlayerName(quote?.player) !== key) continue;
    const book = String(quote?.book || quote?.book_key || '').trim();
    if (!book) continue;
    const side = String(quote?.direction || quote?.side || '').toUpperCase();
    const price = Number(quote?.price);
    if (!Number.isFinite(price) || price === 0) continue;
    if (!byBook.has(book)) byBook.set(book, { book, book_key: quote?.book_key || null, yesPrice: null, noPrice: null, captured_at: quote?.captured_at || null });
    const entry = byBook.get(book);
    if (side === 'YES') entry.yesPrice = Math.round(price);
    else if (side === 'NO') entry.noPrice = Math.round(price);
  }
  return [...byBook.values()].filter(entry => entry.yesPrice !== null);
}

/* ------------------------------------------------------------- candidates */

/* One scored candidate.
 *
 * `artefact_probability` is the committed model's own calibrated number.
 * `probability` is what PBE publishes: the artefact's number, unless the
 * promoted champion carries a trained override, in which case it is the
 * override's. Both are kept, so a published number is always traceable to the
 * stage that produced it.
 *
 * Neither is ever the market's. `market` is recorded whether it agrees or not,
 * and is used for edge, EV and the qualification gate — never as the
 * probability. */
export function buildCandidate({
  marketName, model, quotes, currentTeam, currentSeason, awayTeam, homeTeam,
  gameContext, availability, scoreLambda, config, probabilityOverride, hoursToKickoff,
}) {
  const identity = resolveIdentity(model, marketName);
  if (!identity.resolved) {
    return { eligible: false, market_name: marketName, reason: `identity_${identity.reason}` };
  }
  const side = resolveTeam({ player: identity.player, currentTeam, awayTeam, homeTeam });
  if (!side) {
    return { eligible: false, market_name: marketName, player_name: identity.player.name, reason: 'team_not_resolved_to_this_game' };
  }

  const scored = scoreLambda({ player: identity.player, side, currentSeason, gameContext });
  const artefactProbability = calibratedProbability(scored?.lambda, model?.calibration);
  if (artefactProbability === null) {
    return {
      eligible: false, market_name: marketName, player_name: identity.player.name,
      reason: scored?.unavailable_reason || 'probability_unavailable',
    };
  }

  const books = bookQuotesFor(quotes, marketName);
  const consensus = consensusYesProbability(books);
  const best = bestYesPrice(books);
  const status = availabilityOf(availability, identity, config);

  /* The override scores the same frozen feature vector the learning loop
   * trains on, so what is published and what is learned from cannot drift.
   * `model_prob` inside that vector is always the artefact's number. */
  const partial = {
    probability: artefactProbability,
    artefact_probability: artefactProbability,
    lambda: scored.lambda,
    model_components: scored.components,
    model_base: scored.base,
    at_home: side.at_home,
    edge: consensus ? round(artefactProbability - consensus.probability, 6) : null,
    ev_pct: best ? expectedValuePct(artefactProbability, best.price) : null,
    books: books.length,
    market: consensus ? { probability: consensus.probability, books: consensus.books, disagreement_pp: consensus.disagreement_pp } : null,
  };
  const overridden = typeof probabilityOverride === 'function'
    ? probabilityOverride(featureVector(partial, { isPrimary: false, hoursToKickoff }))
    : null;
  const probability = overridden === null || overridden === undefined ? artefactProbability : overridden;

  return {
    eligible: true,
    market_name: marketName,
    gsis_id: identity.gsis_id,
    espn_id: identity.player.espn_id || null,
    player_name: identity.player.name,
    position: identity.player.position || null,
    team: side.team,
    opponent: side.opponent,
    at_home: side.at_home,
    team_basis: side.basis,
    probability,
    artefact_probability: artefactProbability,
    probability_source: probability === artefactProbability ? 'committed_artefact' : 'promoted_trained_override',
    lambda: scored.lambda,
    model_components: scored.components,
    model_base: scored.base,
    rz_tier: scored.rz_tier ?? null,
    market: consensus ? {
      probability: consensus.probability,
      books: consensus.books,
      two_way_books: consensus.two_way_books,
      vig_removed: consensus.vig_removed,
      hold_pct: consensus.hold_pct,
      disagreement_pp: consensus.disagreement_pp,
      best_price: best ? best.price : null,
      best_book: best ? best.book : null,
      best_book_key: best ? best.book_key : null,
      opposite_price: best ? best.opposite_price : null,
      best_price_implied: best ? round(americanToImpliedProbability(best.price), 6) : null,
    } : null,
    edge: consensus ? round(probability - consensus.probability, 6) : null,
    ev_pct: best ? expectedValuePct(probability, best.price) : null,
    books: books.length,
    availability: status,
  };
}

function availabilityOf(availability, identity, config) {
  const rows = Array.isArray(availability) ? availability : [];
  const key = normalizePlayerName(identity.player.name);
  const row = rows.find(entry => normalizePlayerName(entry?.player || entry?.name) === key) || null;
  if (!row) {
    return { available: false, status: null, blocked: false, warned: false, unavailable_reason: 'no_reported_status_for_this_player' };
  }
  const status = String(row.status || row.designation || '').toLowerCase().trim();
  return {
    available: true,
    status: status || null,
    detail: row.detail || row.description || null,
    blocked: config.block_statuses.some(blocked => status.includes(blocked)),
    warned: config.warn_statuses.some(warn => status.includes(warn)),
  };
}

/* ----------------------------------------------------------- the decision */

const byRank = (a, b) => b.probability - a.probability
  || (b.edge ?? -1) - (a.edge ?? -1)
  || b.books - a.books
  || (a.player_name < b.player_name ? -1 : a.player_name > b.player_name ? 1 : 0);

/* One game in, one decision out. Never two primaries, never a silent game. */
export function decideGame({ candidates, config, gameContext }) {
  const cfg = { ...SELECTOR_DEFAULTS, ...(config || {}) };
  const all = Array.isArray(candidates) ? candidates : [];
  const eligible = all.filter(candidate => candidate.eligible === true);
  const rejected = all.filter(candidate => candidate.eligible !== true);
  const pool = {
    market_selections: all.length,
    eligible: eligible.length,
    rejected: rejected.length,
    rejected_reasons: tally(rejected.map(candidate => candidate.reason)),
  };

  if (!eligible.length) {
    /* Nothing scoreable. If every rejection was an identity failure, say so —
     * an unresolved roster is a different fact from an empty market. */
    const reasons = pool.rejected_reasons;
    const identityOnly = Object.keys(reasons).length > 0
      && Object.keys(reasons).every(reason => reason.startsWith('identity_'));
    return abstain(identityOnly ? ABSTAIN_REASONS.IDENTITY_UNRESOLVED : ABSTAIN_REASONS.EMPTY_POOL, { pool, gameContext });
  }

  const ranked = eligible.slice().sort(byRank);
  const blocked = ranked.filter(candidate => candidate.availability.blocked === true);
  const open = ranked.filter(candidate => candidate.availability.blocked !== true);
  pool.blocked_by_availability = blocked.length;

  /* Availability abstention is measured on probability mass, not headcount:
   * losing three deep reserves is nothing, losing the two players who carry
   * the pool's scoring is an unresolved roster. */
  const totalMass = ranked.reduce((sum, candidate) => sum + candidate.probability, 0);
  const blockedMass = blocked.reduce((sum, candidate) => sum + candidate.probability, 0);
  pool.blocked_probability_share = totalMass > 0 ? round(blockedMass / totalMass, 6) : 0;
  if (blocked.length && totalMass > 0 && blockedMass / totalMass >= cfg.availability_abstain_share) {
    return abstain(ABSTAIN_REASONS.AVAILABILITY_UNCERTAIN, { pool, gameContext, top: ranked[0] });
  }
  if (!open.length) {
    return abstain(ABSTAIN_REASONS.AVAILABILITY_UNCERTAIN, { pool, gameContext, top: ranked[0] });
  }

  const top = open[0];
  pool.top_probability = top.probability;
  pool.pool_probability_mass = round(totalMass, 6);

  if (top.probability > cfg.max_publishable_prob) {
    return abstain(ABSTAIN_REASONS.INTEGRITY_GUARD, { pool, gameContext, top });
  }
  if (top.probability < cfg.primary_min_prob) {
    /* The floor is the same floor for every game. Which fact pushed this
     * game's best candidate under it is read off the components that actually
     * moved, never asserted. */
    return abstain(bindingLowScoreReason(top, cfg), { pool, gameContext, top, floor: cfg.primary_min_prob });
  }
  if (top.books < cfg.min_books) {
    /* Not a model abstention: the market evidence this target would be
     * measured against is too thin to publish against. */
    return degraded(DEGRADED_REASONS.NO_MARKET, { pool, gameContext, top, detail: { books: top.books, required: cfg.min_books } });
  }

  const secondary = open.slice(1).find(candidate => candidate.probability >= cfg.secondary_min_prob
    && candidate.edge !== null && candidate.edge >= cfg.secondary_min_edge
    && candidate.books >= cfg.secondary_min_books
    && candidate.probability <= cfg.max_publishable_prob) || null;

  return {
    outcome: 'target_issued',
    primary: top,
    secondary,
    pool,
    game_context: gameContext ?? null,
    floor: cfg.primary_min_prob,
    ranked_preview: ranked.slice(0, 8).map(previewOf),
  };
}

/* The pool's best candidate fell short. Name the cause from the components
 * that are actually pulling his lambda down, and only when one of them is
 * doing enough of the work to be called the cause. */
function bindingLowScoreReason(top, cfg) {
  const script = top?.model_components?.game_script;
  if (script?.available === true && Number(script.factor) <= 0.85) return ABSTAIN_REASONS.LOW_SCORING_ENVIRONMENT;
  const team = top?.model_components?.team_environment;
  if (team?.available === true && Number(team.factor) <= 0.85) return ABSTAIN_REASONS.LOW_SCORING_ENVIRONMENT;
  return ABSTAIN_REASONS.NO_CREDIBLE_SCORER;
}

function previewOf(candidate) {
  return {
    player_name: candidate.player_name,
    team: candidate.team,
    position: candidate.position,
    probability: candidate.probability,
    market_probability: candidate.market?.probability ?? null,
    edge: candidate.edge,
    books: candidate.books,
    availability_status: candidate.availability?.status ?? null,
    blocked: candidate.availability?.blocked === true,
  };
}

function abstain(reason, { pool, gameContext, top = null, floor = null }) {
  return {
    outcome: 'abstained',
    reason,
    primary: null,
    secondary: null,
    pool,
    floor,
    top_candidate: top ? previewOf(top) : null,
    game_context: gameContext ?? null,
  };
}

function degraded(reason, { pool, gameContext, top = null, detail = null }) {
  return {
    outcome: 'degraded',
    reason,
    primary: null,
    secondary: null,
    pool,
    detail,
    top_candidate: top ? previewOf(top) : null,
    game_context: gameContext ?? null,
  };
}

function tally(values) {
  const out = {};
  for (const value of values) {
    const key = String(value || 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/* ------------------------------------------------------ issuance decision */

export function issuancePhase(kickoffTs, nowMs, config) {
  const cfg = { ...SELECTOR_DEFAULTS, ...(config || {}) };
  const kickoff = Date.parse(kickoffTs);
  if (!Number.isFinite(kickoff)) return null;
  const hours = (kickoff - nowMs) / 3600000;
  if (hours < 0) return null;
  /* Touchdown Targets publishes across the whole pregame window rather than in
   * two separate bands: the product promise is a target for every game, and a
   * gap in the middle of Sunday morning would break it. The phase label is
   * kept so a decision's place in the window stays on the record. */
  return { phase: hours <= cfg.locked_max_hours ? 'locked' : 'early_bird', hours_to_kickoff: round(hours, 4) };
}

/* Whether an already-open target should stay, be replaced, or be withdrawn.
 *
 * Replacement is auditable and deliberately sticky: a new name takes over only
 * when the model prefers him by more than `replace_min_prob_gap`, or when the
 * incumbent has become unpublishable (reported out, or no longer priced). A
 * target is never changed after kickoff — that is enforced by the caller's
 * kickoff guard and again by the database. */
export function reconcileDecision({ open, decision, config }) {
  const cfg = { ...SELECTOR_DEFAULTS, ...(config || {}) };
  if (!open) {
    return decision.outcome === 'target_issued'
      ? { action: 'issue' }
      : { action: 'record_only', outcome: decision.outcome, reason: decision.reason };
  }
  if (decision.outcome !== 'target_issued') {
    /* The model no longer has a publishable target for a game it has already
     * spoken on. The published target is withdrawn and the withdrawal is on
     * the record; the original issuance stays exactly as it was issued. */
    return { action: 'withdraw', reason: decision.reason || 'no_publishable_target' };
  }
  const incumbentName = String(open.player_key || '');
  const challengerName = normalizePlayerName(decision.primary.player_name);
  if (incumbentName === challengerName) {
    return { action: 'keep', reason: 'same_player_still_ranked_first' };
  }
  const incumbent = decision.pool && Array.isArray(decision.ranked_preview)
    ? decision.ranked_preview.find(row => normalizePlayerName(row.player_name) === incumbentName) || null
    : null;
  if (incumbent && incumbent.blocked !== true
    && decision.primary.probability - incumbent.probability < cfg.replace_min_prob_gap) {
    return { action: 'keep', reason: 'challenger_inside_replacement_threshold' };
  }
  return {
    action: 'replace',
    reason: incumbent
      ? (incumbent.blocked ? 'incumbent_reported_unavailable' : 'challenger_clears_replacement_threshold')
      : 'incumbent_no_longer_in_eligible_pool',
    from_probability: incumbent?.probability ?? null,
    to_probability: decision.primary.probability,
  };
}

/* ---------------------------------------------------- the learning vector */

/* The feature snapshot that becomes a supervised observation once the game is
 * final. Decision-time values only: nothing here may be recomputed later, and
 * the grader never adds to it. Ordered so a challenger can rely on the shape.
 *
 * Market features are present and are NOT consumed by the champion's
 * probability. They are here precisely so a future challenger can learn
 * whether they help, out of sample, under the promotion gate. */
export const TD_FEATURE_ORDER = Object.freeze([
  'model_prob',
  'lambda',
  'blended_rate',
  'history_weighted_games',
  'history_rate',
  'current_season_rate',
  'current_season_games',
  'prior_rate',
  'rz_opportunities_per_game',
  'rz_td_conversion',
  'rz_role_factor',
  'team_environment_factor',
  'opponent_factor',
  'game_script_factor',
  'weather_factor',
  'market_prob',
  'market_books',
  'market_disagreement_pp',
  'edge',
  'ev_pct',
  'hours_to_kickoff',
  'is_home',
  'is_primary',
]);

export function featureVector(candidate, { isPrimary, hoursToKickoff }) {
  const components = candidate?.model_components || {};
  const base = candidate?.model_base || {};
  /* Missing is not zero. Number(null) is 0 and finite, so a tolerant helper
   * here would write 0 into the frozen vector for a feature that was never
   * observed — and the learning loop would then train on it as an observation
   * of zero. See td-kernel.mjs. */
  const numberOrNull = value => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  return {
    /* Always the committed artefact's number, never the published one. A
     * promoted override is a function OF this feature; letting it overwrite the
     * feature would change what the training data means the moment an override
     * is promoted. */
    model_prob: numberOrNull(candidate?.artefact_probability ?? candidate?.probability),
    lambda: numberOrNull(candidate?.lambda),
    blended_rate: numberOrNull(base?.rate),
    history_weighted_games: numberOrNull(base?.history?.weight),
    history_rate: numberOrNull(base?.history?.rate),
    current_season_rate: base?.current_season?.available === true ? numberOrNull(base.current_season.rate) : null,
    current_season_games: base?.current_season?.available === true ? numberOrNull(base.current_season.weight) : null,
    prior_rate: numberOrNull(base?.prior?.rate),
    rz_opportunities_per_game: numberOrNull(components?.red_zone_role?.player_rz_opportunities_per_game),
    rz_td_conversion: numberOrNull(components?.red_zone_role?.rz_td_conversion),
    rz_role_factor: components?.red_zone_role?.available === true ? numberOrNull(components.red_zone_role.factor) : null,
    team_environment_factor: components?.team_environment?.available === true ? numberOrNull(components.team_environment.factor) : null,
    opponent_factor: components?.opponent?.available === true ? numberOrNull(components.opponent.factor) : null,
    game_script_factor: components?.game_script?.available === true ? numberOrNull(components.game_script.factor) : null,
    weather_factor: components?.weather?.available === true ? numberOrNull(components.weather.factor) : null,
    market_prob: numberOrNull(candidate?.market?.probability),
    market_books: numberOrNull(candidate?.market?.books),
    market_disagreement_pp: numberOrNull(candidate?.market?.disagreement_pp),
    edge: numberOrNull(candidate?.edge),
    ev_pct: numberOrNull(candidate?.ev_pct),
    hours_to_kickoff: numberOrNull(hoursToKickoff),
    is_home: candidate?.at_home === true ? 1 : 0,
    is_primary: isPrimary ? 1 : 0,
  };
}

/* The model snapshot frozen on the issued row. Larger than the learning
 * vector on purpose: the vector is what a challenger trains on, this is the
 * historical record of what the algorithm knew, and it is what the audit and
 * the `Why this target?` panel are rendered from. */
export function issuanceSnapshot({ candidate, decision, model, selector, event, game, phase, rank, sources }) {
  return {
    model: {
      version: MODEL_VERSION,
      selector: SELECTOR_VERSION_TAG,
      built_at: model?.built_at ?? null,
      label: model?.label ?? null,
      calibration: model?.calibration ? { a: model.calibration.a, b: model.calibration.b, holdout: model.calibration.holdout } : null,
      weights: model?.weights ?? null,
    },
    probability: {
      published: candidate.probability,
      source: candidate.probability_source ?? 'committed_artefact',
      artefact_calibrated: candidate.artefact_probability ?? candidate.probability,
      lambda: candidate.lambda,
      base: candidate.model_base,
      components: candidate.model_components,
      rz_tier: candidate.rz_tier,
    },
    features: featureVector(candidate, { isPrimary: rank === 'primary', hoursToKickoff: phase?.hours_to_kickoff }),
    market: candidate.market,
    availability: candidate.availability,
    player: {
      gsis_id: candidate.gsis_id,
      espn_id: candidate.espn_id,
      name: candidate.player_name,
      position: candidate.position,
      team: candidate.team,
      opponent: candidate.opponent,
      at_home: candidate.at_home,
      team_basis: candidate.team_basis,
    },
    pool: decision?.pool ?? null,
    ranked_preview: decision?.ranked_preview ?? null,
    event: {
      event_id: event?.id ?? null,
      away_team: event?.away_team ?? null,
      home_team: event?.home_team ?? null,
      commence_time: event?.commence_time ?? null,
      game_id: game?.game_id ?? null,
      espn_id: game?.espn_id ?? null,
      season: game?.season ?? null,
      week: game?.week ?? null,
      kickoff_ts: game?.kickoff_ts ?? null,
    },
    game_context: decision?.game_context ?? null,
    phase,
    selector_config: publicConfig(selector),
    sources: sources ?? null,
    contract: {
      label: model?.label ?? null,
      grading: 'PBE target result is decided from the official final box score: at least one rushing or '
        + 'receiving touchdown credited to this player. Return and defensive touchdowns are observed and '
        + 'recorded separately and are not part of the PBE result.',
      market_not_an_input: 'the de-vigged market probability recorded here is used for edge, EV and the '
        + 'qualification gate; it is not an input to the PBE probability',
    },
  };
}

/* What of the selector's configuration is safe to publish: thresholds, not a
 * trained challenger's coefficients. */
export function publicConfig(selector) {
  const cfg = selectorConfig(selector);
  return {
    primary_min_prob: cfg.primary_min_prob,
    secondary_min_prob: cfg.secondary_min_prob,
    secondary_min_edge: cfg.secondary_min_edge,
    min_books: cfg.min_books,
    max_publishable_prob: cfg.max_publishable_prob,
    availability_abstain_share: cfg.availability_abstain_share,
    replace_min_prob_gap: cfg.replace_min_prob_gap,
  };
}

/* ------------------------------------------------------ driver explanations */

/* Human-readable drivers for the target card, derived from the values that
 * actually moved this lambda. A driver is offered only when its component was
 * available AND moved the number by more than a rounding artefact, so the card
 * can never show a chip for a feature the champion does not use — the fitted
 * weight for the team and opponent terms is currently zero, and no chip for
 * either will ever appear while it stays there. */
const DRIVER_FLOOR = 0.02;

export function driversFor(candidate) {
  const out = [];
  const components = candidate?.model_components || {};
  const push = (key, label, factor, detail) => {
    if (!Number.isFinite(factor) || Math.abs(factor - 1) < DRIVER_FLOOR) return;
    out.push({ key, label, direction: factor > 1 ? 'up' : 'down', factor: round(factor, 4), detail });
  };

  const role = components.red_zone_role;
  if (role?.available === true) {
    push('red_zone_role', role.factor > 1 ? 'RED-ZONE ROLE' : 'LIGHT RED-ZONE ROLE', Number(role.factor),
      role.player_rz_opportunities_per_game === null ? null
        : `${round(role.player_rz_opportunities_per_game, 2)} red-zone opportunities per game vs ${round(role.position_rz_opportunities_per_game, 2)} for the position`);
  }
  const script = components.game_script;
  if (script?.available === true) {
    push('game_script', script.factor > 1 ? 'FAVOURABLE SCRIPT' : 'AGAINST THE SCRIPT', Number(script.factor),
      `${scriptLabel(script.bucket)} · measured on ${script.sample_rows} player-games`);
  }
  const team = components.team_environment;
  if (team?.available === true) {
    push('team_environment', team.factor > 1 ? 'HIGH TEAM TD ENVIRONMENT' : 'LOW TEAM TD ENVIRONMENT', Number(team.factor),
      team.team_offensive_td_per_game === null ? null
        : `${round(team.team_offensive_td_per_game, 2)} offensive touchdowns per game vs ${round(team.league_offensive_td_per_game, 2)} league`);
  }
  const opponent = components.opponent;
  if (opponent?.available === true) {
    push('opponent', opponent.factor > 1 ? 'SOFT TD MATCHUP' : 'HARD TD MATCHUP', Number(opponent.factor),
      `rushing ${round(opponent.opponent_rushing_td_allowed_per_game, 2)} / receiving ${round(opponent.opponent_receiving_td_allowed_per_game, 2)} touchdowns allowed per game`);
  }
  const weather = components.weather;
  if (weather?.available === true) {
    push('weather', weather.factor > 1 ? 'CONDITIONS HELP' : 'CONDITIONS SUPPRESS', Number(weather.factor),
      `${weatherLabel(weather.bucket)} · measured on ${weather.sample_rows} player-games`);
  }

  /* Market disagreement is not a model driver — it is a fact about the price
   * this target was measured against, and it is labelled as one. */
  const edge = Number(candidate?.edge);
  if (Number.isFinite(edge) && Math.abs(edge) >= 0.03 && candidate?.market) {
    out.push({
      key: 'market',
      label: edge > 0 ? 'MARKET UNDERRATES' : 'MARKET OVERRATES',
      direction: edge > 0 ? 'up' : 'down',
      factor: null,
      detail: `PBE ${(candidate.probability * 100).toFixed(1)}% vs market ${(candidate.market.probability * 100).toFixed(1)}% `
        + `over ${candidate.market.books} book${candidate.market.books === 1 ? '' : 's'}`
        + `${candidate.market.vig_removed ? '' : ' (one-sided prices; vig not removed)'}`,
    });
  }
  if (candidate?.availability?.warned === true) {
    out.push({ key: 'availability', label: 'QUESTIONABLE', direction: 'down', factor: null, detail: candidate.availability.detail || 'listed questionable on the reported availability board' });
  }
  return out;
}

function scriptLabel(bucket) {
  return ({
    heavy_favourite: 'favoured by seven or more',
    favourite: 'favoured by three to seven',
    pickem: 'within three points',
    underdog: 'underdog by three to seven',
    heavy_underdog: 'underdog by seven or more',
  }[bucket] || bucket || 'spread unavailable');
}

function weatherLabel(bucket) {
  return ({
    wind_15_plus: 'wind at or above 15 mph',
    cold_32_or_below: 'temperature at or below freezing',
    benign_outdoor: 'open air, no wind or cold flag',
  }[bucket] || bucket || 'roofed or no forecast');
}

/* -------------------------------------------------------- abstention copy */

export const ABSTAIN_COPY = Object.freeze({
  [ABSTAIN_REASONS.NO_CREDIBLE_SCORER]: 'No eligible player reached the publication threshold for a touchdown target.',
  [ABSTAIN_REASONS.IDENTITY_UNRESOLVED]: 'The scoring pool for this game could not be resolved to known players safely.',
  [ABSTAIN_REASONS.AVAILABILITY_UNCERTAIN]: 'Reported availability removed too much of this game’s scoring pool to publish a target.',
  [ABSTAIN_REASONS.LOW_SCORING_ENVIRONMENT]: 'The expected scoring environment held every eligible player below the publication threshold.',
  [ABSTAIN_REASONS.INTEGRITY_GUARD]: 'A model integrity guard fired on this game and no target was published.',
  [ABSTAIN_REASONS.EMPTY_POOL]: 'No eligible scoring pool was available for this game.',
});

export const DEGRADED_COPY = Object.freeze({
  [DEGRADED_REASONS.NO_MARKET]: 'The anytime-touchdown market for this game was not available to measure a target against.',
  [DEGRADED_REASONS.STALE_MARKET]: 'The anytime-touchdown market snapshot for this game was too old to decide from.',
  [DEGRADED_REASONS.NO_MODEL]: 'The model artefact was unavailable for this game.',
  [DEGRADED_REASONS.NO_SLATE]: 'The current-slate authority did not answer for this game.',
});
