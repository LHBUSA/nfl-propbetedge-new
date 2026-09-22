/* nfl-touchdown-targets-orchestrator — PBE Touchdown Targets, Algorithm #3.
 *
 * ONE PRIMARY TARGET PER GAME. Every eligible game leaves this Worker in
 * exactly one recorded state and never in silence:
 *
 *   PRIMARY TARGET       one named player, his probability frozen, locked
 *                        before kickoff, immutable afterwards
 *   MODEL ABSTAIN        a reason code and the pool the model evaluated
 *   SOURCE DEGRADED      an upstream could not answer — deliberately a
 *                        different outcome from an abstention
 *
 * A separate lane rather than an extension of nfl-prop-picks-orchestrator: the
 * passing-yards engine is in production and a binary market has a different
 * decision shape, a different cadence need and a different failure surface.
 * Everything genuinely market-neutral is shared instead of copied —
 * nfl-picks-engine-shared for Supabase access, slate truth and the run ledger,
 * and nfl-td-targets-shared for the probability kernel and the selector.
 *
 * INPUTS. All read-only, all persisted-snapshot reads, none of them a paid
 * provider call:
 *   nfl-current  (binding)  season, week, the REAL kickoff, game state, and
 *                           the current-season touchdown leader boards
 *   nfl-odds     (binding)  the scheduled 3x/day snapshot: events, the
 *                           anytime-touchdown board, spreads and totals
 *   nfl-intel    (binding)  the kickoff-window forecast and the reported
 *                           availability board
 *   td-model-v1  (bundled)  the committed factual model artefact
 *
 * The probability model is bundled, not fetched: a decision must never depend
 * on a network read of its own brain, and the artefact is a reviewable file in
 * git whose provenance is stamped inside it.
 *
 * WHAT THIS WORKER WILL NOT DO
 *   - it will not publish a target for a game that has kicked off;
 *   - it will not change a target after kickoff (the database refuses too);
 *   - it will not turn a missing market into "the model had no opinion";
 *   - it will not put the sportsbook's probability in the PBE probability;
 *   - it will not let a challenger publish: issuance reads the one PROMOTED
 *     selector for this market and nothing else.
 */
import { select, insert, patch, rpc } from '../../nfl-picks-engine-shared/supabase.mjs';
import { teamCodeFromName } from '../../nfl-picks-engine-shared/odds-normalize.mjs';
import { loadSlate, issuable, matchGameForEvent, cadenceDecision } from '../../nfl-picks-engine-shared/current-slate.mjs';
import { recordRun, readLane, laneHealth, lastWorkRecord } from '../../nfl-picks-engine-shared/runs.mjs';
import { TD_MODEL } from '../../nfl-td-targets-shared/td-model-v1.js';
import { MODEL_VERSION, normalizePlayerName, round } from '../../nfl-td-targets-shared/td-kernel.mjs';
import { makeScorer, gameContextFrom, environmentFrom, currentSeasonLayer } from '../../nfl-td-targets-shared/td-score.mjs';
import {
  TD_MARKET, SELECTOR_VERSION_TAG, selectorConfig, buildCandidate, decideGame,
  reconcileDecision, issuancePhase, issuanceSnapshot, featureVector, DEGRADED_REASONS,
} from '../../nfl-td-targets-shared/td-selector.mjs';
import { promotedOverride, overrideProbability } from '../../nfl-td-targets-shared/td-learning.mjs';

const SERVICE = 'nfl-touchdown-targets-orchestrator';
const VERSION = 'v1.0.0';
const HORIZON_HOURS = 60;
const MAX_EVENTS = 20;
/* Never decide on a board older than twice the longest normal ingest gap. */
const BOARD_MAX_AGE_MS = 28 * 3600000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const lane = laneHealth(SERVICE, await readLane(env, SERVICE));
      return json({
        service: SERVICE,
        version: VERSION,
        health: lane.state,
        health_reason: lane.reason,
        last_tick: lane.last_tick,
        last_work: lane.last_work,
        last_ok_at: lane.last_ok_at,
        last_error: lane.last_error,
        market: TD_MARKET,
        model: { version: MODEL_VERSION, built_at: TD_MODEL?.built_at ?? null, players: Object.keys(TD_MODEL?.players || {}).length },
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          NFL_CURRENT_BINDING: Boolean(env.NFL_CURRENT),
          NFL_ODDS_BINDING: Boolean(env.NFL_ODDS),
          NFL_INTEL_BINDING: Boolean(env.NFL_INTEL),
          PICKS_KV_BINDING: Boolean(env.PICKS_KV),
        },
      });
    }
    if (url.pathname === '/v1/engine/state' && req.method === 'GET') return engineState(env);
    if (url.pathname === '/v1/engine/model' && req.method === 'GET') return modelState();
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledTick(env, event));
  },
};

