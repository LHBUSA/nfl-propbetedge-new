/* nfl-game-picks-orchestrator — emits official PBE game picks and serves the
 * read contract for the frontend.
 *
 * Decision rules come from the build brief; immutability and audit rules come
 * from NFL-PICKS-TRACK-RECORD-LEARNING-HANDOFF.md. Two invariants dominate:
 *
 *   1. A pick is written ONCE. Its line, price, features and model_version are
 *      never rewritten because the market later moved. Movement produces a
 *      kill or a supersede, never an edit.
 *   2. Only the highest promoted model version may publish. A challenger can
 *      never reach this code path.
 */

import {
  select, insert, patch, rpc, audit, latestPromotedWeights,
} from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  devigTwoWay, modelProbability, buildFeatureVector,
  confidenceBucket, qualifies, quarterKellyUnits, edgeThreshold,
  probToFairSpread, probToAmerican, KILL_THRESHOLD,
} from '../../nfl-picks-engine-shared/pick-math.mjs';
import {
  isIndoor, venueFor, restDaysBySchedule,
} from '../../nfl-picks-engine-shared/stadiums.mjs';
import { ratingUsable } from '../../nfl-picks-engine-shared/ratings.mjs';
import {
  championPublishable, isTrainedChampion, issuanceScope, isCustomerFacing,
  UNTRAINED_STATE, SCOPE_OFFICIAL, SCOPE_TRACKING,
} from '../../nfl-picks-engine-shared/champion.mjs';

const SERVICE = 'nfl-game-picks-orchestrator';
const VERSION = 'v1.0.0';
const PICK_HORIZON_DAYS = 7;

const health = {
  last_cron_run: null, last_error_class: null, last_result: null,
  engine_state: 'ENGINE WAITING — upcoming slate not ready',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin, env) });
    }

    if (url.pathname === '/health') {
      return json({
        service: SERVICE,
        version: VERSION,
        last_cron_run: health.last_cron_run,
        last_error_class: health.last_error_class,
        last_result: health.last_result,
        engine_state: health.engine_state,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          PICKS_INTERNAL_TOKEN: Boolean(env.PICKS_INTERNAL_TOKEN),
        },
      }, 200, origin, env);
    }

    if (url.pathname === '/v1/picks/current' && req.method === 'GET') {
      return currentPicks(req, env, origin);
    }

    if (url.pathname === '/v1/engine/state' && req.method === 'GET') {
      return engineState(req, env, origin);
    }

    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404, origin, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOrchestration(env));
  },
};

/* ---------------------------------------------------------------------------
 * Read contract
 *
 * Proprietary fields are stripped SERVER-SIDE for anyone without the internal
 * token. A free user never receives edge, sizing, model probability or the
 * feature snapshot — it is not hidden with CSS, it is never sent.
 * ------------------------------------------------------------------------ */

const PUBLIC_FIELDS = [
  'id', 'game_id', 'season', 'week', 'kickoff_ts', 'market', 'side',
  'market_line', 'market_price', 'confidence_bucket', 'model_version',
  'status', 'created_at',
];

const PRO_ONLY_FIELDS = [
  'model_prob', 'market_prob', 'edge_pct', 'stake_units', 'model_line', 'features',
];

