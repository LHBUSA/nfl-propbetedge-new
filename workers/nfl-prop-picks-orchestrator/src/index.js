/* nfl-prop-picks-orchestrator — Algorithm #2: governed NFL player props.
 * v1 supports player_pass_yds only. Projection authority stays upstream.
 *
 * Inputs, all read-only and none of them a paid provider call:
 *   nfl-current  (service binding)  season, week, REAL kickoff, game state
 *   nfl-odds     (service binding)  the scheduled 3x/day market snapshot:
 *                                   events + per-event player_pass_yds board
 *   /api/picks/pass (gateway)       production passing projection (fair line +
 *                                   predictive SD), itself built on nfl-odds reads
 *
 * The previous design read events, boards and line movement from
 * pbe-nfl-intelligence — a separate product Worker that holds its OWN odds key
 * and calls the provider on every board request. Picks never touch it now.
 *
 * Pre-kick closing quotes for prop decisions are recorded by nfl-odds-snapshot,
 * the single market-tape owner.
 *
 * One cron (every 15 min). The Worker decides from nfl-current game state and
 * the market batch whether a tick evaluates: every 15 min when a game is inside
 * the locked window, hourly on game day, every 6h otherwise, and always when a
 * new market batch lands.
 */
import { select, insert, patch, rpc } from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  PROP_MARKET, PROP_KILL_EDGE_DEFAULT, playerKey, pairCurrentQuotes,
  evaluatePropQuote, selectorFeatures,
} from '../../nfl-prop-picks-shared/prop-math.mjs';
import { teamCodeFromName } from '../../nfl-picks-engine-shared/odds-normalize.mjs';
import {
  loadSlate, issuable, matchGameForEvent, cadenceDecision,
} from '../../nfl-picks-engine-shared/current-slate.mjs';
import {
  recordRun, readLane, laneHealth, lastWorkRecord,
} from '../../nfl-picks-engine-shared/runs.mjs';

const SERVICE = 'nfl-prop-picks-orchestrator';
const VERSION = 'v1.2.0';
const HORIZON_HOURS = 36;
const MAX_EVENTS = 16;
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
        market: PROP_MARKET,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          NFL_GATEWAY: Boolean(env.NFL_GATEWAY),
          NFL_ODDS_BINDING: Boolean(env.NFL_ODDS),
          NFL_CURRENT_BINDING: Boolean(env.NFL_CURRENT),
          PICKS_KV_BINDING: Boolean(env.PICKS_KV),
        },
      });
    }
    if (url.pathname === '/v1/engine/state' && req.method === 'GET') return engineState(env);
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledTick(env, event));
  },
};

async function engineState(env) {
  try {
    const selector = await latestSelector(env);
    const observations = await select(
      env,
      'nfl_prop_learning_observations',
      `market=eq.${PROP_MARKET}&is_final=eq.true&select=season,week,publication_scope&limit=5000`,
    ) || [];
    const weeks = new Set(observations.map(row => `${row.season}-${row.week}`));
    return json({
      service: SERVICE,
      version: VERSION,
      market: PROP_MARKET,
      selector_version: selector.version,
      projection_model: selector.projection_model,
      selector_trained: selector.trained === true,
      selector_promoted: selector.promoted === true,
      selector_notes: selector.notes ?? null,
      issuance_mode: selector.trained === true ? 'OFFICIAL' : 'TRACKING_BOOTSTRAP',
      publication: selector.trained === true ? 'ALLOWED' : 'GATED',
      finalized_sample: observations.length,
      finalized_tracking: observations.filter(row => row.publication_scope === 'tracking').length,
      finalized_official: observations.filter(row => row.publication_scope === 'official').length,
      distinct_weeks: weeks.size,
      truth: 'player_prop_official_only_customer_record',
    });
  } catch (error) {
    return json({
      engine_state: 'PROP ENGINE DEGRADED — source unavailable',
      error_class: errorClass(error),
    }, 503);
  }
}

/* Locked-window aware: the passing-yards selector only issues >= 12h or
 * <= 4h before kickoff, so "near kickoff" for this lane means the locked
 * window has opened (4h), not the game engine's 3h. */