/* Governance state, from persisted rows only. Publication (GATED / ALLOWED) is
 * the champion row's business; whether the engine is alive is the run ledger's,
 * and the two are never conflated. */
async function engineState(env) {
  try {
    const selector = await promotedSelector(env);
    const observations = await select(
      env,
      'nfl_prop_learning_observations',
      `market=eq.${TD_MARKET}&is_final=eq.true&select=season,week,publication_scope&limit=5000`,
    ) || [];
    const weeks = new Set(observations.map(row => `${row.season}-${row.week}`));
    return json({
      service: SERVICE,
      version: VERSION,
      market: TD_MARKET,
      model_version: MODEL_VERSION,
      selector: SELECTOR_VERSION_TAG,
      selector_version: selector.version,
      selector_trained: selector.trained === true,
      selector_promoted: selector.promoted === true,
      issuance_mode: selector.trained === true ? 'OFFICIAL' : 'TRACKING_BOOTSTRAP',
      publication: selector.trained === true ? 'ALLOWED' : 'GATED',
      finalized_sample: observations.length,
      distinct_weeks: weeks.size,
      truth: 'one_primary_target_per_game_locked_pregame',
    });
  } catch (error) {
    return json({ engine_state: 'ENGINE DEGRADED — source unavailable', error_class: errorClass(error) }, 503);
  }
}

/* The committed artefact's own account of itself. Public-safe: provenance,
 * fitted weights, the holdout backtest and the counts — never the per-player
 * baselines, which are the proprietary part. */
function modelState() {
  const model = TD_MODEL || {};
  return json({
    service: SERVICE,
    model_version: model.version ?? null,
    built_at: model.built_at ?? null,
    label: model.label ?? null,
    provenance: model.provenance ?? null,
    weights: model.weights ?? null,
    shrinkage: model.shrinkage ?? null,
    coefficients: model.coefficients ?? null,
    calibration: model.calibration ?? null,
    counts: model.counts ?? null,
    scope: 'the calibration block is a HISTORICAL BACKTEST and is not the verified live record',
  });
}

/* --------------------------------------------------------------- cadence */

async function scheduledTick(env, event) {
  const startedAt = new Date();
  const base = { version: VERSION, cron: event?.cron || null, started_at: startedAt.toISOString() };
  let slate, meta;
  try {
    [slate, meta] = await Promise.all([loadSlate(env), oddsMeta(env)]);
  } catch (error) {
    await recordRun(env, SERVICE, {
      ...base, status: 'degraded', reason: 'inputs_unavailable', error_class: errorClass(error),
    });
    return;
  }
  const last = await lastWorkRecord(env, SERVICE);
  const lastBatch = last?.source_freshness?.market_captured_at || null;
  const nowMs = startedAt.getTime();
  const decision = cadenceDecision({
    games: slate.games,
    nowMs,
    lastWorkMs: Date.parse(last?.finished_at || '') || null,
    newTape: Boolean(meta.captured_at && lastBatch && Date.parse(meta.captured_at) > Date.parse(lastBatch)),
  });
  if (!decision.go) {
    await recordRun(env, SERVICE, {
      ...base, status: 'skipped', reason: decision.reason,
      detail: { public: { tier: decision.tier } },
      source_freshness: { market_captured_at: meta.captured_at, current_state_updated: slate.last_updated },
    });
    return;
  }
  await runOrchestration(env, slate, meta, { ...base, tier: decision.tier });
}

/* ---------------------------------------------------------- orchestration */

