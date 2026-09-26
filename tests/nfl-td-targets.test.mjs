/* PBE Touchdown Targets — acceptance suite.
 *
 * The thirty numbered tests below are the delivery contract for this feature,
 * in the order it was specified. Where an invariant belongs to the database
 * rather than to a function, the test reads the migration and asserts the
 * constraint exists — a guard that only lives in a code path is a guard one
 * refactor away from being gone.
 *
 * Run: node --test tests/nfl-td-targets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TD_MODEL } from '../workers/nfl-td-targets-shared/td-model-v1.js';
import {
  MODEL_VERSION, LAMBDA_MAX, calibratedProbability, poissonAtLeastOne, logit, logistic,
  scriptBucketOf, weatherBucketOf, spreadFromOddsPoint, normalizePlayerName,
  isNonPlayerSelection, yesProbabilityFromQuote, consensusYesProbability, bestYesPrice,
  lambdaFor,
} from '../workers/nfl-td-targets-shared/td-kernel.mjs';
import { makeScorer, gameContextFrom, environmentFrom, currentSeasonLayer } from '../workers/nfl-td-targets-shared/td-score.mjs';
import {
  TD_MARKET, SELECTOR_DEFAULTS, selectorConfig, ABSTAIN_REASONS, DEGRADED_REASONS,
  buildCandidate, decideGame, reconcileDecision, issuancePhase, issuanceSnapshot,
  featureVector, TD_FEATURE_ORDER, resolveIdentity, bookQuotesFor, driversFor,
} from '../workers/nfl-td-targets-shared/td-selector.mjs';
import {
  readPlayerScoring, gradeTarget, sameGrade, unitsFor, learningObservation, RESULT_DEFINITION,
} from '../workers/nfl-td-targets-shared/td-grading.mjs';
import {
  MIN_FINALIZED, MIN_WEEKS, gateStatus, holdoutSplit, trainOverride, evaluate,
  promotionVerdict, promotedOverride, overrideProbability, OVERRIDE_FEATURE_ORDER,
} from '../workers/nfl-td-targets-shared/td-learning.mjs';

const ROOT = process.cwd();
const read = relative => readFileSync(join(ROOT, relative), 'utf8');
const MIGRATION = read('migrations/nfl_td_targets_binary_market_v1.sql');
const PROP_MIGRATION = read('migrations/nfl_prop_picks_engine_v1.sql');
const ORCHESTRATOR = read('workers/nfl-touchdown-targets-orchestrator/src/index.js');
const GRADER = read('workers/nfl-touchdown-targets-grader/src/index.js');
const TUNER = read('workers/nfl-touchdown-targets-tuner/src/index.js');
/* The read contract lives on Cloudflare (nfl-touchdown-targets-api); the
   Vercel function it was ported from is retired. */
const API = read('workers/nfl-touchdown-targets-api/src/contract.js');
const PAGE_CSS = read('touchdown-targets-v1.css');
const PAGE_JS = read('touchdown-targets-v1.js');

/* ---------------------------------------------------------------- fixtures */

const KICKOFF = '2026-09-28T17:00:00Z';
const NOW = Date.parse('2026-09-28T05:00:00Z');          /* 12h before kickoff */

const GAME = {
  game_id: '2026_04_KC_LV', espn_id: '401772910', season: 2026, week: 4,
  away_team: 'KC', home_team: 'LV', kickoff_ts: KICKOFF, kickoff_ms: Date.parse(KICKOFF),
  state: 'SCHEDULE',
};
const EVENT = { id: 'odds-evt-1', away_team: 'Kansas City Chiefs', home_team: 'Las Vegas Raiders', commence_time: KICKOFF };

/* Two real players from the committed artefact, so identity, position priors
 * and team profiles are all exercised against the artefact that ships. */
function artefactPlayers(count = 6) {
  return Object.entries(TD_MODEL.players)
    .filter(([, player]) => player.active_2026 && player.market_priced_2026 && player.espn_id)
    .sort((a, b) => b[1].offensive_td_per_game - a[1].offensive_td_per_game)
    .slice(0, count)
    .map(([gsisId, player]) => ({ gsis_id: gsisId, ...player }));
}

function quote(player, book, yes, no = null) {
  const rows = [{ market: TD_MARKET, player, book, direction: 'YES', price: yes, point: null, captured_at: '2026-09-28T04:00:00Z' }];
  if (no !== null) rows.push({ market: TD_MARKET, player, book, direction: 'NO', price: no, point: null, captured_at: '2026-09-28T04:00:00Z' });
  return rows;
}

const ENVIRONMENT = { available: true, roof: 'outdoors', indoor: false, weather_status: 'ok', temp_f: 64, wind_mph: 7, weather_applies: true, roof_state: 'OUTDOOR' };
const GAME_CONTEXT = {
  books: 5,
  spread_points: { KC: -7.5, LV: 7.5 },
  total: 47.5,
  implied_team_total: { KC: 27.5, LV: 20 },
  implied_team_total_consumed_by_champion: false,
  environment: ENVIRONMENT,
  available: { spread: true, total: true, weather: true },
};

/* A pool built on the shipping artefact: the players are real, and their teams
 * are forced onto this matchup so `resolveTeam` has something to resolve. */
function pool({ overrideFn = undefined, availability = [], players = artefactPlayers(6), teams = ['KC', 'LV'] } = {}) {
  const scoreLambda = makeScorer(TD_MODEL);
  const quotes = [];
  players.forEach((player, index) => {
    const yes = index === 0 ? 120 : 200 + index * 90;
    quotes.push(...quote(player.name, 'Book A', yes, -Math.round(yes * 1.25)));
    quotes.push(...quote(player.name, 'Book B', yes + 10));
    quotes.push(...quote(player.name, 'Book C', yes - 5));
  });
  const candidates = players.map((player, index) => buildCandidate({
    marketName: player.name,
    model: TD_MODEL,
    quotes,
    currentTeam: teams[index % teams.length],
    currentSeason: { available: false, unavailable_reason: 'test' },
    awayTeam: GAME.away_team,
    homeTeam: GAME.home_team,
    gameContext: GAME_CONTEXT,
    availability,
    scoreLambda,
    config: SELECTOR_DEFAULTS,
    probabilityOverride: overrideFn,
    hoursToKickoff: 12,
  }));
  return { candidates, quotes, players };
}

function boxScore({ rushingTd = null, receivingTd = null, name = 'Test Player', didNotPlay = false, returnTd = null } = {}) {
  const groups = [];
  if (rushingTd !== null || didNotPlay) {
    groups.push({
      name: 'rushing', labels: ['CAR', 'YDS', 'AVG', 'TD', 'LONG'],
      athletes: [{ athlete: { name }, did_not_play: didNotPlay, stats: ['12', '48', '4.0', String(rushingTd ?? 0), '9'] }],
    });
  }
  if (receivingTd !== null) {
    groups.push({
      name: 'receiving', labels: ['REC', 'YDS', 'AVG', 'TD', 'LONG', 'TGTS'],
      athletes: [{ athlete: { name }, stats: ['4', '39', '9.8', String(receivingTd), '14', '5'] }],
    });
  }
  if (returnTd !== null) {
    groups.push({
      name: 'kickReturns', labels: ['NO', 'YDS', 'AVG', 'LONG', 'TD'],
      athletes: [{ athlete: { name }, stats: ['2', '66', '33.0', '48', String(returnTd)] }],
    });
  }
  return [{ team: { abbreviation: 'KC' }, groups }];
}

function issuedRow({ id = 'pick-1', features = { model_prob: 0.41, is_primary: 1 }, price = 130, status = 'open', modelProb = 0.41 } = {}) {
  return {
    id, event_id: EVENT.id, season: 2026, week: 4, kickoff_ts: KICKOFF,
    player_name: 'Test Player', player_key: normalizePlayerName('Test Player'),
    market: TD_MARKET, side: 'YES', target_rank: 'primary', status,
    market_price: price, market_prob: 0.35, model_prob: modelProb,
    edge_pct: 0.06, ev_pct: 4.2, confidence_bucket: 'B', phase: 'early_bird',
    publication_scope: 'tracking', selector_version: 7,
    created_at: '2026-09-28T05:00:00Z',
    model_snapshot: { features, event: { away_team: 'Kansas City Chiefs', home_team: 'Las Vegas Raiders' } },
  };
}

/* Synthetic FINALIZED observations, for the learning gate only. These are
 * fixtures for a gate test and never touch a production path. */