function isInternal(req, env) {
  const token = String(env.PICKS_INTERNAL_TOKEN || '').trim();
  if (!token) return false;
  const presented = String(req.headers.get('x-pbe-internal-token') || '').trim();
  if (presented.length !== token.length) return false;
  /* Constant-time-ish compare; lengths already match. */
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

function publicView(pick) {
  const out = {};
  for (const field of PUBLIC_FIELDS) out[field] = pick[field] ?? null;
  return out;
}

function proView(pick) {
  const out = publicView(pick);
  for (const field of PRO_ONLY_FIELDS) out[field] = pick[field] ?? null;
  return out;
}

async function currentPicks(req, env, origin) {
  const full = isInternal(req, env);
  try {
    const { season, week } = await currentSeasonWeek(env);

    /* Customer-facing surfaces filter on publication_scope, NOT on the
     * champion's current trained flag. A bootstrap tracking row must stay
     * excluded even after the model is later trained — the classification at
     * issuance is authoritative. Filtered in the QUERY so tracking rows never
     * reach this Worker's memory, let alone the response. */
    const picks = await select(
      env, 'nfl_game_picks',
      `publication_scope=eq.${SCOPE_OFFICIAL}`
      + `&or=(status.eq.open,and(status.eq.graded,season.eq.${season},week.eq.${week}))`
      + '&select=*&order=kickoff_ts.asc&limit=200',
    ) || [];

    /* Defence in depth: even if the query filter were ever loosened, nothing
     * that is not classified official may be returned. */
    const customerFacing = picks.filter(isCustomerFacing);

    const ids = customerFacing.map(p => `"${p.id}"`).join(',');
    const grades = ids
      ? (await select(env, 'nfl_pick_grades', `pick_id=in.(${ids})&select=*`) || [])
      : [];
    const gradeById = new Map(grades.map(g => [g.pick_id, g]));

    const champion = await latestPromotedWeights(env).catch(() => null);
    const gate = championPublishable(champion);

    const rows = customerFacing.map(pick => {
      const view = full ? proView(pick) : publicView(pick);
      const grade = gradeById.get(pick.id) || null;
      view.grade = grade
        ? {
            result: grade.result,
            units_delta: grade.units_delta,
            clv_beat: grade.clv_beat,
            /* CLV magnitude and Brier are model diagnostics, not public. */
            ...(full ? { clv_points: grade.clv_points, clv_prob: grade.clv_prob, brier: grade.brier } : {}),
          }
        : null;
      return view;
    });

    /* An untrained champion is GATED, never "no qualified picks". Those are
     * different truths: one says the engine may not publish at all, the other
     * says a healthy trained champion evaluated the slate and declined. */
    const engineState = !gate.publishable
      ? gate.state
      : rows.length
        ? 'ENGINE LIVE — picks available'
        : 'ENGINE LIVE — no qualified picks';

    return json({
      service: SERVICE,
      version: VERSION,
      engine_state: engineState,
      publication_blocked_reason: gate.publishable ? null : gate.reason,
      season,
      week,
      model_version: champion?.version ?? null,
      champion_trained: isTrainedChampion(champion),
      /* The Verified Track Record begins at the first official pick. Bootstrap
       * tracking decisions are never part of it. */
      truth: 'verified_live_official_only',
      publication_scope: SCOPE_OFFICIAL,
      entitlement: full ? 'pro' : 'public',
      count: rows.length,
      picks: rows,
    }, 200, origin, env);
  } catch (error) {
    /* A backend failure must never render as "no picks". */
    return json({
      service: SERVICE,
      version: VERSION,
      engine_state: 'ENGINE DEGRADED — source unavailable',
      error_class: errorClass(error),
      picks: null,
    }, 503, origin, env);
  }
}

/* Governance state, from factual backend counts only. */
async function engineState(req, env, origin) {
  try {
    const champion = await latestPromotedWeights(env).catch(() => null);
    const observations = await select(
      env, 'nfl_learning_observations', 'select=week,season&limit=2000',
    ) || [];
    const weeks = new Set(observations.map(o => `${o.season}-${o.week}`));
    const graded = observations.length;
    const trackingSample = observations.filter(o => o.publication_scope === SCOPE_TRACKING).length;
    const officialSample = observations.filter(o => o.publication_scope === SCOPE_OFFICIAL).length;
    const gateOpen = graded >= 100 && weeks.size >= 4;

    return json({
      service: SERVICE,
      version: VERSION,
      champion_version: champion?.version ?? null,
      champion_notes: champion?.notes ?? null,
      champion_trained: isTrainedChampion(champion),
      publication: championPublishable(champion).publishable ? 'ALLOWED' : 'GATED',
      publication_blocked_reason: championPublishable(champion).reason,
      challenger: 'Evaluating',
      auto_tuner: gateOpen ? 'ELIGIBLE' : 'GATED',
      graded_sample: graded,
      graded_sample_required: 100,
      graded_sample_tracking: trackingSample,
      graded_sample_official: officialSample,
      issuance_mode: issuanceScope(champion).mode,
      distinct_weeks: weeks.size,
      distinct_weeks_required: 4,
    }, 200, origin, env);
  } catch (error) {
    return json({ engine_state: 'ENGINE DEGRADED — source unavailable', error_class: errorClass(error) },
      503, origin, env);
  }
}

/* ---------------------------------------------------------------------------
 * Orchestration
 * ------------------------------------------------------------------------ */

async function runOrchestration(env) {
  health.last_cron_run = new Date().toISOString();
  try {
    const champion = await latestPromotedWeights(env);

    /* ISSUANCE SCOPE. Decided from the champion row's own state before any
     * slate work. An untrained champion still evaluates real slates and
     * persists real pregame decisions, but as `tracking` — never as an
     * official customer-facing pick. */
    const issuance = issuanceScope(champion);
    health.champion_version = champion?.version ?? null;
    health.champion_trained = isTrainedChampion(champion);
    health.issuance_mode = issuance.mode;
    health.issuance_scope = issuance.scope;
    health.publication_blocked_reason = issuance.reason;

    if (!issuance.canIssue) {
      health.engine_state = issuance.state;
      health.last_result = `issuance_blocked:${issuance.reason}`;
      health.last_error_class = null;
      console.log(`[${SERVICE}] issuance blocked ${issuance.reason} — emitting nothing`);
      return;
    }

    const { season, week } = await currentSeasonWeek(env);
    const games = await upcomingGames(env);

    if (!games.length) {
      health.engine_state = 'ENGINE WAITING — upcoming slate not ready';
      health.last_result = 'no_upcoming_games';
      health.last_error_class = null;
      return;
    }

    const ratings = await teamRatings(env, season);
    const rest = await restDays(env);
    let emitted = 0, killed = 0, superseded = 0, kept = 0, ratingsBlocked = 0, scopeDrain = 0;
    const blockedReasons = new Set();

    for (const game of games) {
      /* Rest is derived from the full schedule, not the 7-day window, so a
       * team's previous game is visible even when it falls outside it. */
      const gameRest = rest.get(game.game_id) || {};
      game.rest_home = gameRest[game.home_team] ?? 7;
      game.rest_away = gameRest[game.away_team] ?? 7;

      const odds = await latestOddsFor(env, game.game_id);
      if (!odds.size) continue;
      const weather = await weatherFor(game);

      for (const market of ['spread', 'total', 'moneyline']) {
        const quotes = odds.get(market);
        if (!quotes || !quotes.length) continue;

        /* Evaluate BOTH sides and take the strongest qualifying edge. If
         * neither qualifies we still pass the best one through so an existing
         * open pick can be killed on a collapsed edge. */
        const evaluated = quotes.map(quote =>
          evaluate({ game, market, quote, ratings, weather, champion, season, week }));
        const decision = evaluated
          .slice()
          .sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || b.edge_pct - a.edge_pct)[0];

        /* Ratings unavailable: make NO decision. Not an emit, and not a kill
         * either — killing an open pick because we lost our inputs would be a
         * model decision we did not actually make. */
        if (decision.ratings_available === false) {
          ratingsBlocked += 1;
          blockedReasons.add(decision.unavailable_reason);
          continue;
        }

        const open = await openPickFor(env, game.game_id, market);
        const result = await reconcile(env, {
          open, decision, champion, game, market, season, week,
          scope: issuance.scope,
        });

        emitted += result.emitted; killed += result.killed;
        superseded += result.superseded; kept += result.kept;
        scopeDrain += result.scope_drain || 0;
      }
    }

    /* A slate blocked entirely by missing ratings is DEGRADED, not "no
     * qualified picks". Those are different truths and must not be conflated:
     * one says the model looked and declined, the other says it could not
     * look at all. */
    /* Three distinct internal truths, never conflated:
     *   - source degradation  : we could not evaluate
     *   - bootstrap tracking  : we evaluated, but the model may not publish
     *   - genuinely zero      : a trained champion evaluated and declined
     * "no qualified picks" is reserved for the last case alone. */
    if (ratingsBlocked > 0 && !emitted && !kept) {
      health.engine_state = 'ENGINE DEGRADED — source unavailable';
    } else if (issuance.scope === SCOPE_TRACKING) {
      health.engine_state = UNTRAINED_STATE;
    } else if (emitted || kept) {
      health.engine_state = 'ENGINE LIVE — picks available';
    } else {
      health.engine_state = 'ENGINE LIVE — no qualified picks';
    }

    health.ratings_blocked = ratingsBlocked;
    health.ratings_blocked_reasons = [...blockedReasons].slice(0, 5);
    health.last_result =
      `scope=${issuance.scope} emitted=${emitted} kept=${kept} killed=${killed}`
      + ` superseded=${superseded} ratings_blocked=${ratingsBlocked}`
      + ` scope_drain=${scopeDrain}`;
    health.tracking_only = issuance.scope === SCOPE_TRACKING;
    health.last_error_class = null;
  } catch (error) {
    health.engine_state = 'ENGINE DEGRADED — source unavailable';
    health.last_error_class = errorClass(error);
    console.error(`[${SERVICE}] orchestration failed class=${health.last_error_class}`);
  }
}