async function runOrchestration(env, slate, meta, base) {
  const count = {
    events_in_horizon: 0, games_evaluated: 0, schedule_skip: 0,
    targets_issued: 0, targets_kept: 0, targets_replaced: 0, targets_withdrawn: 0,
    secondaries_issued: 0, abstained: 0, degraded: 0, scope_drain: 0,
  };
  const abstainReasons = {};
  const degradedReasons = {};
  const coverage = [];
  let scope = null;

  try {
    const selector = await promotedSelector(env);
    scope = issuanceScope(selector);
    const config = selectorConfig(selector);
    const scoreLambda = makeScorer(TD_MODEL);
    /* Only a PROMOTED and TRAINED selector can carry an override. A challenger
     * is inserted unpromoted and is therefore not the row this read returns,
     * which is the mechanism that stops a challenger publishing. */
    const override = promotedOverride(selector);
    const probabilityOverride = override ? features => overrideProbability(override, features) : null;

    /* Three snapshot reads for the whole tick, not per game: the market index,
     * the kickoff-window forecast board and the reported availability board.
     * The current-season touchdown layer is one more. */
    const [eventsBody, weatherBoard, availabilityBoard, currentStats] = await Promise.all([
      oddsJson(env, '/api/odds/events'),
      intelJson(env, '/api/game-weather').catch(() => null),
      intelJson(env, '/api/injuries').catch(() => null),
      currentJson(env, '/api/current-stats').catch(() => null),
    ]);
    const currentLayer = currentSeasonLayer(currentStats);
    const weatherByEspnId = indexWeather(weatherBoard);
    const availabilityByTeam = indexAvailability(availabilityBoard);

    const now = Date.now();
    const horizon = now + HORIZON_HOURS * 3600000;
    const events = (Array.isArray(eventsBody?.events) ? eventsBody.events : [])
      .map(event => ({ ...event, ts: Date.parse(event?.commence_time || '') }))
      .filter(event => Number.isFinite(event.ts) && event.ts > now && event.ts <= horizon)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, MAX_EVENTS);
    count.events_in_horizon = events.length;

    for (const event of events) {
      /* Identity, week and the REAL kickoff come from nfl-current. A game the
       * provider no longer calls scheduled is never issued on. */
      const game = matchGameForEvent(slate.games, {
        away: teamCodeFromName(event.away_team),
        home: teamCodeFromName(event.home_team),
        commenceMs: event.ts,
      });
      if (!game || !issuable(game, now, HORIZON_HOURS * 3600000)) { count.schedule_skip += 1; continue; }

      const phase = issuancePhase(game.kickoff_ts, now, config);
      if (!phase) { count.schedule_skip += 1; continue; }

      const row = {
        game_id: game.game_id,
        matchup: `${game.away_team} @ ${game.home_team}`,
        kickoff_ts: game.kickoff_ts,
      };
      coverage.push(row);

      const result = await evaluateGame(env, {
        event, game, phase, slate, selector, config, scope, scoreLambda, probabilityOverride,
        currentLayer, weatherByEspnId, availabilityByTeam, now,
      });

      row.outcome = result.outcome;
      row.reason = result.reason || null;
      row.eligible_pool = result.eligible_pool ?? 0;
      row.top_probability = result.top_probability ?? null;
      row.action = result.action || null;

      count.games_evaluated += 1;
      if (result.outcome === 'abstained') {
        count.abstained += 1;
        abstainReasons[result.reason] = (abstainReasons[result.reason] || 0) + 1;
      } else if (result.outcome === 'degraded') {
        count.degraded += 1;
        degradedReasons[result.reason] = (degradedReasons[result.reason] || 0) + 1;
      }
      for (const key of ['targets_issued', 'targets_kept', 'targets_replaced', 'targets_withdrawn', 'secondaries_issued', 'scope_drain']) {
        count[key] += result[key] || 0;
      }
    }

    const covered = count.targets_issued + count.targets_kept + count.targets_replaced;
    const engine = scope === 'tracking'
      ? 'ENGINE GATED — MODEL VALIDATION IN PROGRESS'
      : covered
        ? 'ENGINE LIVE — TARGETS AVAILABLE'
        : count.games_evaluated
          ? 'ENGINE LIVE — SLATE EVALUATED'
          : 'ENGINE WAITING — UPCOMING SLATE NOT READY';

    /* An upstream that failed for every game is a degraded run, not a quiet
     * one. This is the line that stops "no targets" from ever being a
     * comfortable way to report a broken source. */
    const everyGameDegraded = count.games_evaluated > 0 && count.degraded === count.games_evaluated;

    await recordRun(env, SERVICE, {
      ...base,
      status: everyGameDegraded ? 'degraded' : 'ok',
      reason: everyGameDegraded ? 'sources_unavailable_for_every_game' : `scope=${scope}`,
      counts: count,
      source_freshness: {
        market_captured_at: meta.captured_at,
        market_batch_id: meta.batch_id,
        current_state_updated: slate.last_updated,
        weather_fetched_at: weatherBoard?.fetched_at ?? null,
        availability_fetched_at: availabilityBoard?.source?.fetched_at ?? null,
        current_season_updated: currentStats?.last_updated ?? null,
        current_season_players_covered: currentLayer.covered_players,
      },
      detail: {
        public: {
          tier: base.tier,
          engine_state: engine,
          market: TD_MARKET,
          model_version: MODEL_VERSION,
          publication_scope: scope,
          abstain_reasons: abstainReasons,
          degraded_reasons: degradedReasons,
          games: coverage,
        },
      },
    });
  } catch (error) {
    console.error(`[${SERVICE}] orchestration failed class=${errorClass(error)}`);
    await recordRun(env, SERVICE, {
      ...base, status: 'failed', error_class: errorClass(error), counts: count,
      source_freshness: { market_captured_at: meta?.captured_at || null },
    });
  }
}