async function scheduledTick(env, event) {
  const startedAt = new Date();
  const base = { version: VERSION, cron: event?.cron || null, started_at: startedAt.toISOString() };
  let slate, meta;
  try {
    [slate, meta] = await Promise.all([loadSlate(env), oddsMeta(env)]);
  } catch (error) {
    await recordRun(env, SERVICE, { ...base, status: 'degraded', reason: 'inputs_unavailable', error_class: errorClass(error) });
    return;
  }
  const last = await lastWorkRecord(env, SERVICE);
  const lastBatch = last?.source_freshness?.market_captured_at || null;
  const nowMs = startedAt.getTime();
  const lockedOpen = slate.games.some(g => g.state === 'SCHEDULE'
    && g.kickoff_ms - nowMs > 0 && g.kickoff_ms - nowMs <= 4 * 3600000 + 15 * 60000);
  const decision = cadenceDecision({
    games: slate.games,
    nowMs,
    lastWorkMs: Date.parse(last?.finished_at || '') || null,
    newTape: Boolean(meta.captured_at && lastBatch && Date.parse(meta.captured_at) > Date.parse(lastBatch)),
  });
  const go = decision.go || (lockedOpen && nowMs - (Date.parse(last?.finished_at || '') || 0) >= 13 * 60000);
  if (!go) {
    await recordRun(env, SERVICE, {
      ...base, status: 'skipped', reason: decision.reason,
      detail: { public: { tier: decision.tier } },
      source_freshness: { market_captured_at: meta.captured_at, current_state_updated: slate.last_updated },
    });
    return;
  }
  await runOrchestration(env, slate, meta, { ...base, tier: lockedOpen ? 'locked_window' : decision.tier });
}