/* Pure decision step — exported so acceptance tests can drive it with fixtures
 * and no network. */
export function evaluate({ game, market, quote, ratings, weather, champion, season, week }) {
  /* HARD REQUIREMENT: a missing rating must never become a neutral 0 feature.
   * Both teams must carry an explicitly usable rating or no decision is made
   * at all — the caller receives ratings_unavailable and emits nothing. */
  const homeRating = ratings.get(game.home_team);
  const awayRating = ratings.get(game.away_team);
  const homeCheck = ratingUsable(homeRating);
  const awayCheck = ratingUsable(awayRating);

  if (!homeCheck.usable || !awayCheck.usable) {
    return {
      qualifies: false,
      ratings_available: false,
      unavailable_reason: !homeCheck.usable
        ? `${game.home_team}:${homeCheck.reason}`
        : `${game.away_team}:${awayCheck.reason}`,
      side: quote.side,
      edge_pct: 0,
      stake_units: 0,
      confidence_bucket: null,
      features: null,
      selection_team: quote.team ?? null,
      selection_over_under: quote.over_under ?? null,
      side_is_home: quote.selected_is_home === true ? true
        : quote.selected_is_home === false ? false : null,
    };
  }

  const home = homeRating;
  const away = awayRating;
  const dome = isIndoor(game.home_team);

  /* Features are built for the side the quote actually describes. `home` is 1
   * only when the selected side IS the home team — attribution comes from the
   * stored snapshot, never assumed. A total has no team, so it is scored from
   * the home team's perspective with home=0. */
  const selectedIsHome = quote.selected_is_home === true;
  const isTeamMarket = market !== 'total';
  const self = isTeamMarket ? (selectedIsHome ? home : away) : home;
  const opp = isTeamMarket ? (selectedIsHome ? away : home) : away;
  const restSelf = isTeamMarket
    ? (selectedIsHome ? game.rest_home : game.rest_away)
    : game.rest_home;
  const restOpp = isTeamMarket
    ? (selectedIsHome ? game.rest_away : game.rest_home)
    : game.rest_away;

  const features = buildFeatureVector({
    off_epa_diff: num(self.off_epa_play) - num(opp.def_epa_play),
    def_epa_diff: num(opp.off_epa_play) - num(self.def_epa_play),
    qb_tier_diff: num(opp.qb_tier) - num(self.qb_tier),
    rest_diff: num(restSelf) - num(restOpp),
    home: isTeamMarket && selectedIsHome,
    dome,
    wind15: !dome && weather?.wind_mph >= 15,
    cold25: !dome && weather?.temp_f <= 25,
    proe_diff: num(self.proe) - num(opp.proe),
    pace_sum: num(self.pace) + num(opp.pace),
    line_move: num(quote.line_move),
    week,
  });

  const bucketProbe = modelProbability(champion.weights, features);
  const provisionalBucket = confidenceBucket(Math.abs(bucketProbe - 0.5), market) || 'C';
  const modelProb = modelProbability(champion.weights, features, provisionalBucket);

  const marketProb = devigTwoWay(quote.price, quote.opposite_price);
  const edge = Number((modelProb - marketProb).toFixed(6));
  const bucket = confidenceBucket(edge, market);

  const modelLine = market === 'spread'
    ? Number(probToFairSpread(modelProb).toFixed(2))
    : market === 'total'
      ? (quote.line === null || quote.line === undefined ? null : Number(quote.line))
      : Number(probToAmerican(modelProb));

  return {
    qualifies: qualifies(edge, market) && bucket !== null,
    ratings_available: true,
    unavailable_reason: null,
    side: quote.side,
    /* Canonical attribution straight from the odds quote. Never re-derived
     * from the display string, which changes when the line moves. */
    selection_team: isTeamMarket ? (quote.team ?? null) : null,
    selection_over_under: isTeamMarket ? null : (quote.over_under ?? null),
    side_is_home: isTeamMarket ? selectedIsHome : null,
    market_line: quote.line ?? null,
    market_price: quote.price,
    model_line: modelLine,
    model_prob: Number(modelProb.toFixed(6)),
    market_prob: Number(marketProb.toFixed(6)),
    edge_pct: edge,
    confidence_bucket: bucket,
    stake_units: bucket ? quarterKellyUnits(modelProb, quote.price) : 0,
    features,
    kickoff_ts: game.kickoff_ts,
    season,
    week,
  };
}