/* --------------------------------------------------------------- one game */

async function evaluateGame(env, {
  event, game, phase, selector, config, scope, scoreLambda, probabilityOverride,
  currentLayer, weatherByEspnId, availabilityByTeam, now,
}) {
  const tally = {
    targets_issued: 0, targets_kept: 0, targets_replaced: 0, targets_withdrawn: 0,
    secondaries_issued: 0, scope_drain: 0,
  };

  /* The anytime-touchdown board and the featured market for this event. */
  const [board, featured] = await Promise.all([
    oddsJson(env, `/api/odds/board?event_id=${encodeURIComponent(event.id)}&markets=${encodeURIComponent(TD_MARKET)}`).catch(() => null),
    oddsJson(env, `/api/odds?event_id=${encodeURIComponent(event.id)}`).catch(() => null),
  ]);

  const quotes = (Array.isArray(board?.quotes) ? board.quotes : []).filter(quote => quote?.market === TD_MARKET);
  const capturedAt = board?.captured_at || null;

  if (!quotes.length) {
    return { ...tally, ...(await recordEvaluation(env, { event, game, phase, selector, scope, outcome: 'degraded', reason: DEGRADED_REASONS.NO_MARKET, detail: { board_captured_at: capturedAt } })) };
  }
  if (!capturedAt || now - Date.parse(capturedAt) > BOARD_MAX_AGE_MS) {
    return { ...tally, ...(await recordEvaluation(env, { event, game, phase, selector, scope, outcome: 'degraded', reason: DEGRADED_REASONS.STALE_MARKET, detail: { board_captured_at: capturedAt, max_age_hours: BOARD_MAX_AGE_MS / 3600000 } })) };
  }

  const gameContext = {
    ...gameContextFrom({
      featured: featuredEvent(featured, event.id),
      awayTeam: game.away_team,
      homeTeam: game.home_team,
      weather: environmentFrom(weatherByEspnId.get(String(game.espn_id || ''))),
      teamNameToCode: teamCodeFromName,
    }),
    board_captured_at: capturedAt,
  };

  const availability = [
    ...(availabilityByTeam.get(game.away_team) || []),
    ...(availabilityByTeam.get(game.home_team) || []),
  ];

  /* One candidate per distinct player the market actually prices. The pool is
   * the market's, so it is the real scoring pool for this game and not a list
   * we invented. */
  const marketNames = [...new Set(quotes.map(quote => String(quote.player || '').trim()).filter(Boolean))];
  const candidates = marketNames.map(marketName => buildCandidate({
    marketName,
    model: TD_MODEL,
    quotes,
    currentTeam: currentTeamFor(currentLayer, TD_MODEL, marketName),
    currentSeason: currentSeasonFor(currentLayer, TD_MODEL, marketName),
    awayTeam: game.away_team,
    homeTeam: game.home_team,
    gameContext,
    availability,
    scoreLambda,
    config,
    probabilityOverride,
    hoursToKickoff: phase.hours_to_kickoff,
  }));

  const decision = decideGame({ candidates, config, gameContext });

  const open = await openTargets(env, event.id);
  const openPrimary = open.find(target => target.target_rank === 'primary') || null;
  const openSecondary = open.find(target => target.target_rank === 'secondary') || null;

  /* Publication scope drain: a decision issued under one scope is never
   * reconciled against a target issued under the other. The old target is left
   * exactly as it was and the game is recorded as evaluated. */
  if (openPrimary && openPrimary.publication_scope !== scope) {
    tally.scope_drain = 1;
    return { ...tally, ...(await recordEvaluation(env, { event, game, phase, selector, scope, outcome: decision.outcome, reason: decision.reason, decision, detail: { scope_drain: true, open_scope: openPrimary.publication_scope } })) };
  }

  const action = reconcileDecision({ open: openPrimary, decision, config });
  const sources = {
    market: { captured_at: capturedAt, batch_id: board?.snapshot_batch_id ?? null, books: decision.primary?.market?.books ?? null },
    slate: { authority: 'nfl-current', updated: game.kickoff_ts },
    weather: gameContext.available?.weather === true ? 'nfl-intel kickoff-window forecast' : 'unavailable',
    availability: availability.length ? 'nfl-intel reported designations' : 'unavailable',
    current_season: currentLayer.available ? currentLayer.last_updated : 'unavailable',
    model: { artefact: MODEL_VERSION, built_at: TD_MODEL?.built_at ?? null },
  };

  let primaryId = openPrimary?.id ?? null;

  if (action.action === 'issue') {
    primaryId = await issueTarget(env, { candidate: decision.primary, decision, selector, scope, event, game, phase, rank: 'primary', sources });
    tally.targets_issued = 1;
  } else if (action.action === 'replace') {
    primaryId = await replaceTarget(env, { open: openPrimary, candidate: decision.primary, decision, selector, scope, event, game, phase, sources, action });
    tally.targets_replaced = 1;
  } else if (action.action === 'keep') {
    tally.targets_kept = 1;
    await auditTarget(env, openPrimary.id, 'td_target_confirmed', selector.version, {
      reason: action.reason, model_prob: decision.primary?.probability ?? null, hours_to_kickoff: phase.hours_to_kickoff,
    });
  } else if (action.action === 'withdraw') {
    await withdrawTarget(env, openPrimary, selector.version, action.reason);
    tally.targets_withdrawn = 1;
    primaryId = null;
  }

  /* The secondary is optional and independent: it is issued when it qualifies,
   * withdrawn when it stops qualifying, and never allowed to stand in for a
   * primary. */
  let secondaryId = openSecondary?.id ?? null;
  if (openSecondary && openSecondary.publication_scope === scope) {
    const stillGood = decision.secondary
      && normalizePlayerName(decision.secondary.player_name) === String(openSecondary.player_key || '');
    if (!stillGood) {
      await withdrawTarget(env, openSecondary, selector.version, 'secondary_no_longer_qualified');
      secondaryId = null;
    }
  }
  if (!secondaryId && decision.secondary && primaryId) {
    secondaryId = await issueTarget(env, { candidate: decision.secondary, decision, selector, scope, event, game, phase, rank: 'secondary', sources });
    tally.secondaries_issued = 1;
  }

  const recorded = await recordEvaluation(env, {
    event, game, phase, selector, scope, decision,
    outcome: primaryId ? 'target_issued' : (decision.outcome === 'target_issued' ? 'degraded' : decision.outcome),
    reason: primaryId ? null : (decision.reason || 'target_not_persisted'),
    primaryId, secondaryId,
    detail: { action: action.action, action_reason: action.reason, sources },
  });

  /* Pre-kick closing tape for the open targets, in the table the passing-yards
   * grader already uses. Captured only while the game is still pregame, so a
   * post-kick price can never become a closing price. */
  for (const [id, candidate] of [[primaryId, decision.primary], [secondaryId, decision.secondary]]) {
    if (!id || !candidate?.market?.best_price) continue;
    await captureClosing(env, { id, candidate, event, game, capturedAt });
  }

  return { ...tally, ...recorded, action: action.action };
}