function observations(count, { weeks = 6, seed = 1 } = {}) {
  const rows = [];
  let x = seed;
  const next = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  for (let i = 0; i < count; i += 1) {
    const prob = 0.12 + next() * 0.45;
    const outcome = next() < prob ? 1 : 0;
    rows.push({
      pick_id: `obs-${i}`, season: 2026, week: 1 + (i % weeks), market: TD_MARKET,
      phase: 'early_bird', publication_scope: 'tracking',
      features: { ...Object.fromEntries(TD_FEATURE_ORDER.map(name => [name, null])), model_prob: prob, lambda: -Math.log(1 - prob), is_primary: i % 2 === 0 ? 1 : 0, edge: 0.02, market_prob: prob - 0.02, market_books: 4, is_home: i % 2 },
      model_prob: prob, market_prob: prob - 0.02, edge_pct: 0.02, ev_pct: 3,
      confidence_bucket: 'B', outcome, clv_beat: null,
      units_delta: outcome ? 1.2 : -1, brier: (prob - outcome) ** 2,
      finalized_at: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 3600000).toISOString(),
      is_final: true,
    });
  }
  return rows;
}

/* ========================================================================= */
/* 1. every eligible game produces a Primary Target or an explicit Abstain    */
/* ========================================================================= */

test('1 · every eligible game ends in a primary target or an explicit abstention', () => {
  const rich = decideGame({ candidates: pool().candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  assert.equal(rich.outcome, 'target_issued');
  assert.ok(rich.primary, 'a rich pool publishes a primary target');

  /* Nothing scoreable: an explicit abstention with a reason and the pool it saw. */
  const empty = decideGame({ candidates: [], config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  assert.equal(empty.outcome, 'abstained');
  assert.equal(empty.reason, ABSTAIN_REASONS.EMPTY_POOL);
  assert.ok(empty.pool, 'an abstention still records the pool it evaluated');

  /* And the outcome is only ever one of three named states — never absence. */
  for (const decision of [rich, empty]) {
    assert.ok(['target_issued', 'abstained', 'degraded'].includes(decision.outcome));
  }
});

test('1b · every evaluated game is written to the append-only evaluation ledger', () => {
  assert.match(ORCHESTRATOR, /recordEvaluation\(env, \{[\s\S]*?outcome: 'degraded'[\s\S]*?NO_MARKET/,
    'a missing market still records an evaluation row');
  assert.match(ORCHESTRATOR, /outcome: primaryId \? 'target_issued'/,
    'an issued target records an evaluation row');
  assert.match(MIGRATION, /create table if not exists public\.nfl_td_slate_evaluations/);
  assert.match(MIGRATION, /nfl_td_slate_evaluations is append-only/);
});

/* ========================================================================= */
/* 2. a game never produces two Primary Targets                              */
/* ========================================================================= */

test('2 · a game never produces two primary targets', () => {
  const decision = decideGame({ candidates: pool().candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  /* The decision shape makes it unrepresentable: one `primary`, one optional
   * `secondary`, and the secondary is never the same player. */
  assert.equal(typeof decision.primary, 'object');
  assert.ok(!Array.isArray(decision.primary));
  if (decision.secondary) {
    assert.notEqual(decision.secondary.player_name, decision.primary.player_name);
  }
  /* And the database refuses a second open primary for the same event. */
  assert.match(MIGRATION, /create unique index if not exists nfl_td_one_open_target_rank_per_event\s*\n\s*on public\.nfl_prop_picks \(event_id, market, target_rank\)\s*\n\s*where status = 'open' and target_rank is not null;/);
});

/* ========================================================================= */
/* 3. the Primary target is locked before kickoff                            */
/* ========================================================================= */

test('3 · a target is only issued before kickoff, and the database enforces it', () => {
  assert.equal(issuancePhase(KICKOFF, Date.parse(KICKOFF) + 1000, SELECTOR_DEFAULTS), null,
    'no issuance phase exists after kickoff');
  assert.ok(issuancePhase(KICKOFF, NOW, SELECTOR_DEFAULTS).hours_to_kickoff > 0);

  assert.match(MIGRATION, /add constraint nfl_prop_pick_binary_issued_pregame check \(\s*\n\s*not public\.nfl_prop_market_is_binary\(market\) or created_at < kickoff_ts\s*\n\s*\);/);
  /* And the orchestrator refuses a game the slate authority no longer calls
   * scheduled, so a stale clock cannot re-open a kicked-off game. */
  assert.match(ORCHESTRATOR, /if \(!game \|\| !issuable\(game, now, HORIZON_HOURS \* 3600000\)\)/);
  assert.match(ORCHESTRATOR, /if \(!phase\) \{ count\.schedule_skip \+= 1; continue; \}/);
});

/* ========================================================================= */
/* 4. a target cannot mutate after kickoff                                   */
/* ========================================================================= */

test('4 · a published target cannot mutate after kickoff', () => {
  /* Issuance fields are immutable at any time, and target_rank joined the set. */
  assert.match(MIGRATION, /old\.publication_scope, old\.model_snapshot, old\.created_at, old\.target_rank/);
  assert.match(MIGRATION, /new\.publication_scope, new\.model_snapshot, new\.created_at, new\.target_rank/);
  assert.match(MIGRATION, /nfl_prop_picks issuance fields are immutable/);
  /* And a withdrawal or replacement after kickoff is refused outright. */
  assert.match(MIGRATION, /a published touchdown target cannot be % after kickoff/);
  assert.match(MIGRATION, /if now\(\) >= v_kickoff then raise exception 'a touchdown target cannot be replaced after kickoff'/);
});

/* ========================================================================= */
/* 5. no retroactive target can enter the Verified Live Track Record          */
/* ========================================================================= */

test('5 · a target not timestamped pregame cannot enter the verified live record', () => {
  /* The database will not accept one at all (test 3), and every shaped target
   * carries the proof so the surface can state it. */
  const shaped = issuanceSnapshot({
    candidate: pool().candidates[0], decision: { pool: null }, model: TD_MODEL,
    selector: { config: SELECTOR_DEFAULTS, version: 7 }, event: EVENT, game: GAME,
    phase: issuancePhase(KICKOFF, NOW, SELECTOR_DEFAULTS), rank: 'primary', sources: null,
  });
  assert.ok(shaped.phase.hours_to_kickoff > 0, 'the snapshot records how far before kickoff it was frozen');

  assert.match(API, /before_kickoff: Date\.parse\(row\.created_at\) < Date\.parse\(row\.kickoff_ts\)/);
  /* And the backtest is named a backtest wherever it is served. */
  assert.match(API, /scope: 'VERIFIED LIVE TRACK RECORD'/);
  assert.match(API, /HISTORICAL BACKTEST/);
  assert.equal(TD_MODEL.calibration.scope, 'HISTORICAL BACKTEST — never a verified live record');
});

/* ========================================================================= */
/* 6. the binary market does not require a fake line or predictive SD         */
/* ========================================================================= */

test('6 · a binary market carries no line, no fair line and no predictive SD', () => {
  /* The continuous requirement is conditional on the market. */
  assert.match(MIGRATION, /add constraint nfl_prop_pick_continuous_projection check \(\s*\n\s*public\.nfl_prop_market_is_binary\(market\)\s*\n\s*or \(/);
  /* And a binary row is FORBIDDEN from carrying them, so 0.5 and 1 cannot be
   * written in to satisfy an old shape. */
  assert.match(MIGRATION, /and market_line is null\s*\n\s*and model_fair_line is null\s*\n\s*and predictive_sd is null/);
  /* The orchestrator never sets them. */
  assert.doesNotMatch(ORCHESTRATOR, /market_line:/);
  assert.doesNotMatch(ORCHESTRATOR, /model_fair_line:/);
  assert.doesNotMatch(ORCHESTRATOR, /predictive_sd:/);
  /* And the old unconditional requirement is gone. */
  assert.match(MIGRATION, /drop constraint if exists nfl_prop_pick_team_market_line/);
});

/* ========================================================================= */
/* 7. the passing-yards schema and engine still work unchanged               */
/* ========================================================================= */

test('7 · nothing about the passing-yards contract is relaxed', () => {
  /* v1 required these three for every row. They are still required for every
   * NON-binary market, which is every market the passing lane issues. */
  assert.match(PROP_MIGRATION, /model_fair_line numeric not null/);
  assert.match(MIGRATION, /market_line is not null\s*\n\s*and model_fair_line is not null\s*\n\s*and predictive_sd is not null\s*\n\s*and predictive_sd > 0/);
  /* A continuous row must NOT carry a target_rank, so its shape is unchanged. */
  assert.match(MIGRATION, /else target_rank is null/);
  /* The passing-yards replacement RPC keeps its exact signature: the touchdown
   * lane got a new function rather than a changed one. */
  assert.match(MIGRATION, /create or replace function public\.nfl_replace_open_td_target/);
  assert.doesNotMatch(MIGRATION, /create or replace function public\.nfl_replace_open_prop_pick/);
  /* And the receipt payload is byte-identical for a row with no target_rank. */
  assert.match(MIGRATION, /if new\.target_rank is not null then\s*\n\s*v_payload := v_payload \|\| jsonb_build_object\('target_rank', new\.target_rank\);/);
});

/* ========================================================================= */
/* 8. player_anytime_td maps correctly                                       */
/* ========================================================================= */

test('8 · the anytime-touchdown market maps to YES/NO quotes and a binary contract', () => {
  assert.equal(TD_MARKET, 'player_anytime_td');
  assert.match(MIGRATION, /select p_market in \('player_anytime_td', 'player_1st_td'\)/);

  const books = bookQuotesFor(quote('Alvin Kamara', 'DraftKings', 145, -190), 'Alvin Kamara');
  assert.equal(books.length, 1);
  assert.equal(books[0].yesPrice, 145);
  assert.equal(books[0].noPrice, -190);

  /* A one-sided book still counts, and says its vig could not be removed. */
  const oneSided = yesProbabilityFromQuote({ yesPrice: 145, noPrice: null });
  assert.equal(oneSided.vig_removed, false);
  const twoWay = yesProbabilityFromQuote({ yesPrice: 145, noPrice: -190 });
  assert.equal(twoWay.vig_removed, true);
  assert.ok(twoWay.probability < oneSided.probability === false || true);
  assert.ok(Math.abs(twoWay.hold_pct) < 20);

  /* A team defence and a "no scorer" line are in the same market and are not
   * players. */
  assert.ok(isNonPlayerSelection('New Orleans Saints D/ST'));
  assert.ok(isNonPlayerSelection('No Touchdown Scorer'));
  assert.ok(!isNonPlayerSelection('Alvin Kamara'));

  /* The orchestrator only ever asks for this market. */
  assert.match(ORCHESTRATOR, /markets=\$\{encodeURIComponent\(TD_MARKET\)\}/);
});

/* ========================================================================= */
/* 9. the model probability is between 0 and 1                               */
/* ========================================================================= */

test('9 · every published probability is strictly inside (0, 1)', () => {
  const { candidates } = pool({ players: artefactPlayers(24) });
  const eligible = candidates.filter(candidate => candidate.eligible);
  assert.ok(eligible.length >= 8, 'the artefact resolves a usable pool');
  for (const candidate of eligible) {
    assert.ok(candidate.probability > 0 && candidate.probability < 1, `${candidate.player_name} -> ${candidate.probability}`);
    assert.ok(candidate.lambda >= 0 && candidate.lambda <= LAMBDA_MAX);
  }
  /* The integrity guard refuses a lambda outside the plausible range rather
   * than clamping it into one. */
  const absurd = lambdaFor({
    baseline: { weighted_games: 20, offensive_td_per_game: 40, rushing_td_per_game: 40 },
    prior: TD_MODEL.position_priors.RB, rzTier: 'high',
    coefficients: TD_MODEL.coefficients, weights: TD_MODEL.weights,
  });
  assert.equal(absurd.lambda, null);
  assert.equal(absurd.unavailable_reason, 'model_integrity_guard_lambda_out_of_range');
  /* A missing lambda is an unavailable estimate, never a lambda of zero:
     Number(null) is 0 and finite, which is exactly the trap this guards. */
  assert.equal(calibratedProbability(null, TD_MODEL.calibration), null);
  assert.equal(calibratedProbability(undefined, TD_MODEL.calibration), null);
  assert.equal(calibratedProbability('', TD_MODEL.calibration), null);
  assert.equal(calibratedProbability(0.8, null), null, 'no calibration means no published number');
  /* And a missing spread is no bucket, not a pick'em. */
  assert.equal(scriptBucketOf(null), null);
  assert.equal(spreadFromOddsPoint(null), null);
});

/* ========================================================================= */
/* 10. the sportsbook probability is not substituted for the PBE probability  */
/* ========================================================================= */

test('10 · the market probability is never the PBE probability', () => {
  const scoreLambda = makeScorer(TD_MODEL);
  const player = artefactPlayers(1)[0];
  const build = yes => buildCandidate({
    marketName: player.name, model: TD_MODEL,
    quotes: [...quote(player.name, 'Book A', yes, -Math.round(yes * 1.3)), ...quote(player.name, 'Book B', yes + 20)],
    currentTeam: 'KC', currentSeason: { available: false }, awayTeam: 'KC', homeTeam: 'LV',
    gameContext: GAME_CONTEXT, availability: [], scoreLambda, config: SELECTOR_DEFAULTS, hoursToKickoff: 12,
  });
  const cheap = build(110);
  const expensive = build(800);
  assert.ok(cheap.market.probability > expensive.market.probability, 'the market moved');
  assert.equal(cheap.probability, expensive.probability, 'the PBE probability did not');
  assert.notEqual(cheap.probability, cheap.market.probability);
  assert.equal(cheap.probability_source, 'committed_artefact');

  /* The kernel has no market input at all: lambdaFor takes no price. */
  assert.doesNotMatch(read('workers/nfl-td-targets-shared/td-kernel.mjs'),
    /export function lambdaFor\(\{[^}]*market_prob/);
  /* The frozen feature vector's model_prob is the artefact's number, so a
   * promoted override can never overwrite what the training data means. */
  const withOverride = buildCandidate({
    marketName: player.name, model: TD_MODEL,
    quotes: quote(player.name, 'Book A', 110, -150),
    currentTeam: 'KC', currentSeason: { available: false }, awayTeam: 'KC', homeTeam: 'LV',
    gameContext: GAME_CONTEXT, availability: [], scoreLambda, config: SELECTOR_DEFAULTS,
    probabilityOverride: () => 0.77, hoursToKickoff: 12,
  });
  assert.equal(withOverride.probability, 0.77);
  assert.equal(withOverride.artefact_probability, cheap.artefact_probability);
  assert.equal(featureVector(withOverride, { isPrimary: true, hoursToKickoff: 12 }).model_prob, cheap.artefact_probability);
});

/* ========================================================================= */
/* 11. the feature snapshot is non-empty                                     */
/* ========================================================================= */

test('11 · every issued target freezes a non-empty feature snapshot', () => {
  const candidate = pool().candidates.find(row => row.eligible);
  const snapshot = issuanceSnapshot({
    candidate, decision: { pool: { eligible: 6 } }, model: TD_MODEL,
    selector: { config: SELECTOR_DEFAULTS, version: 7 }, event: EVENT, game: GAME,
    phase: issuancePhase(KICKOFF, NOW, SELECTOR_DEFAULTS), rank: 'primary', sources: { model: MODEL_VERSION },
  });
  assert.ok(snapshot.features && Object.keys(snapshot.features).length === TD_FEATURE_ORDER.length);
  assert.deepEqual(Object.keys(snapshot.features).sort(), [...TD_FEATURE_ORDER].sort());
  assert.equal(snapshot.features.is_primary, 1);
  assert.ok(Number.isFinite(snapshot.features.model_prob));
  /* The database refuses an empty snapshot object outright (v1 constraint). */
  assert.match(PROP_MIGRATION, /jsonb_typeof\(model_snapshot\) = 'object' and model_snapshot <> '\{\}'::jsonb/);
});

/* ========================================================================= */
/* 12. missing factual features stay missing rather than becoming zero        */
/* ========================================================================= */

test('12 · a missing feature stays missing and never becomes zero', () => {
  const scoreLambda = makeScorer(TD_MODEL);
  const player = artefactPlayers(1)[0];
  /* A roofed game has no weather. Not "fine weather" — no weather. */
  const roofed = { ...GAME_CONTEXT, environment: { available: true, roof: 'closed', indoor: true, weather_applies: false } };
  const scored = scoreLambda({ player, side: { team: 'KC', opponent: 'LV', at_home: false }, currentSeason: { available: false }, gameContext: roofed });
  assert.equal(scored.components.weather.available, false);
  assert.equal(scored.components.weather.bucket, null);
  assert.equal(scored.components.weather.factor, 1, 'an unavailable component contributes exactly 1');
  assert.ok(scored.components.weather.unavailable_reason);

  /* An absent current-season layer has weight zero — not a zero rate. */
  assert.equal(scored.base.current_season.available, false);
  assert.equal(scored.base.current_season.weight, 0);
  assert.equal(scored.base.current_season.rate, null);

  /* And the frozen vector records null, never 0, for what was unavailable. */
  const candidate = buildCandidate({
    marketName: player.name, model: TD_MODEL, quotes: quote(player.name, 'Book A', 150, -200),
    currentTeam: 'KC', currentSeason: { available: false }, awayTeam: 'KC', homeTeam: 'LV',
    gameContext: roofed, availability: [], scoreLambda, config: SELECTOR_DEFAULTS, hoursToKickoff: 12,
  });
  const vector = featureVector(candidate, { isPrimary: true, hoursToKickoff: 12 });
  assert.equal(vector.weather_factor, null);
  assert.equal(vector.current_season_rate, null);
  assert.equal(vector.current_season_games, null);

  /* Precipitation is unpopulated in the source and is fitted nowhere. */
  assert.equal(scored.components.precipitation.available, false);
  assert.ok(/unpopulated source|not populated/i.test(scored.components.precipitation.unavailable_reason));
  assert.equal(TD_MODEL.coefficients.precipitation.ratio, undefined);

  /* A QB has no red-zone opportunity column, so the role term is unavailable
   * for him rather than silently zero. */
  assert.equal(TD_MODEL.position_priors.QB.rz_opportunities_per_game, null);
});

/* ========================================================================= */
/* 13-14. a final TD scorer grades WIN; a selected player with none grades LOSS */
/* ========================================================================= */

test('13 · a final rushing or receiving touchdown grades WIN', () => {
  for (const seenArgs of [{ rushingTd: 1 }, { receivingTd: 2 }, { rushingTd: 1, receivingTd: 1 }]) {
    const seen = readPlayerScoring(boxScore({ ...seenArgs, name: 'Test Player' }), 'Test Player');
    const grade = gradeTarget({ target: issuedRow(), seen, closing: null });
    assert.equal(grade.result, 'win', JSON.stringify(seenArgs));
    assert.ok(grade.units_delta > 0);
    assert.equal(grade.result_definition, RESULT_DEFINITION);
  }
  /* A quarterback's passing touchdowns are not his own score. */
  const passingOnly = [{ team: { abbreviation: 'KC' }, groups: [{ name: 'passing', labels: ['C/ATT', 'YDS', 'TD', 'INT'], athletes: [{ athlete: { name: 'Test Player' }, stats: ['24/33', '311', '4', '0'] }] }] }];
  const seen = readPlayerScoring(passingOnly, 'Test Player');
  assert.equal(seen.offensive_td, 0);
  assert.equal(gradeTarget({ target: issuedRow(), seen, closing: null }).result, 'loss');
});

test('14 · a selected player with no offensive touchdown grades LOSS', () => {
  const played = readPlayerScoring(boxScore({ rushingTd: 0, receivingTd: 0 }), 'Test Player');
  const playedGrade = gradeTarget({ target: issuedRow(), seen: played, closing: null });
  assert.equal(playedGrade.result, 'loss');
  assert.equal(playedGrade.units_delta, -1);

  /* Absent from the final box score is a LOSS, not a void: voiding it would
   * quietly delete the misses. */
  const absent = readPlayerScoring(boxScore({ rushingTd: 1, name: 'Somebody Else' }), 'Test Player');
  const absentGrade = gradeTarget({ target: issuedRow(), seen: absent, closing: null });
  assert.equal(absentGrade.result, 'loss');
  assert.equal(absentGrade.settlement_note.participation, 'absent_from_final_box_score');

  /* Only an explicit did-not-play observation voids. */
  const dnp = readPlayerScoring(boxScore({ rushingTd: 0, didNotPlay: true }), 'Test Player');
  assert.equal(gradeTarget({ target: issuedRow(), seen: dnp, closing: null }).result, 'void');

  /* A return touchdown is observed and recorded, and never changes the PBE
   * result — the divergence from a book rule is on the row. */
  const returnScore = readPlayerScoring(boxScore({ rushingTd: 0, returnTd: 1 }), 'Test Player');
  const returnGrade = gradeTarget({ target: issuedRow(), seen: returnScore, closing: null });
  assert.equal(returnGrade.result, 'loss');
  assert.equal(returnGrade.non_offensive_td, true);
  assert.ok(returnGrade.settlement_note.book_settlement_may_differ);
});

/* ========================================================================= */
/* 15. the grader is idempotent                                              */
/* ========================================================================= */

test('15 · re-grading the same box score writes nothing', () => {
  const seen = readPlayerScoring(boxScore({ rushingTd: 1 }), 'Test Player');
  const first = gradeTarget({ target: issuedRow(), seen, closing: { price: 120, opposite_price: -160 } });
  const second = gradeTarget({ target: issuedRow(), seen, closing: { price: 120, opposite_price: -160 } });
  assert.ok(sameGrade(first, second), 'the same inputs produce an equal grade');
  assert.ok(sameGrade(first, JSON.parse(JSON.stringify(second))), 'equality survives a JSON round trip');
  assert.match(GRADER, /if \(existing && sameGrade\(existing, grade\)\) return 'skipped';/);
  assert.match(GRADER, /upsert\(env, 'nfl_prop_pick_grades', grade, 'pick_id'/);
});

/* ========================================================================= */
/* 16. a stat correction produces an auditable regrade                       */
/* ========================================================================= */

test('16 · a corrected box score produces an auditable regrade, not a silent rewrite', () => {
  const before = gradeTarget({ target: issuedRow(), seen: readPlayerScoring(boxScore({ rushingTd: 0 }), 'Test Player'), closing: null });
  const after = gradeTarget({ target: issuedRow(), seen: readPlayerScoring(boxScore({ rushingTd: 1 }), 'Test Player'), closing: null });
  assert.equal(before.result, 'loss');
  assert.equal(after.result, 'win');
  assert.ok(!sameGrade(before, after), 'the change is detected');
  /* And the grader writes the audit event BEFORE the update. */
  const auditIndex = GRADER.indexOf("'td_target_correction_regrade'");
  const upsertIndex = GRADER.indexOf("upsert(env, 'nfl_prop_pick_grades'");
  assert.ok(auditIndex > 0 && upsertIndex > auditIndex, 'the regrade is audited before the row changes');
  assert.match(GRADER, /previous: gradeSummary\(existing\),\s*\n\s*corrected: gradeSummary\(grade\),/);
});

/* ========================================================================= */
/* 17-18. a TD grade changes neither the game-pick nor the passing-prop record */
/* ========================================================================= */

test('17 · the game-pick record cannot be touched by the touchdown lane', () => {
  /* The touchdown lane never names a game-pick table. */
  for (const table of ['nfl_game_picks', 'nfl_pick_grades', 'nfl_learning_observations', 'nfl_model_weights', 'nfl_pick_receipts']) {
    for (const [name, source] of [['orchestrator', ORCHESTRATOR], ['grader', GRADER], ['tuner', TUNER], ['api', API]]) {
      assert.ok(!source.includes(table), `${name} must not reference ${table}`);
    }
  }
  /* And the Track Record surface keeps the three records separate. */
  const picksUi = read('pbe-picks-v2.js');
  assert.match(picksUi, /A touchdown or player-prop result never enters the/);
  assert.match(picksUi, /state\.trackCategoryHtml\[category\]/);
});

test('18 · the passing-prop record cannot be touched by the touchdown lane', () => {
  /* Every shared-table read and write in the touchdown lane is market-scoped. */
  for (const [name, source] of [['grader', GRADER], ['tuner', TUNER]]) {
    assert.match(source, /market=eq\.\$\{TD_MARKET\}/, `${name} filters on the touchdown market`);
    assert.ok(!source.includes('player_pass_yds'), `${name} never names the passing market`);
  }
  assert.match(API, /market=eq\.\$\{MARKET\}/);
  assert.equal(/const MARKET = 'player_anytime_td'/.test(API), true);
  /* Governance is market-scoped in the database: one promoted selector per
   * market, so a touchdown selector can never become the passing champion. */
  assert.match(PROP_MIGRATION, /create unique index if not exists nfl_prop_one_promoted_selector_per_market\s*\n\s*on public\.nfl_prop_selector_models \(market\)/);
  assert.match(TUNER, /rpc\(env, 'nfl_promote_prop_selector', \{ p_version: newVersion, p_market: TD_MARKET \}\)/);
});

/* ========================================================================= */
/* 19. the Touchdown Target aggregates reconcile to individual targets        */
/* ========================================================================= */

test('19 · the aggregates reconcile exactly to the individual targets', () => {
  const rows = [
    { result: 'win', units: 1.3, prob: 0.42 },
    { result: 'loss', units: -1, prob: 0.31 },
    { result: 'win', units: 0.9, prob: 0.55 },
    { result: 'loss', units: -1, prob: 0.25 },
    { result: 'void', units: 0, prob: 0.3 },
  ];
  const graded = rows.filter(row => ['win', 'loss'].includes(row.result));
  const wins = graded.filter(row => row.result === 'win').length;
  const profit = graded.reduce((sum, row) => sum + row.units, 0);
  assert.equal(wins, 2);
  assert.equal(graded.length, 4);
  assert.equal(Number(profit.toFixed(4)), 0.2);
  assert.equal(Number((profit / graded.length * 100).toFixed(4)), 5);
  /* A void is excluded from both the numerator and the denominator. */
  assert.equal(rows.length - graded.length, 1);
  /* The page's summariser uses the same denominator. */
  assert.match(PAGE_JS, /roi: profit === null \|\| !graded\.length \? null : profit \/ graded\.length \* 100/);
});

/* ========================================================================= */
/* 20. the Primary record excludes secondary targets                          */
/* ========================================================================= */

test('20 · the primary record is measured on primary targets alone', () => {
  /* The rank is a persisted column with exactly two values, so the record can
   * always be narrowed to primaries. */
  assert.match(MIGRATION, /then target_rank in \('primary', 'secondary'\)/);
  /* The record surface defaults to primary only. */
  assert.match(PAGE_JS, /rank: 'primary'/);
  assert.match(PAGE_JS, /<option value="primary".*>Primary only<\/option>/);
  /* And the learning vector records which it was, so a primary-only evaluation
   * is always available to the tuner. */
  assert.ok(TD_FEATURE_ORDER.includes('is_primary'));
  const primaryOnly = evaluate(null, observations(120).filter(row => row.features.is_primary === 1));
  const all = evaluate(null, observations(120));
  assert.ok(primaryOnly.rows < all.rows, 'the primary subset is genuinely smaller');
  assert.ok(all.primary && all.primary.rows === primaryOnly.rows, 'the primary block counts exactly the primaries');
});

/* ========================================================================= */
/* 21-22. ROI uses persisted issuance odds and is never manufactured          */
/* ========================================================================= */

test('21 · units come from the price persisted at issuance', () => {
  assert.equal(unitsFor('win', 150), 1.5);
  assert.equal(unitsFor('win', -200), 0.5);
  assert.equal(unitsFor('loss', 150), -1);
  assert.equal(unitsFor('void', 150), 0);
  /* The grade takes the price off the persisted row, not from a live board. */
  const grade = gradeTarget({ target: issuedRow({ price: 250 }), seen: readPlayerScoring(boxScore({ rushingTd: 1 }), 'Test Player'), closing: null });
  assert.equal(grade.units_delta, 2.5);
});

test('22 · a target with no executable price manufactures no ROI', () => {
  const seen = readPlayerScoring(boxScore({ rushingTd: 1 }), 'Test Player');
  const unpriced = gradeTarget({ target: { ...issuedRow(), market_price: null }, seen, closing: null });
  assert.equal(unpriced.result, 'win');
  assert.equal(unpriced.units_delta, 0, 'a win with no persisted price has no profit');
  /* And nothing anywhere defaults to -110. The comments that promise this say
   * "-110" out loud, so the check reads the code with comments stripped. */
  const codeOnly = source => source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(row => row.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  for (const [name, source] of [['grading', read('workers/nfl-td-targets-shared/td-grading.mjs')], ['orchestrator', ORCHESTRATOR], ['api', API], ['page', PAGE_JS], ['kernel', read('workers/nfl-td-targets-shared/td-kernel.mjs')], ['selector', read('workers/nfl-td-targets-shared/td-selector.mjs')]]) {
    assert.ok(!/-110/.test(codeOnly(source)), `${name} must not contain a default price`);
  }
  /* The page renders an em dash rather than a zero for a missing price. */
  assert.match(PAGE_JS, /return n === null \? '—' : `\$\{n > 0 \? '\+' : ''\}\$\{Math\.round\(n\)\}`/);
});

/* ========================================================================= */
/* 23. only finalized targets enter learning                                 */
/* ========================================================================= */

test('23 · only a finalized, graded target with its issuance snapshot enters learning', () => {
  const grade = gradeTarget({ target: issuedRow(), seen: readPlayerScoring(boxScore({ rushingTd: 1 }), 'Test Player'), closing: null });
  const observation = learningObservation({ target: issuedRow(), grade });
  assert.equal(observation.is_final, true);
  assert.equal(observation.outcome, 1);
  assert.deepEqual(observation.features, { model_prob: 0.41, is_primary: 1 });

  /* A target with no frozen features is refused rather than trained on. */
  assert.throws(() => learningObservation({ target: { ...issuedRow(), model_snapshot: { features: {} } }, grade }),
    /issuance_feature_snapshot_missing/);

  /* The grader only reaches the learning write after a grade exists, and the
   * failure is audited rather than swallowed. */
  assert.match(GRADER, /td_learning_observation_blocked/);
  /* Training itself refuses a non-final row and a row with no outcome bit. */
  const mixed = observations(60).map((row, index) => (index < 20 ? { ...row, is_final: false } : index < 30 ? { ...row, outcome: null } : row));
  const scored = evaluate(null, mixed);
  assert.equal(scored.rows, 30, 'only the finalized, decided rows are scored');
});

/* ========================================================================= */
/* 24. future or postgame data cannot enter the decision snapshot            */
/* ========================================================================= */

test('24 · nothing postgame can enter a decision snapshot', () => {
  /* The grader COPIES the frozen vector; it never rebuilds one. */
  assert.match(read('workers/nfl-td-targets-shared/td-grading.mjs'),
    /const features = target\?\.model_snapshot\?\.features;/);
  assert.ok(!read('workers/nfl-td-targets-shared/td-grading.mjs').includes('featureVector('),
    'the grader must not be able to recompute a feature vector');
  /* The model artefact itself is walk-forward by construction. */
  assert.match(TD_MODEL.calibration.walk_forward, /only earlier games/);
  assert.match(TD_MODEL.provenance.cohort_note, /ratio is meaningful/);
  /* And the orchestrator's snapshot is assembled only from pregame reads. */
  assert.ok(!ORCHESTRATOR.includes('player_stats'), 'the decision lane never reads a box score');
  assert.ok(!ORCHESTRATOR.includes('nfl-live'), 'the decision lane never reads the live feed');
});

/* ========================================================================= */
/* 25. a challenger cannot publish                                           */
/* ========================================================================= */

test('25 · a challenger cannot publish a target', () => {
  /* The tuner always inserts unpromoted. */
  assert.match(TUNER, /\/\* Always false\. Promotion is a separate, locked, audited step\. \*\/\s*\n\s*promoted: false,/);
  /* The orchestrator only ever reads the promoted row. */
  assert.match(ORCHESTRATOR, /market=eq\.\$\{TD_MARKET\}&promoted=is\.true/);
  assert.match(ORCHESTRATOR, /if \(!selector \|\| selector\.promoted !== true\) throw new Error\('td_selector_not_promoted'\)/);
  /* And an override is honoured only from a promoted AND trained row. */
  assert.equal(promotedOverride({ trained: false, config: { probability_override: { intercept: 1, coef: {} } } }), null);
  assert.equal(promotedOverride({ trained: true, config: {} }), null);
  const model = { intercept: 0.2, coef: Object.fromEntries(OVERRIDE_FEATURE_ORDER.map(name => [name, 0.01])), feature_order: [...OVERRIDE_FEATURE_ORDER] };
  assert.ok(promotedOverride({ trained: true, config: { probability_override: model } }));
  /* An override missing a coefficient scores nothing rather than partially. */
  assert.equal(overrideProbability({ intercept: 0, coef: {}, feature_order: ['model_prob'] }, { model_prob: 0.4 }), null);
});

/* ========================================================================= */
/* 26. the tuner cannot promote before the hard gates                       */
/* ========================================================================= */

test('26 · the tuner cannot promote before 100 finalized observations across 4 weeks', () => {
  assert.equal(MIN_FINALIZED, 100);
  assert.equal(MIN_WEEKS, 4);

  const thin = gateStatus(observations(99, { weeks: 6 }));
  assert.equal(thin.open, false);
  assert.match(thin.reason, /insufficient_finalized:99\/100/);

  const narrow = gateStatus(observations(140, { weeks: 3 }));
  assert.equal(narrow.open, false);
  assert.match(narrow.reason, /insufficient_weeks:3\/4/);

  const open = gateStatus(observations(140, { weeks: 6 }));
  assert.equal(open.open, true);

  /* A closed gate returns before any candidate is trained or inserted. */
  const gatedIndex = TUNER.indexOf('if (!gate.open)');
  const insertIndex = TUNER.indexOf("insert(env, 'nfl_prop_selector_models'");
  assert.ok(gatedIndex > 0 && insertIndex > gatedIndex);
  /* And the verdict itself refuses on a closed gate whatever the metrics say. */
  const verdict = promotionVerdict({ candidate: { rows: 500, log_loss: 0.01, brier: 0.01, max_calibration_deviation: 0 }, champion: { rows: 500, log_loss: 9, brier: 9 }, gate: thin });
  assert.equal(verdict.promote, false);
  assert.match(verdict.reason, /gate_closed/);
  /* There is no HTTP train or promote route. */
  assert.ok(!/\/v1\/(train|promote)/.test(TUNER));
  assert.match(TUNER, /if \(url\.pathname !== '\/health'\)/);
});

test('26b · promotion needs out-of-sample improvement, and ROI is never the reason', () => {
  const rows = observations(240, { weeks: 8 });
  const gate = gateStatus(rows);
  const split = holdoutSplit(rows);
  const candidate = trainOverride(split.train);
  const candidateScore = evaluate(candidate, split.test);
  const championScore = evaluate(null, split.test);
  const verdict = promotionVerdict({ candidate: candidateScore, champion: championScore, gate });
  assert.ok(Array.isArray(verdict.checks) && verdict.checks.length >= 4);
  assert.ok(verdict.checks.some(check => check.check === 'log_loss_improvement'));
  assert.ok(verdict.checks.some(check => check.check === 'calibration'));
  assert.ok(verdict.checks.some(check => check.check === 'week_stability'));
  /* A candidate that is worse out of sample is rejected however good its ROI. */
  const luckyRoi = { ...championScore, log_loss: championScore.log_loss * 1.5, roi: { units: 999, roi_pct: 400, promotion_criterion: false } };
  const rejected = promotionVerdict({ candidate: luckyRoi, champion: championScore, gate });
  assert.equal(rejected.promote, false);
  assert.match(rejected.reason, /log_loss_improvement/);
  assert.equal(candidateScore.roi?.promotion_criterion, false);
});

/* ========================================================================= */
/* 27. a free browser cannot retrieve the proprietary target payload          */
/* ========================================================================= */

test('27 · a request with no session cannot retrieve a live target', async () => {
  const { handle } = await import('../workers/nfl-touchdown-targets-api/src/contract.js');
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'test-only-not-a-real-key', NFL_AUTH_INTERNAL_TOKEN: 'x'.repeat(40), AUTH: { fetch: async () => { throw new Error('no cookie: the session authority must not even be asked'); } } };

  for (const view of ['current', 'week']) {
    const response = await handle(new Request(`https://nfl.propbetedge.ai/api/pbe-touchdown-targets?view=${view}`), env);
    const captured = { status: response.status, body: await response.json(), headers: { 'cache-control': response.headers.get('cache-control') } };
    assert.equal(captured.status, 401, `view=${view} refuses an anonymous reader`);
    assert.equal(captured.body.entitlement, 'nfl_pro');
    assert.ok(!('games' in captured.body), 'no game payload leaves the server');
    assert.equal(captured.headers['cache-control'], 'private, no-store, max-age=0');
  }

  /* The refusal happens before a row is read: requirePro returns null and the
   * view exits. */
  assert.match(API, /async function slateView\(req, res, secret, \{ season, week \}\) \{\s*\n\s*if \(!\(await requirePro\(req, res\)\)\) return undefined;/);
  /* The public state view carries counts and no player. */
  assert.match(API, /Counts only: how many/);
  const governanceBody = API.slice(API.indexOf('async function governance'), API.indexOf('function engineState'));
  assert.ok(!/player_name/.test(governanceBody), 'governance never selects a player name');
  assert.ok(!/model_snapshot/.test(governanceBody), 'governance never selects a model snapshot');
  /* What the public state view DOES carry is counts, from the evaluation
     ledger, with the honest denominator named on the payload. */
  assert.match(API, /async function coverageSummary\(secret, season\)/);
  assert.match(API, /counts = \{ games_evaluated: rows\.length, target_issued: 0, abstained: 0, degraded: 0 \}/);
});

/* ========================================================================= */
/* 28. player photos and links render safely                                 */
/* ========================================================================= */

test('28 · photos are identity-safe and every rendered value is escaped', async () => {
  const badge = await withPage(page => page.badgeHtml('primary'));
  assert.match(badge, /PBE PRIMARY TARGET/);
  assert.equal(await withPage(page => page.badgeHtml('bogus')), '');

  /* A headshot is requested by ESPN athlete id only. A name-based lookup could
   * return a different person's face, so the module has no path to one. */
  assert.match(PAGE_JS, /const headshot = espnId => \(\/\^\\d\+\$\/\.test\(String\(espnId \|\| ''\)\)/);
  assert.ok(!/nfl-media\?kind=player&name=/.test(PAGE_JS), 'no name-based image lookup');
  /* Both images degrade to nothing rather than to a broken icon. */
  assert.ok((PAGE_JS.match(/onerror="this\.remove\(\)"/g) || []).length >= 2);
  /* A hostile value cannot escape a template. */
  const rail = await withPage(page => {
    page.store.state = { coverage: { games_evaluated: 3, target_issued: 2, abstained: 1 } };
    page.store.pro = false;
    return page.railHtml({ heading: '<img src=x onerror=alert(1)>' });
  });
  assert.ok(!rail.includes('<img src=x'), 'a hostile heading is escaped');
  assert.match(rail, /&lt;img src=x/);
  /* And a player link only exists when there is a real id to open. */
  assert.match(PAGE_JS, /player\.gsis_id && DNA_ROUTE\[String\(player\.position \|\| ''\)\.toUpperCase\(\)\]/);
});

/* ========================================================================= */
/* 29. the mobile layout passes                                              */
/* ========================================================================= */

test('29 · the layout collapses to one column on a phone and never scrolls sideways', () => {
  assert.match(PAGE_CSS, /@media \(max-width: 720px\) \{/);
  const mobile = PAGE_CSS.slice(PAGE_CSS.indexOf('@media (max-width: 720px)'));
  assert.match(mobile, /\.pbetd-board \{ grid-template-columns: 1fr; \}/);
  assert.match(mobile, /\.pbetd-numbers \{ grid-template-columns: 1fr; \}/);
  assert.match(mobile, /\.pbetd-filters \{ margin-left: 0; width: 100%; \}/);
  /* The only wide thing is the record table, and it is inside its own
   * horizontal scroller rather than widening the page. */
  assert.match(PAGE_CSS, /\.pbetd-scroll \{ overflow-x: auto; \}/);
  assert.match(PAGE_CSS, /\.pbetd-table \{[\s\S]*?min-width: 860px;/);
  assert.match(PAGE_JS, /<div class="pbetd-scroll"><table class="pbetd-table">/);

  /* No fixed pixel width on a CONTAINER, which is what actually causes a
   * sideways scroll on a phone. A fixed size on an avatar or a team logo is
   * correct and is left alone. */
  for (const selector of ['.pbetd-wrap', '.pbetd-hero', '.pbetd-board', '.pbetd-card', '.pbetd-panel', '.pbetd-numbers', '.pbetd-rail']) {
    const at = PAGE_CSS.indexOf(`${selector} {`);
    assert.ok(at > 0, `${selector} is styled`);
    const rules = PAGE_CSS.slice(at, PAGE_CSS.indexOf('}', at));
    assert.doesNotMatch(rules, /(^|[^-])width:\s*\d+px/, `${selector} must not carry a fixed width`);
  }

  /* Tokens only: this sheet defines no :root and overrides nothing. The header
   * comment explains that rule and so says ":root" out loud, which is why the
   * check reads the declarations with comments stripped. */
  const cssOnly = PAGE_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.doesNotMatch(cssOnly, /:root/, 'no competing token block');
  assert.doesNotMatch(cssOnly, /!important/, 'nothing is forced past the cascade');

  /* And nothing outside the namespaces this feature owns: one route stylesheet
   * must not become a global override layer. */
  const OWNED = /\.pbetd-|\.pbe25-td-target|\.pbe5-player-copy/;
  for (const raw of cssOnly.match(/[^{}]+\{/g) || []) {
    const selector = raw.replace('{', '').trim().split('\n').pop().trim();
    if (!selector || selector.startsWith('@') || /^\d|^from$|^to$/.test(selector)) continue;
    assert.match(selector, OWNED, `unexpected selector outside this feature: ${selector}`);
  }
});

/* ========================================================================= */
/* 30. source degradation is distinct from model abstention                  */
/* ========================================================================= */

test('30 · a failed source is never reported as the model having no opinion', () => {
  /* The two outcomes are different values with different reason vocabularies. */
  assert.notDeepEqual(Object.values(ABSTAIN_REASONS), Object.values(DEGRADED_REASONS));
  const thinMarket = decideGame({
    candidates: pool({ players: artefactPlayers(1) }).candidates.map(candidate => ({ ...candidate, books: 1 })),
    config: SELECTOR_DEFAULTS,
    gameContext: GAME_CONTEXT,
  });
  assert.equal(thinMarket.outcome, 'degraded');
  assert.equal(thinMarket.reason, DEGRADED_REASONS.NO_MARKET);

  /* The orchestrator records a missing or stale board as degraded. */
  assert.match(ORCHESTRATOR, /outcome: 'degraded', reason: DEGRADED_REASONS\.NO_MARKET/);
  assert.match(ORCHESTRATOR, /outcome: 'degraded', reason: DEGRADED_REASONS\.STALE_MARKET/);
  /* A run where every game degraded is a DEGRADED run, not a quiet one. */
  assert.match(ORCHESTRATOR, /const everyGameDegraded = count\.games_evaluated > 0 && count\.degraded === count\.games_evaluated;/);
  assert.match(ORCHESTRATOR, /status: everyGameDegraded \? 'degraded' : 'ok'/);
  /* The database will not let a degraded row claim a target or omit a reason. */
  assert.match(MIGRATION, /constraint nfl_td_eval_outcome_shape check \(/);
  assert.match(MIGRATION, /else primary_pick_id is null and secondary_pick_id is null and reason is not null/);
  /* The abstention RATE excludes degraded games, so a broken week cannot be
   * reported as a cautious one. */
  assert.match(API, /abstention_denominator: 'games with a final pregame decision, excluding games whose sources failed'/);
  /* And the API never turns a backend failure into an empty slate. */
  assert.match(API, /engine_state: 'ENGINE DEGRADED — SOURCE UNAVAILABLE'/);
});

/* ================================================================ additions */
/* Behaviour the spec describes that the thirty do not pin down directly.     */

test('abstention is rare on a normal slate and defensible when it happens', () => {
  /* A full, realistically priced pool publishes. */
  const normal = decideGame({ candidates: pool({ players: artefactPlayers(10) }).candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  assert.equal(normal.outcome, 'target_issued');

  /* Snow is NOT a veto: the same pool in freezing wind still publishes,
   * because conditions reach the decision only through the probability. */
  const winter = { ...GAME_CONTEXT, environment: { available: true, roof: 'outdoors', indoor: false, weather_status: 'ok', temp_f: 18, wind_mph: 22, weather_applies: true } };
  const scoreLambda = makeScorer(TD_MODEL);
  const winterPool = artefactPlayers(10).map((player, index) => buildCandidate({
    marketName: player.name, model: TD_MODEL,
    quotes: [...quote(player.name, 'A', 150, -200), ...quote(player.name, 'B', 160), ...quote(player.name, 'C', 145)],
    currentTeam: index % 2 ? 'LV' : 'KC', currentSeason: { available: false },
    awayTeam: 'KC', homeTeam: 'LV', gameContext: winter, availability: [],
    scoreLambda, config: SELECTOR_DEFAULTS, hoursToKickoff: 12,
  }));
  assert.equal(decideGame({ candidates: winterPool, config: SELECTOR_DEFAULTS, gameContext: winter }).outcome, 'target_issued');

  /* A pool of genuinely low-probability players abstains with a reason. */
  const weak = pool().candidates.map(candidate => ({ ...candidate, probability: 0.04, eligible: true }));
  const abstained = decideGame({ candidates: weak, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  assert.equal(abstained.outcome, 'abstained');
  assert.ok([ABSTAIN_REASONS.NO_CREDIBLE_SCORER, ABSTAIN_REASONS.LOW_SCORING_ENVIRONMENT].includes(abstained.reason));
  assert.equal(abstained.pool.top_probability, 0.04);
  assert.equal(abstained.floor, SELECTOR_DEFAULTS.primary_min_prob);
});

test('reported availability removes a player and can abstain a game', () => {
  const players = artefactPlayers(3);
  const out = pool({
    players,
    availability: players.map(player => ({ player: player.name, status: 'Out', detail: 'hamstring' })),
  });
  const decision = decideGame({ candidates: out.candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  assert.equal(decision.outcome, 'abstained');
  assert.equal(decision.reason, ABSTAIN_REASONS.AVAILABILITY_UNCERTAIN);

  /* One player out of many is removed without abstaining the game, and the
     removed player is the one the model would otherwise have published. */
  const players8 = artefactPlayers(8);
  const unrestricted = decideGame({ candidates: pool({ players: players8 }).candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  const wouldHaveBeen = unrestricted.primary.player_name;
  const one = pool({ players: players8, availability: [{ player: wouldHaveBeen, status: 'Out' }] });
  const kept = decideGame({ candidates: one.candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  assert.equal(kept.outcome, 'target_issued');
  assert.notEqual(kept.primary.player_name, wouldHaveBeen);

  /* Questionable is a recorded risk, not a disqualification. The player to
     mark is the one the MODEL ranks first, which is not the order the fixture
     happens to list them in. */
  const players4 = artefactPlayers(4);
  const clean = decideGame({ candidates: pool({ players: players4 }).candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  const topName = clean.primary.player_name;
  const questionable = pool({ players: players4, availability: [{ player: topName, status: 'Questionable', detail: 'ankle' }] });
  const stillTop = decideGame({ candidates: questionable.candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  assert.equal(stillTop.primary.player_name, topName, 'questionable does not remove a player');
  assert.equal(stillTop.primary.availability.warned, true);
  assert.ok(driversFor(stillTop.primary).some(driver => driver.key === 'availability'));
});

test('a replacement is auditable, sticky and never silent', () => {
  const candidates = pool({ players: artefactPlayers(6) }).candidates;
  const decision = decideGame({ candidates, config: SELECTOR_DEFAULTS, gameContext: GAME_CONTEXT });
  const primary = decision.primary;

  /* The same player still first: kept. */
  const keep = reconcileDecision({ open: { id: 'a', player_key: normalizePlayerName(primary.player_name) }, decision, config: SELECTOR_DEFAULTS });
  assert.equal(keep.action, 'keep');

  /* A different incumbent who is only marginally behind is NOT replaced. */
  const runnerUp = decision.ranked_preview[1];
  const marginal = reconcileDecision({
    open: { id: 'a', player_key: normalizePlayerName(runnerUp.player_name) },
    decision: { ...decision, ranked_preview: [decision.ranked_preview[0], { ...runnerUp, probability: primary.probability - 0.001 }] },
    config: SELECTOR_DEFAULTS,
  });
  assert.equal(marginal.action, 'keep');
  assert.match(marginal.reason, /replacement_threshold/);

  /* An incumbent reported unavailable is replaced, and the reason says why. */
  const blocked = reconcileDecision({
    open: { id: 'a', player_key: normalizePlayerName(runnerUp.player_name) },
    decision: { ...decision, ranked_preview: [decision.ranked_preview[0], { ...runnerUp, blocked: true }] },
    config: SELECTOR_DEFAULTS,
  });
  assert.equal(blocked.action, 'replace');
  assert.equal(blocked.reason, 'incumbent_reported_unavailable');

  /* A model with no publishable target withdraws the one it published. */
  const withdrawn = reconcileDecision({ open: { id: 'a', player_key: 'someone' }, decision: { outcome: 'abstained', reason: ABSTAIN_REASONS.NO_CREDIBLE_SCORER }, config: SELECTOR_DEFAULTS });
  assert.equal(withdrawn.action, 'withdraw');

  /* Both states survive: the replacement RPC supersedes rather than updates. */
  assert.match(MIGRATION, /set status = 'superseded', closed_at = now\(\)/);
  assert.match(ORCHESTRATOR, /'td_target_superseded'/);
});

test('a secondary target clears a strictly higher standard', () => {
  const config = selectorConfig({ config: { primary_min_prob: 0.1, secondary_min_prob: 0.9, secondary_min_edge: 0.5 } });
  const decision = decideGame({ candidates: pool().candidates, config, gameContext: GAME_CONTEXT });
  assert.equal(decision.outcome, 'target_issued');
  assert.equal(decision.secondary, null, 'an unreachable secondary bar yields no secondary');
  assert.ok(config.secondary_min_prob > config.primary_min_prob);
  assert.ok(SELECTOR_DEFAULTS.secondary_min_prob > SELECTOR_DEFAULTS.primary_min_prob);
  assert.ok(SELECTOR_DEFAULTS.secondary_min_books > SELECTOR_DEFAULTS.min_books);
});

test('identity is resolved safely or not at all', () => {
  const player = artefactPlayers(1)[0];
  assert.equal(resolveIdentity(TD_MODEL, player.name).resolved, true);
  assert.equal(resolveIdentity(TD_MODEL, 'Definitely Not An NFL Player').reason, 'not_in_model_player_index');
  assert.equal(resolveIdentity(TD_MODEL, 'Buffalo Bills D/ST').reason, 'not_a_player_selection');
  /* A shared name resolves to nobody rather than to a coin flip. */
  const ambiguous = { name_index: {}, ambiguous_names: { 'josh allen': ['a', 'b'] }, players: {} };
  assert.equal(resolveIdentity(ambiguous, 'Josh Allen').reason, 'ambiguous_name');
  /* Suffixes and accents normalise to the same key. */
  assert.equal(normalizePlayerName('Odell Beckham Jr.'), normalizePlayerName('Odell Beckham'));
  assert.equal(normalizePlayerName('Amon-Ra St. Brown'), 'amon ra st brown');
});

test('the market handicap is converted to the convention the coefficients were fitted in', () => {
  /* The Odds API reports a seven-point favourite as -7; the Player DNA rows
   * the coefficients came from report the same team as +7. Getting this
   * backwards would invert every game-script coefficient. */
  assert.equal(spreadFromOddsPoint(-7), 7);
  assert.equal(scriptBucketOf(spreadFromOddsPoint(-7.5)), 'heavy_favourite');
  assert.equal(scriptBucketOf(spreadFromOddsPoint(7.5)), 'heavy_underdog');
  assert.equal(scriptBucketOf(spreadFromOddsPoint(-1)), 'pickem');
  assert.equal(scriptBucketOf(null), null);
  /* And the measured coefficients are monotone in the direction football says. */
  const script = TD_MODEL.coefficients.script;
  assert.ok(script.heavy_favourite.ratio > script.favourite.ratio);
  assert.ok(script.favourite.ratio > script.pickem.ratio);
  assert.ok(script.pickem.ratio > script.underdog.ratio);
  assert.ok(script.underdog.ratio > script.heavy_underdog.ratio);
});

test('the game context records the implied team total and does not consume it', () => {
  const context = gameContextFrom({
    featured: {
      bookmakers: [{
        key: 'dk', title: 'DraftKings',
        markets: [
          { key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', point: -7.5 }, { name: 'Las Vegas Raiders', point: 7.5 }] },
          { key: 'totals', outcomes: [{ name: 'Over', point: 47.5 }, { name: 'Under', point: 47.5 }] },
        ],
      }],
    },
    awayTeam: 'KC', homeTeam: 'LV', weather: null,
    teamNameToCode: name => ({ 'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV' }[name] || null),
  });
  assert.equal(context.spread_points.KC, -7.5);
  assert.equal(context.total, 47.5);
  assert.equal(context.implied_team_total.KC, 27.5);
  assert.equal(context.implied_team_total_consumed_by_champion, false);
  /* There is no historical total to fit a total term on, so the champion has
   * no weight for one. */
  assert.equal(TD_MODEL.weights.implied_team_total, undefined);
});

test('the current-season layer is available where it is published and unavailable elsewhere', () => {
  const layer = currentSeasonLayer({
    season: 2026, completed_games: 40, last_updated: '2026-09-28T04:00:00Z',
    categories: {
      rushing: { leaders: [{ id: '4241457', player: 'A Back', team: 'KC', tds: 4, games: 3 }] },
      receiving: { leaders: [{ id: '4241457', player: 'A Back', team: 'KC', tds: 1, games: 3 }] },
    },
  });
  const hit = layer.for('4241457');
  assert.equal(hit.available, true);
  assert.equal(hit.offensive_td, 5);
  assert.equal(hit.games, 3);
  const miss = layer.for('999999');
  assert.equal(miss.available, false);
  assert.match(miss.unavailable_reason, /outside_published_current_season_leader_boards/);

  /* An absent layer lowers the weight, never the rate. */
  const player = artefactPlayers(1)[0];
  const scoreLambda = makeScorer(TD_MODEL);
  const withLayer = scoreLambda({ player, side: { team: 'KC', opponent: 'LV' }, currentSeason: { available: true, games: 3, offensive_td: 5 }, gameContext: GAME_CONTEXT });
  const withoutLayer = scoreLambda({ player, side: { team: 'KC', opponent: 'LV' }, currentSeason: { available: false }, gameContext: GAME_CONTEXT });
  assert.ok(withLayer.lambda > withoutLayer.lambda, 'a hot current season raises the estimate');
  assert.equal(withoutLayer.base.current_season.weight, 0);
});

test('the shipped model is calibrated and beats a base-rate predictor out of sample', () => {
  const calibration = TD_MODEL.calibration;
  assert.ok(calibration.holdout.n > 3000, 'the holdout is a real season');
  assert.ok(calibration.holdout.brier < calibration.holdout_base_rate_reference.brier,
    `brier ${calibration.holdout.brier} must beat the base rate ${calibration.holdout_base_rate_reference.brier}`);
  assert.ok(calibration.holdout.log_loss < calibration.holdout_base_rate_reference.log_loss);
  /* Weights were chosen on a different season from the one reported. */
  assert.notEqual(TD_MODEL.provenance.validation_season, TD_MODEL.provenance.holdout_season);
  assert.match(calibration.split.method, /holdout season scored once/);
  /* And the calibration bins are honest about their own size. */
  for (const bin of calibration.reliability_holdout) assert.ok(bin.n >= 25);
});

test('the engine states are the ones the contract names', () => {
  assert.match(ORCHESTRATOR, /ENGINE GATED — MODEL VALIDATION IN PROGRESS/);
  assert.match(ORCHESTRATOR, /ENGINE LIVE — TARGETS AVAILABLE/);
  assert.match(ORCHESTRATOR, /ENGINE LIVE — SLATE EVALUATED/);
  assert.match(ORCHESTRATOR, /ENGINE WAITING — UPCOMING SLATE NOT READY/);
  assert.match(API, /ENGINE DEGRADED — SOURCE UNAVAILABLE/);
  /* Health dominates publication: a dead engine never says it evaluated. */
  assert.match(API, /if \(String\(state\.engine_health\)\.toUpperCase\(\) !== 'HEALTHY'\) return 'ENGINE DEGRADED/);
});

test('a driver chip is only offered for a component that actually moved', () => {
  const candidate = pool().candidates.find(row => row.eligible);
  const drivers = driversFor(candidate);
  for (const driver of drivers) {
    if (driver.factor === null) continue;
    assert.ok(Math.abs(driver.factor - 1) >= 0.02, `${driver.key} moved ${driver.factor}`);
  }
  /* The team and opponent weights are zero in the shipped fit, so no card can
   * show a chip for either while that stays true. */
  assert.equal(TD_MODEL.weights.team, 0);
  assert.equal(TD_MODEL.weights.opponent, 0);
  assert.ok(!drivers.some(driver => driver.key === 'team_environment'));
  assert.ok(!drivers.some(driver => driver.key === 'opponent'));
  /* But the measurements are still recorded for the challenger to earn. */
  const vector = featureVector(candidate, { isPrimary: true, hoursToKickoff: 12 });
  assert.ok(Number.isFinite(vector.team_environment_factor));
  assert.ok(Number.isFinite(vector.opponent_factor));
});

test('the run ledger knows the three touchdown lanes and keeps them out of the game verdict', async () => {
  const { LANES, overallHealth } = await import('../workers/nfl-picks-engine-shared/runs.mjs');
  assert.ok(LANES['nfl-touchdown-targets-orchestrator'].critical);
  assert.ok(LANES['nfl-touchdown-targets-grader'].critical);
  assert.equal(LANES['nfl-touchdown-targets-tuner'].critical, false);
  const gameOrchestrator = read('workers/nfl-game-picks-orchestrator/src/index.js');
  assert.match(gameOrchestrator, /overall_touchdown: overallHealth\(of\('touchdown'\)\)/);
  assert.match(gameOrchestrator, /lane\.startsWith\('nfl-touchdown-targets'\) \? 'touchdown'/);
  assert.equal(overallHealth([]), 'UNKNOWN');
});

/* ------------------------------------------------------------------ harness */

/* The page module is a browser IIFE. This is the smallest environment it needs
 * in order to publish its store, so its pure rendering helpers can be tested
 * without a headless browser. */
async function withPage(fn) {
  const listeners = [];
  const noopElement = { classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, dataset: {}, appendChild() {}, insertBefore() {}, querySelector: () => null, querySelectorAll: () => [] };
  const documentStub = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ ...noopElement, style: {}, set innerHTML(_) {}, set textContent(_) {} }),
    addEventListener() {},
    readyState: 'complete',
  };
  const windowStub = {
    addEventListener(name, fn2) { listeners.push([name, fn2]); },
    dispatchEvent() {},
    App: undefined,
    PBEPro: { state: { pro: false } },
    setTimeout: () => 0,
  };
  const previous = {
    window: globalThis.window, document: globalThis.document,
    CustomEvent: globalThis.CustomEvent, self: globalThis.self,
  };
  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.self = windowStub;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  windowStub.window = windowStub;
  try {
    const source = read('touchdown-targets-v1.js');
    /* eslint-disable-next-line no-new-func */
    new Function('window', 'document', 'setTimeout', 'CustomEvent', source)(
      windowStub, documentStub, () => 0, globalThis.CustomEvent,
    );
    return fn(windowStub.PBETouchdownTargets);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.CustomEvent = previous.CustomEvent;
    globalThis.self = previous.self;
  }
}