/* Lifecycle. This is the only place a pick's status changes, and it never
 * edits an issued pick's economic terms. */
async function reconcile(env, { open, decision, champion, game, market, season, week, scope }) {
  const tally = { emitted: 0, killed: 0, superseded: 0, kept: 0, scope_drain: 0 };

  const issuanceRow = {
    game_id: game.game_id,
    season, week,
    kickoff_ts: decision.kickoff_ts,
    market,
    side: decision.side,
    market_line: decision.market_line,
    market_price: decision.market_price,
    model_line: decision.model_line,
    model_prob: decision.model_prob,
    market_prob: decision.market_prob,
    edge_pct: decision.edge_pct,
    stake_units: decision.stake_units,
    confidence_bucket: decision.confidence_bucket,
    features: decision.features,
    model_version: champion.version,
    publication_scope: scope,
    /* Canonical attribution, persisted at issuance and frozen by the database.
     * Grading reads these, never the display string. */
    selection_team: decision.selection_team,
    selection_over_under: decision.selection_over_under,
    side_is_home: decision.side_is_home,
    status: 'open',
  };

  async function auditIssuance(pickId) {
    await audit(env, {
      pick_id: pickId, event_type: 'pick_created', model_version: champion.version,
      detail: {
        market, side: decision.side, edge_pct: decision.edge_pct,
        publication_scope: scope,
        selection_team: decision.selection_team,
        selection_over_under: decision.selection_over_under,
        side_is_home: decision.side_is_home,
      },
    });
    await audit(env, {
      pick_id: pickId, event_type: 'features_locked', model_version: champion.version,
      detail: { features: decision.features },
    });
    await audit(env, {
      pick_id: pickId, event_type: 'issuance_market_state', model_version: champion.version,
      detail: {
        line: decision.market_line, price: decision.market_price,
        market_prob: decision.market_prob,
      },
    });
  }

  if (!open) {
    if (!decision.qualifies || decision.stake_units <= 0) return tally;
    const row = await insert(env, 'nfl_game_picks', issuanceRow);
    const pickId = Array.isArray(row) ? row[0]?.id : row?.id;
    await auditIssuance(pickId);
    tally.emitted = 1;
    return tally;
  }

  /* SCOPE TRANSITION — "bootstrap drain".
   *
   * one_open_pick_per_market is scope-agnostic, so an open tracking decision
   * and an open official decision cannot coexist for the same (game_id,
   * market). When the champion becomes trained, the incumbent tracking
   * decision is deliberately LEFT ALONE: it stays open, plays out, and is
   * graded, which preserves the learning observation that earned the gate.
   *
   * It is never superseded by the official pick (that would destroy the
   * observation) and never reclassified (the database forbids it). Official
   * issuance simply begins with the next (game_id, market) that has no open
   * tracking decision — normally the following week.
   */
  if (open.publication_scope && open.publication_scope !== scope) {
    tally.scope_drain = 1;
    return tally;
  }

  const sideFlipped = decision.side && decision.side !== open.side;

  if (sideFlipped && decision.qualifies && decision.stake_units > 0) {
    /* Atomic: the function supersedes the incumbent and inserts the
     * replacement in one transaction, so the partial unique index never sees
     * two open rows. Doing this as two PostgREST calls conflicts. */
    const newId = await rpc(env, 'nfl_replace_open_pick', {
      p_open_id: open.id,
      p_game_id: issuanceRow.game_id,
      p_season: issuanceRow.season,
      p_week: issuanceRow.week,
      p_kickoff_ts: issuanceRow.kickoff_ts,
      p_market: issuanceRow.market,
      p_side: issuanceRow.side,
      p_market_line: issuanceRow.market_line,
      p_market_price: issuanceRow.market_price,
      p_model_line: issuanceRow.model_line,
      p_model_prob: issuanceRow.model_prob,
      p_market_prob: issuanceRow.market_prob,
      p_edge_pct: issuanceRow.edge_pct,
      p_stake_units: issuanceRow.stake_units,
      p_confidence_bucket: issuanceRow.confidence_bucket,
      p_features: issuanceRow.features,
      p_model_version: issuanceRow.model_version,
      p_publication_scope: issuanceRow.publication_scope,
      p_selection_team: issuanceRow.selection_team,
      p_selection_over_under: issuanceRow.selection_over_under,
      p_side_is_home: issuanceRow.side_is_home,
    });
    await auditIssuance(newId);
    await audit(env, {
      pick_id: open.id, event_type: 'pick_superseded', model_version: champion.version,
      detail: { superseded_by: newId, from_side: open.side, to_side: decision.side },
    });
    tally.superseded = 1; tally.emitted = 1;
    return tally;
  }

  if (!decision.qualifies && decision.edge_pct < KILL_THRESHOLD) {
    await patch(env, 'nfl_game_picks', `id=eq.${open.id}`, { status: 'killed' });
    await audit(env, {
      pick_id: open.id, event_type: 'pick_killed', model_version: champion.version,
      detail: { reason: 'edge_collapsed', edge_pct: decision.edge_pct },
    });
    tally.killed = 1;
    return tally;
  }

  /* Still qualified and same side: leave the original pick exactly as issued.
   * Re-emitting at a better number would be rewriting history. */
  tally.kept = 1;
  return tally;
}