/* ------------------------------------------------------------- persistence */

function issuanceRow({ candidate, decision, selector, scope, event, game, phase, rank, sources }) {
  const snapshot = issuanceSnapshot({ candidate, decision, model: TD_MODEL, selector, event, game, phase, rank, sources });
  const best = candidate.market;
  return {
    event_id: event.id,
    season: game.season,
    week: game.week,
    kickoff_ts: game.kickoff_ts,
    player_name: candidate.player_name,
    player_key: normalizePlayerName(candidate.player_name),
    market: TD_MARKET,
    side: 'YES',
    book: best?.best_book || 'consensus',
    book_key: best?.best_book_key || null,
    /* No market_line, no model_fair_line, no predictive_sd. A binary market
     * has none of those, and the migration made the table say so. */
    market_price: best?.best_price ?? null,
    opposite_price: best?.opposite_price ?? null,
    model_prob: candidate.probability,
    market_prob: best?.probability ?? null,
    edge_pct: candidate.edge,
    ev_pct: candidate.ev_pct,
    stake_units: 0,
    confidence_bucket: confidenceOf(candidate, selector),
    projection_model_version: MODEL_VERSION,
    selector_version: selector.version,
    phase: phase.phase,
    publication_scope: scope,
    status: 'open',
    target_rank: rank,
    model_snapshot: snapshot,
  };
}