async function runOrchestration(env, slate, meta, base) {
  const count = {
    events_in_horizon: 0, evaluated_events: 0, schedule_skip: 0, no_board: 0, stale_board: 0,
    projection_skip: 0, projections: 0, quotes_paired: 0, decisions_evaluated: 0,
    emitted: 0, kept: 0, killed: 0, superseded: 0, pass: 0, scope_drain: 0,
  };
  const passReasons = {};
  const coverage = [];
  const privateEval = [];
  let scope = null;
  try {
    const selector = await latestSelector(env);
    scope = issuanceScope(selector);

    const eventsBody = await oddsJson(env, '/api/odds/events');
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
       * provider no longer calls scheduled is never evaluated. */
      const game = matchGameForEvent(slate.games, {
        away: teamCodeFromName(event.away_team),
        home: teamCodeFromName(event.home_team),
        commenceMs: event.ts,
      });
      if (!game || !issuable(game, now, HORIZON_HOURS * 3600000)) {
        count.schedule_skip += 1;
        continue;
      }
      const context = { season: game.season, week: game.week, kickoff_ts: game.kickoff_ts };
      const row = { game_id: game.game_id, matchup: `${game.away_team} @ ${game.home_team}`, kickoff_ts: game.kickoff_ts };
      coverage.push(row);

      const board = await oddsJson(env,
        `/api/odds/board?event_id=${encodeURIComponent(event.id)}&markets=${encodeURIComponent(PROP_MARKET)}`)
        .catch(() => null);
      const tape = tapeFromBoard(board);
      row.board_captured_at = tape.captured_at;
      if (!tape.rows.length) { count.no_board += 1; row.coverage = 'no_board'; continue; }
      if (!tape.captured_at || now - Date.parse(tape.captured_at) > BOARD_MAX_AGE_MS) {
        count.stale_board += 1; row.coverage = 'stale_board'; continue;
      }

      const model = await getJson(
        `${gatewayBase(env)}/api/picks/pass?event_id=${encodeURIComponent(event.id)}`,
      ).catch(() => null);
      const projections = projectionRows(model);
      if (!projections.length) {
        count.projection_skip += 1; row.coverage = 'no_projection'; continue;
      }
      count.evaluated_events += 1;
      count.projections += projections.length;
      row.coverage = 'evaluated';
      row.projections = projections.length;

      const paired = pairCurrentQuotes(tape.rows);
      count.quotes_paired += paired.length;
      const byPlayer = groupPairedQuotes(paired);
      for (const projection of projections) {
        const pKey = playerKey(playerOf(projection));
        if (!pKey) continue;
        const quotes = byPlayer.get(pKey) || [];
        if (!quotes.length) { passReasons.no_two_way_quote = (passReasons.no_two_way_quote || 0) + 1; continue; }

        const bookCount = new Set(
          quotes.map(q => String(q.book || '').toLowerCase()).filter(Boolean),
        ).size;
        const all = quotes.map(quote => evaluatePropQuote({
          projection,
          quote,
          bookCount,
          selector,
          kickoffTs: context.kickoff_ts,
          nowMs: now,
        }));
        count.decisions_evaluated += all.length;
        const decision = all
          .filter(r => r.available)
          .sort((a, b) => Number(b.qualifies) - Number(a.qualifies)
            || Number(b.ev_pct || 0) - Number(a.ev_pct || 0)
            || Number(b.edge_pct || 0) - Number(a.edge_pct || 0))[0];
        if (!decision) {
          const reason = all[0]?.unavailable_reason || 'unavailable';
          passReasons[reason] = (passReasons[reason] || 0) + 1;
          privateEval.push({ game_id: game.game_id, player: playerOf(projection), outcome: 'unavailable', reason, hours_to_kickoff: all[0]?.hours_to_kickoff ?? null });
          continue;
        }

        decision.projection_model_version = modelVersion(model);
        decision.model_snapshot = sanitizedSnapshot({ projection, decision, selector, event, context, game });

        const open = await openPickFor(env, event.id, pKey);
        const result = await reconcile(env, { open, decision, selector, context, event, scope });
        for (const key of ['emitted', 'kept', 'killed', 'superseded', 'scope_drain']) count[key] += result[key];
        const outcome = result.superseded ? 'superseded' : result.emitted ? 'emitted'
          : result.killed ? 'killed' : result.kept ? 'kept' : result.scope_drain ? 'scope_drain' : 'pass';
        if (outcome === 'pass') {
          count.pass += 1;
          const reason = decision.qualifies ? 'stake_zero'
            : decision.book_count < Number(selector?.config?.min_books ?? 4) ? 'insufficient_books'
              : 'below_edge_or_ev_threshold';
          passReasons[reason] = (passReasons[reason] || 0) + 1;
        }
        privateEval.push({
          game_id: game.game_id, player: decision.player_name, outcome, side: decision.side, book: decision.book,
          line: decision.market_line, edge_pct: decision.edge_pct, ev_pct: decision.ev_pct, phase: decision.phase,
          book_count: decision.book_count, qualifies: decision.qualifies,
        });
      }
    }

    const engineState = scope === 'tracking'
      ? 'PROP ENGINE GATED — MODEL VALIDATION IN PROGRESS'
      : count.emitted || count.kept
        ? 'PROP ENGINE LIVE — picks available'
        : 'PROP ENGINE LIVE — no qualified player props';
    const couldNotLook = count.events_in_horizon > 0 && count.evaluated_events === 0
      && (count.no_board + count.stale_board + count.projection_skip) > 0;

    try {
      await env.PICKS_KV?.put(`eval:last:${SERVICE}`, JSON.stringify({ at: new Date().toISOString(), scope, decisions: privateEval }),
        { expirationTtl: 30 * 86400 });
    } catch (_) { /* the ledger write below still records the run */ }

    await recordRun(env, SERVICE, {
      ...base,
      status: couldNotLook ? 'degraded' : 'ok',
      reason: couldNotLook ? 'inputs_unavailable_for_every_event' : `scope=${scope}`,
      counts: count,
      source_freshness: { market_captured_at: meta.captured_at, market_batch_id: meta.batch_id, current_state_updated: slate.last_updated },
      detail: {
        public: {
          tier: base.tier, engine_state: engineState, market: PROP_MARKET,
          pass_reasons: passReasons,
          events: coverage.map(c => ({ game_id: c.game_id, matchup: c.matchup, kickoff_ts: c.kickoff_ts, board_captured_at: c.board_captured_at || null, coverage: c.coverage || null, projections: c.projections || 0 })),
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

async function reconcile(env, { open, decision, selector, context, event, scope }) {
  const tally = { emitted: 0, kept: 0, killed: 0, superseded: 0, scope_drain: 0 };
  const config = selector.config || {};
  const issuance = {
    event_id: event.id,
    season: context.season,
    week: context.week,
    kickoff_ts: context.kickoff_ts,
    player_name: decision.player_name,
    player_key: decision.player_key,
    market: PROP_MARKET,
    side: decision.side,
    book: decision.book,
    book_key: null,
    market_line: decision.market_line,
    market_price: decision.market_price,
    opposite_price: decision.opposite_price,
    model_fair_line: decision.model_fair_line,
    predictive_sd: decision.predictive_sd,
    model_prob: decision.model_prob,
    market_prob: decision.market_prob,
    edge_pct: decision.edge_pct,
    ev_pct: decision.ev_pct,
    stake_units: decision.stake_units,
    confidence_bucket: decision.confidence_bucket,
    projection_model_version: decision.projection_model_version,
    selector_version: selector.version,
    phase: decision.phase,
    publication_scope: scope,
    status: 'open',
    model_snapshot: decision.model_snapshot,
  };

  if (!open) {
    if (!decision.qualifies || decision.stake_units <= 0) return tally;
    const row = await insert(env, 'nfl_prop_picks', issuance);
    const pickId = Array.isArray(row) ? row[0]?.id : row?.id;
    await auditIssuance(env, pickId, decision, selector.version, scope);
    tally.emitted = 1;
    return tally;
  }

  if (open.publication_scope !== scope) {
    tally.scope_drain = 1;
    return tally;
  }

  if (decision.side !== open.side && decision.qualifies && decision.stake_units > 0) {
    const newId = await rpc(env, 'nfl_replace_open_prop_pick', rpcArgs(open.id, issuance));
    await auditProp(env, open.id, 'prop_pick_superseded', selector.version, {
      superseded_by: newId,
      from_side: open.side,
      to_side: decision.side,
    });
    await auditIssuance(env, newId, decision, selector.version, scope);
    tally.superseded = 1;
    tally.emitted = 1;
    return tally;
  }

  // Missing book depth is not a model reversal. Only a factual collapse in
  // edge OR negative expected value can kill an already-issued decision.
  if (decision.book_count < finite(config.min_books, 4)) return tally;
  const killEdge = finite(config.kill_edge, PROP_KILL_EDGE_DEFAULT);
  const killEv = finite(config.kill_ev_pct, 0);
  if (!decision.qualifies && (decision.edge_pct < killEdge || decision.ev_pct < killEv)) {
    await patch(env, 'nfl_prop_picks', `id=eq.${open.id}`, {
      status: 'killed',
      closed_at: new Date().toISOString(),
    });
    await auditProp(env, open.id, 'prop_pick_killed', selector.version, {
      reason: decision.edge_pct < killEdge ? 'edge_collapsed' : 'expected_value_negative',
      edge_pct: decision.edge_pct,
      ev_pct: decision.ev_pct,
    });
    tally.killed = 1;
    return tally;
  }

  tally.kept = 1;
  return tally;
}

function rpcArgs(openId, row) {
  return {
    p_open_id: openId,
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
    p_market_line: row.market_line,
    p_market_price: row.market_price,
    p_opposite_price: row.opposite_price,
    p_model_fair_line: row.model_fair_line,
    p_predictive_sd: row.predictive_sd,
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
    p_model_snapshot: row.model_snapshot,
  };
}

async function auditIssuance(env, pickId, decision, selectorVersion, scope) {
  await auditProp(env, pickId, 'prop_pick_created', selectorVersion, {
    market: PROP_MARKET,
    side: decision.side,
    player_key: decision.player_key,
    book: decision.book,
    line: decision.market_line,
    price: decision.market_price,
    edge_pct: decision.edge_pct,
    ev_pct: decision.ev_pct,
    phase: decision.phase,
    publication_scope: scope,
  });
  await auditProp(env, pickId, 'prop_model_snapshot_locked', selectorVersion, {
    projection_model_version: decision.projection_model_version,
    model_prob: decision.model_prob,
    market_prob: decision.market_prob,
    model_fair_line: decision.model_fair_line,
    predictive_sd: decision.predictive_sd,
  });
}

async function latestSelector(env) {
  const rows = await select(
    env,
    'nfl_prop_selector_models',
    `market=eq.${PROP_MARKET}&promoted=is.true&select=*&order=version.desc&limit=1`,
  ) || [];
  if (!rows[0]) throw new Error('no_promoted_prop_selector');
  return rows[0];
}

/* Board quotes from the nfl-odds snapshot. captured_at is the batch's own
 * observation time — the honest age of this market. */
export function tapeFromBoard(board) {
  const capturedAt = board?.captured_at || null;
  return {
    captured_at: capturedAt,
    rows: (Array.isArray(board?.quotes) ? board.quotes : [])
      .filter(row => row?.market === PROP_MARKET)
      .map(row => ({
        player: row.player,
        book: row.book,
        side: row.direction,
        current: { point: row.point, price: row.price, captured_at: capturedAt },
        open: { point: null, price: null, captured_at: null },
      })),
  };
}

async function oddsJson(env, path) {
  if (!env.NFL_ODDS) throw new Error('odds_binding_missing');
  const response = await env.NFL_ODDS.fetch(new Request(`https://nfl-odds.internal${path}`, { headers: { accept: 'application/json' } }));
  if (!response.ok) throw new Error(`odds_service_${response.status}`);
  return response.json();
}

async function oddsMeta(env) {
  const body = await oddsJson(env, '/api/odds/events');
  return { captured_at: body?.captured_at || null, batch_id: body?.batch_id || null };
}

function issuanceScope(selector) {
  if (!selector || selector.promoted !== true) throw new Error('prop_selector_not_promoted');
  return selector.trained === true ? 'official' : 'tracking';
}

async function openPickFor(env, eventId, pKey) {
  const rows = await select(
    env,
    'nfl_prop_picks',
    `event_id=eq.${encodeURIComponent(eventId)}&player_key=eq.${encodeURIComponent(pKey)}`
      + `&market=eq.${PROP_MARKET}&status=eq.open&select=*&limit=1`,
  ) || [];
  return rows[0] || null;
}

function groupPairedQuotes(rows) {
  const map = new Map();
  for (const quote of rows) {
    if (!map.has(quote.player_key)) map.set(quote.player_key, []);
    map.get(quote.player_key).push(quote);
  }
  return map;
}

function projectionRows(model) {
  const rows = model?.models || model?.picks || model?.data || [];
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const fair = Number(row?.fair_line ?? row?.projected_line);
    const sd = Number(row?.predictive_sd);
    return row?.available !== false
      && playerOf(row)
      && Number.isFinite(fair)
      && Number.isFinite(sd)
      && sd > 0;
  });
}

function playerOf(row) {
  return row?.player || row?.player_name || row?.name || '';
}

function modelVersion(model) {
  return String(
    model?.model_version
      || model?.source?.model_version
      || model?.lineage
      || 'pbe-passing-production',
  );
}

function sanitizedSnapshot({ projection, decision, selector, event, context, game }) {
  return {
    projection: {
      player: playerOf(projection),
      fair_line: projection?.fair_line ?? projection?.projected_line ?? null,
      predictive_sd: projection?.predictive_sd ?? null,
      projected_attempts: projection?.projected_attempts ?? null,
      raw_games: projection?.raw_games ?? null,
      effective_games: projection?.effective_games ?? null,
      decision_status: projection?.decision_status ?? projection?.status ?? null,
      missing_inputs: Array.isArray(projection?.missing_inputs)
        ? projection.missing_inputs.slice(0, 20)
        : [],
    },
    selector_features: selectorFeatures(decision),
    selector_config: selector?.config || {},
    market: {
      book_count: decision.book_count,
      quote_captured_at: decision.quote_captured_at,
      open_point: decision.open_point,
      open_price: decision.open_price,
    },
    event: {
      event_id: event.id,
      away_team: event.away_team,
      home_team: event.home_team,
      commence_time: event.commence_time,
      season: context.season,
      week: context.week,
      game_id: game?.game_id ?? null,
      espn_id: game?.espn_id ?? null,
      kickoff_ts: context.kickoff_ts,
    },
  };
}

async function auditProp(env, pickId, eventType, selectorVersion, detail) {
  try {
    await insert(env, 'nfl_prop_pick_audit_events', {
      pick_id: pickId || null,
      event_type: eventType,
      selector_version: selectorVersion ?? null,
      detail: detail || {},
    }, { returning: 'minimal' });
  } catch (error) {
    console.error('[prop-audit] failed', errorClass(error));
  }
}

function gatewayBase(env) {
  return String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    cf: { cacheTtl: 0 },
  });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