/* ---------------------------------------------------------------------------
 * Inputs
 * ------------------------------------------------------------------------ */

async function openPickFor(env, gameId, market) {
  const rows = await select(
    env, 'nfl_game_picks',
    `game_id=eq.${encodeURIComponent(gameId)}&market=eq.${market}&status=eq.open&select=*&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function restDays(env) {
  const base = String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
  const response = await fetch(`${base}/api/schedule`, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`gateway_${response.status}`);
  const body = await response.json();
  return restDaysBySchedule(Array.isArray(body?.games) ? body.games : []);
}

async function teamRatings(env, season) {
  const rows = await select(
    env, 'nfl_team_ratings',
    `season=eq.${season}&select=*&order=as_of_week.desc&limit=600`,
  ) || [];
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.team)) latest.set(row.team, row);
  return latest;
}

async function currentSeasonWeek(env) {
  const base = String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
  const response = await fetch(`${base}/api/schedule`, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`gateway_${response.status}`);
  const body = await response.json();
  const games = Array.isArray(body?.games) ? body.games : [];
  const now = Date.now();
  const next = games
    .map(g => ({ ...g, ts: Date.parse(`${g.gameday}T${g.gametime || '00:00'}:00Z`) }))
    .filter(g => Number.isFinite(g.ts) && g.ts >= now)
    .sort((a, b) => a.ts - b.ts)[0];
  return {
    season: Number(body?.season || next?.season || new Date().getUTCFullYear()),
    week: Number(next?.week || 1),
  };
}

async function upcomingGames(env) {
  const base = String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
  const response = await fetch(`${base}/api/schedule`, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`gateway_${response.status}`);
  const body = await response.json();
  const games = Array.isArray(body?.games) ? body.games : [];
  const now = Date.now();
  const horizon = now + PICK_HORIZON_DAYS * 86400000;

  return games
    .map(g => {
      const ts = Date.parse(`${g.gameday}T${g.gametime || '00:00'}:00Z`);
      return { ...g, ts, kickoff_ts: Number.isFinite(ts) ? new Date(ts).toISOString() : null };
    })
    .filter(g => Number.isFinite(g.ts) && g.ts >= now && g.ts <= horizon);
}

/* Latest snapshot per market for a game, paired with its opposite side so the
 * price can be de-vigged. */
async function latestOddsFor(env, gameId) {
  const rows = await select(
    env, 'nfl_odds_snapshots',
    `game_id=eq.${encodeURIComponent(gameId)}&select=*&order=captured_at.desc&limit=300`,
  ) || [];

  const byMarket = new Map();
  for (const row of rows) {
    if (!byMarket.has(row.market)) byMarket.set(row.market, []);
    byMarket.get(row.market).push(row);
  }

  /* Returns EVERY current side per market, each with its true home/away
   * attribution as recorded at capture time. The caller evaluates both sides
   * and lets the edge decide — there is no default side and no assumption
   * that the selection is the home team. */
  const out = new Map();
  for (const [market, list] of byMarket) {
    const newest = list[0]?.captured_at;
    const current = list.filter(r => r.captured_at === newest);
    if (current.length < 2) continue;

    const quotes = [];
    for (const row of current) {
      const opposite = current.find(r => otherSide(market, row, r));
      if (!opposite) continue;

      /* Line movement for THIS side: oldest observation of the same
       * selection, compared to now. */
      const history = list.filter(r => sameSelection(market, r, row));
      const oldest = history[history.length - 1];
      const lineMove = Number.isFinite(Number(row.line)) && Number.isFinite(Number(oldest?.line))
        ? Number(row.line) - Number(oldest.line)
        : 0;

      quotes.push({
        side: row.side,
        line: row.line,
        price: row.price,
        opposite_price: opposite.price,
        line_move: lineMove,
        /* Attribution comes from the stored column, never from position.
         * Totals carry null, which the feature builder treats as not-home. */
        selected_is_home: row.is_home === true,
        team: row.team,
        over_under: row.over_under,
        book: row.book,
      });
    }
    if (quotes.length) out.set(market, quotes);
  }
  return out;
}

function sameSelection(market, a, b) {
  return market === 'total' ? a.over_under === b.over_under : a.team === b.team;
}

function otherSide(market, a, b) {
  return market === 'total'
    ? Boolean(a.over_under && b.over_under && a.over_under !== b.over_under)
    : Boolean(a.team && b.team && a.team !== b.team);
}

/* Open-Meteo needs no API key. It is a NEW external dependency, distinct from
 * the odds provider the brief told us not to duplicate. If it is unavailable
 * the weather features degrade to 0 rather than blocking a pick, and the
 * feature snapshot records exactly the zeros that were used. */
async function weatherFor(game) {
  if (isIndoor(game.home_team)) return { wind_mph: 0, temp_f: 60, source: 'roofed' };
  try {
    const venue = venueFor(game.home_team);
    if (!venue) return null;
    const { lat, lon } = venue;
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${lat}&longitude=${lon}`
      + '&hourly=temperature_2m,wind_speed_10m&temperature_unit=fahrenheit'
      + '&wind_speed_unit=mph&forecast_days=8';
    const response = await fetch(url, { cf: { cacheTtl: 1800 } });
    if (!response.ok) return null;
    const body = await response.json();
    const idx = nearestHourIndex(body?.hourly?.time, game.kickoff_ts);
    if (idx < 0) return null;
    return {
      wind_mph: Number(body.hourly.wind_speed_10m?.[idx] ?? 0),
      temp_f: Number(body.hourly.temperature_2m?.[idx] ?? 60),
      source: 'open-meteo',
    };
  } catch (_) {
    return null;
  }
}

function nearestHourIndex(times, kickoffIso) {
  if (!Array.isArray(times) || !kickoffIso) return -1;
  const target = Date.parse(kickoffIso);
  let best = -1, bestDiff = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const diff = Math.abs(Date.parse(times[i]) - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errorClass(error) {
  return String(error?.message || 'unknown').split(':')[0].slice(0, 60);
}

function cors(origin, env) {
  const app = String(env?.APP_ORIGIN || 'https://nfl.propbetedge.ai').replace(/\/$/, '');
  return {
    'access-control-allow-origin': !origin || origin === app ? app : 'null',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'content-type,x-pbe-internal-token',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(body, status = 200, origin = '', env = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...cors(origin, env),
    },
  });
}