/* Confidence describes the evidence behind a published target, not a stake.
 * A is a target the model likes AND the market underrates AND several books
 * price; C is a target published on the model alone. */
function confidenceOf(candidate, selector) {
  const config = selectorConfig(selector);
  const edge = Number(candidate.edge);
  const books = Number(candidate.books || 0);
  if (candidate.probability >= config.secondary_min_prob && edge >= 0.05 && books >= 3) return 'A';
  if (candidate.probability >= config.primary_min_prob && edge >= 0.02 && books >= 2) return 'B';
  return 'C';
}

async function issueTarget(env, params) {
  const row = issuanceRow(params);
  const inserted = await insert(env, 'nfl_prop_picks', row);
  const id = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
  if (!id) throw new Error('td_target_insert_returned_no_id');
  await auditIssuance(env, id, params);
  return id;
}

async function replaceTarget(env, params) {
  const { open, action } = params;
  const row = issuanceRow(params);
  const newId = await rpc(env, 'nfl_replace_open_td_target', {
    p_open_id: open.id,
    p_event_id: row.event_id,
    p_season: row.season,
    p_week: row.week,
    p_kickoff_ts: row.kickoff_ts,
    p_player_name: row.player_name,
    p_player_key: row.player_key,
    p_market: row.market,
    p_side: row.side,
    p_book: row.book,
    p_book_key: row.book_key,
    p_market_price: row.market_price,
    p_opposite_price: row.opposite_price,
    p_model_prob: row.model_prob,
    p_market_prob: row.market_prob,
    p_edge_pct: row.edge_pct,
    p_ev_pct: row.ev_pct,
    p_stake_units: row.stake_units,
    p_confidence_bucket: row.confidence_bucket,
    p_projection_model_version: row.projection_model_version,
    p_selector_version: row.selector_version,
    p_phase: row.phase,
    p_publication_scope: row.publication_scope,
    p_target_rank: row.target_rank,
    p_model_snapshot: row.model_snapshot,
  });
  const id = typeof newId === 'string' ? newId : (Array.isArray(newId) ? newId[0] : newId?.nfl_replace_open_td_target) || null;
  /* Both states stay on the record: the superseded target keeps every issuance
   * field it was published with, and the replacement names what replaced it. */
  await auditTarget(env, open.id, 'td_target_superseded', params.selector.version, {
    superseded_by: id,
    from_player: open.player_name,
    to_player: row.player_name,
    reason: action?.reason ?? null,
    from_probability: action?.from_probability ?? null,
    to_probability: action?.to_probability ?? null,
    hours_to_kickoff: params.phase.hours_to_kickoff,
  });
  if (id) await auditIssuance(env, id, params);
  return id;
}

async function withdrawTarget(env, open, selectorVersion, reason) {
  await patch(env, 'nfl_prop_picks', `id=eq.${open.id}`, { status: 'killed', closed_at: new Date().toISOString() });
  await auditTarget(env, open.id, 'td_target_withdrawn', selectorVersion, { reason, player_name: open.player_name });
}

async function auditIssuance(env, id, { candidate, decision, selector, scope, phase, rank }) {
  await auditTarget(env, id, 'td_target_created', selector.version, {
    target_rank: rank,
    player_name: candidate.player_name,
    team: candidate.team,
    opponent: candidate.opponent,
    model_prob: candidate.probability,
    market_prob: candidate.market?.probability ?? null,
    edge: candidate.edge,
    price: candidate.market?.best_price ?? null,
    book: candidate.market?.best_book ?? null,
    books: candidate.books,
    publication_scope: scope,
    phase: phase.phase,
    hours_to_kickoff: phase.hours_to_kickoff,
    eligible_pool: decision.pool?.eligible ?? null,
  });
  await auditTarget(env, id, 'td_model_snapshot_locked', selector.version, {
    model_version: MODEL_VERSION,
    selector: SELECTOR_VERSION_TAG,
    lambda: candidate.lambda,
    features: featureVector(candidate, { isPrimary: rank === 'primary', hoursToKickoff: phase.hours_to_kickoff }),
  });
}

/* Every evaluated game gets a row. This is the function that makes "never
 * silently omit a game" true rather than aspirational. */
async function recordEvaluation(env, {
  event, game, phase, selector, scope, outcome, reason = null, decision = null,
  primaryId = null, secondaryId = null, detail = {},
}) {
  const row = {
    market: TD_MARKET,
    event_id: event.id,
    game_id: game.game_id,
    espn_id: game.espn_id ? String(game.espn_id) : null,
    season: game.season,
    week: game.week,
    kickoff_ts: game.kickoff_ts,
    away_team: game.away_team,
    home_team: game.home_team,
    outcome,
    reason: outcome === 'target_issued' ? null : (reason || 'unspecified'),
    primary_pick_id: outcome === 'target_issued' ? primaryId : null,
    secondary_pick_id: outcome === 'target_issued' ? secondaryId : null,
    market_selections: decision?.pool?.market_selections ?? 0,
    eligible_pool: decision?.pool?.eligible ?? 0,
    top_probability: decision?.pool?.top_probability ?? decision?.top_candidate?.probability ?? null,
    selector_version: selector.version,
    publication_scope: scope,
    is_pregame: true,
    detail: {
      phase: phase?.phase ?? null,
      hours_to_kickoff: phase?.hours_to_kickoff ?? null,
      model_version: MODEL_VERSION,
      selector: SELECTOR_VERSION_TAG,
      pool: decision?.pool ?? null,
      floor: decision?.floor ?? null,
      top_candidate: decision?.top_candidate ?? null,
      ranked_preview: decision?.ranked_preview ?? null,
      game_context: decision?.game_context ? publicGameContext(decision.game_context) : null,
      ...detail,
    },
  };
  try {
    await insert(env, 'nfl_td_slate_evaluations', row, { returning: 'minimal' });
  } catch (error) {
    /* Losing the evaluation row must not lose the target that was issued, but
     * it is a real failure and is reported as one. */
    console.error('[td-evaluation] write failed', errorClass(error));
    return { outcome, reason, eligible_pool: row.eligible_pool, top_probability: row.top_probability, evaluation_write_failed: true };
  }
  return { outcome, reason, eligible_pool: row.eligible_pool, top_probability: row.top_probability };
}

function publicGameContext(context) {
  return {
    books: context.books ?? null,
    spread_points: context.spread_points ?? null,
    total: context.total ?? null,
    implied_team_total: context.implied_team_total ?? null,
    implied_team_total_consumed_by_champion: false,
    environment: context.environment ? {
      roof_state: context.environment.roof_state,
      weather_applies: context.environment.weather_applies,
      temp_f: context.environment.temp_f,
      wind_mph: context.environment.wind_mph,
      condition: context.environment.condition,
      precip_probability_pct: context.environment.precip_probability_pct,
      venue: context.environment.venue,
    } : null,
    available: context.available ?? null,
  };
}

/* Pre-kick closing tape, in nfl_prop_closing_snapshots. `point` is null
 * because a binary market has no point, which the table already allows. */
async function captureClosing(env, { id, candidate, event, game, capturedAt }) {
  try {
    await insert(env, 'nfl_prop_closing_snapshots', {
      pick_id: id,
      event_id: event.id,
      player_key: normalizePlayerName(candidate.player_name),
      market: TD_MARKET,
      book: candidate.market.best_book || 'consensus',
      side: 'YES',
      point: null,
      price: candidate.market.best_price,
      opposite_price: candidate.market.opposite_price ?? null,
      observed_at: capturedAt || new Date().toISOString(),
      source: 'nfl-odds pregame snapshot',
    }, { returning: 'minimal' });
  } catch (error) {
    /* A duplicate observation at the same instant is the unique index doing
     * its job; anything else is logged and never aborts the decision. */
    const failure = errorClass(error);
    if (!failure.includes('409')) console.error('[td-closing] write failed', failure);
  }
}

async function auditTarget(env, pickId, eventType, selectorVersion, detail) {
  try {
    await insert(env, 'nfl_prop_pick_audit_events', {
      pick_id: pickId || null,
      event_type: eventType,
      selector_version: selectorVersion ?? null,
      detail: detail || {},
    }, { returning: 'minimal' });
  } catch (error) {
    console.error('[td-audit] failed', errorClass(error));
  }
}

/* ---------------------------------------------------------------- reads */

/* The ONE promoted selector for this market. A challenger is inserted
 * unpromoted and is therefore invisible here, which is the mechanism that
 * stops a challenger publishing. */
async function promotedSelector(env) {
  const rows = await select(
    env,
    'nfl_prop_selector_models',
    `market=eq.${TD_MARKET}&promoted=is.true&select=*&order=version.desc&limit=1`,
  ) || [];
  if (!rows[0]) throw new Error('no_promoted_td_selector');
  return rows[0];
}

function issuanceScope(selector) {
  if (!selector || selector.promoted !== true) throw new Error('td_selector_not_promoted');
  return selector.trained === true ? 'official' : 'tracking';
}

async function openTargets(env, eventId) {
  return await select(
    env,
    'nfl_prop_picks',
    `event_id=eq.${encodeURIComponent(eventId)}&market=eq.${TD_MARKET}&status=eq.open`
      + '&select=id,player_name,player_key,target_rank,publication_scope,model_prob,kickoff_ts,created_at&limit=8',
  ) || [];
}

function currentTeamFor(layer, model, marketName) {
  const key = normalizePlayerName(marketName);
  const gsisId = model?.name_index?.[key];
  const espnId = gsisId ? model?.players?.[gsisId]?.espn_id : null;
  const hit = espnId ? layer.for(espnId) : null;
  return hit?.available === true ? hit.team || null : null;
}

function currentSeasonFor(layer, model, marketName) {
  const key = normalizePlayerName(marketName);
  const gsisId = model?.name_index?.[key];
  const espnId = gsisId ? model?.players?.[gsisId]?.espn_id : null;
  if (!espnId) {
    return { available: false, unavailable_reason: 'no_espn_id_for_this_player_in_the_model_artefact' };
  }
  return layer.for(espnId);
}

function indexWeather(board) {
  const map = new Map();
  for (const game of Array.isArray(board?.games) ? board.games : []) {
    if (game?.event_id) map.set(String(game.event_id), game);
  }
  return map;
}

function indexAvailability(board) {
  const map = new Map();
  for (const team of Array.isArray(board?.teams) ? board.teams : []) {
    const code = String(team?.abbreviation || '').toUpperCase();
    if (!code) continue;
    map.set(code, (Array.isArray(team.injuries) ? team.injuries : []).map(row => ({
      player: row?.player?.name ?? null,
      espn_id: row?.player?.espn_id ?? null,
      position: row?.player?.position ?? null,
      status: row?.status ?? null,
      detail: row?.injury?.label ?? row?.note ?? null,
      team: code,
    })));
  }
  /* The odds feed uses LAR/WSH where nfl-current uses LA/WAS. */
  if (map.has('LAR') && !map.has('LA')) map.set('LA', map.get('LAR'));
  if (map.has('WSH') && !map.has('WAS')) map.set('WAS', map.get('WSH'));
  return map;
}

/* nfl-odds' featured payload can be one event or a list; both shapes are
 * reduced to the one event this game is. */
function featuredEvent(payload, eventId) {
  if (!payload) return null;
  if (payload.id === eventId) return payload;
  for (const key of ['events', 'games', 'data']) {
    const list = payload?.[key];
    if (!Array.isArray(list)) continue;
    const hit = list.find(row => String(row?.id || '') === String(eventId));
    if (hit) return hit;
  }
  return payload?.event?.id === eventId ? payload.event : null;
}

async function bindingJson(binding, host, path, name) {
  if (!binding) throw new Error(`${name}_binding_missing`);
  const response = await binding.fetch(new Request(`https://${host}${path}`, { headers: { accept: 'application/json' } }));
  if (!response.ok) throw new Error(`${name}_service_${response.status}`);
  return response.json();
}
const oddsJson = (env, path) => bindingJson(env.NFL_ODDS, 'nfl-odds.internal', path, 'odds');
const intelJson = (env, path) => bindingJson(env.NFL_INTEL, 'nfl-intel.internal', path, 'intel');
const currentJson = (env, path) => bindingJson(env.NFL_CURRENT, 'nfl-current.internal', path, 'current');

async function oddsMeta(env) {
  const body = await oddsJson(env, '/api/odds/events');
  return { captured_at: body?.captured_at || null, batch_id: body?.batch_id || null };
}

function errorClass(error) {
  return String(error?.message || 'unknown').split(':')[0].slice(0, 80);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export { evaluateGame, issuanceRow, confidenceOf, indexAvailability, featuredEvent, round };
