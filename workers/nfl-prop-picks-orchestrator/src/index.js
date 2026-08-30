/* nfl-prop-picks-orchestrator — Algorithm #2: governed NFL player props.
 *
 * v1 scope is deliberately narrow: player_pass_yds only, because that is the
 * production projection distribution PropBetEdge can actually supply today.
 *
 * It does NOT build projections. It consumes:
 *   - PBE production fair line + predictive SD
 *   - persisted multi-book player-prop tape from PBE NFL Intelligence
 * and decides whether an executable sportsbook quote clears the selector gate.
 *
 * Bootstrap decisions are tracking-only until this selector's own champion is
 * trained. They can never become part of the official customer record later.
 */
import { select, insert, patch, rpc } from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  PROP_MARKET, PROP_KILL_EDGE_DEFAULT, playerKey, pairCurrentQuotes,
  evaluatePropQuote, selectorFeatures,
} from '../../nfl-prop-picks-shared/prop-math.mjs';

const SERVICE = 'nfl-prop-picks-orchestrator';
const VERSION = 'v1.0.0';
const HORIZON_HOURS = 36;
const MAX_EVENTS = 16;

const health = {
  last_cron_run: null,
  last_error_class: null,
  last_result: null,
  selector_version: null,
  selector_trained: null,
  issuance_scope: null,
  engine_state: 'PROP ENGINE WAITING — market tape not ready',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return json({
        service: SERVICE, version: VERSION,
        last_cron_run: health.last_cron_run,
        last_error_class: health.last_error_class,
        last_result: health.last_result,
        engine_state: health.engine_state,
        selector_version: health.selector_version,
        selector_trained: health.selector_trained,
        issuance_scope: health.issuance_scope,
        market: PROP_MARKET,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          NFL_GATEWAY: Boolean(env.NFL_GATEWAY),
          NFL_INTELLIGENCE_URL: Boolean(env.NFL_INTELLIGENCE_URL),
        },
      });
    }
    if (url.pathname === '/v1/engine/state' && req.method === 'GET') {
      return engineState(env);
    }
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runOrchestration(env));
  },
};

async function engineState(env) {
  try {
    const selector = await latestSelector(env);
    const observations = await select(
      env, 'nfl_prop_learning_observations',
      `market=eq.${PROP_MARKET}&is_final=eq.true&select=season,week,publication_scope&limit=5000`,
    ) || [];
    const weeks = new Set(observations.map(row => `${row.season}-${row.week}`));
    const tracking = observations.filter(row => row.publication_scope === 'tracking').length;
    const official = observations.filter(row => row.publication_scope === 'official').length;
    return json({
      service: SERVICE, version: VERSION, market: PROP_MARKET,
      selector_version: selector?.version ?? null,
      projection_model: selector?.projection_model ?? null,
      selector_trained: selector?.trained === true,
      selector_promoted: selector?.promoted === true,
      selector_notes: selector?.notes ?? null,
      issuance_mode: selector?.trained === true ? 'OFFICIAL' : 'TRACKING_BOOTSTRAP',
      publication: selector?.trained === true ? 'ALLOWED' : 'GATED',
      finalized_sample: observations.length,
      finalized_tracking: tracking,
      finalized_official: official,
      distinct_weeks: weeks.size,
      truth: 'player_prop_official_only_customer_record',
    });
  } catch (error) {
    return json({ engine_state: 'PROP ENGINE DEGRADED — source unavailable', error_class: errorClass(error) }, 503);
  }
}

async function runOrchestration(env) {
  health.last_cron_run = new Date().toISOString();
  try {
    const selector = await latestSelector(env);
    const scope = issuanceScope(selector);
    health.selector_version = selector.version;
    health.selector_trained = selector.trained === true;
    health.issuance_scope = scope;

    const [eventsBody, scheduleBody] = await Promise.all([
      getJson(`${intelligenceBase(env)}/v1/nfl/events`),
      getJson(`${gatewayBase(env)}/api/schedule`),
    ]);

    const now = Date.now();
    const horizon = now + HORIZON_HOURS * 3600000;
    const events = (Array.isArray(eventsBody?.events) ? eventsBody.events : [])
      .map(event => ({ ...event, ts: Date.parse(event?.commence_time || '') }))
      .filter(event => Number.isFinite(event.ts) && event.ts >= now && event.ts <= horizon)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, MAX_EVENTS);

    if (!events.length) {
      health.engine_state = scope === 'tracking'
        ? 'PROP ENGINE GATED — MODEL VALIDATION IN PROGRESS'
        : 'PROP ENGINE WAITING — no event inside issuance horizon';
      health.last_result = 'no_events_in_horizon';
      health.last_error_class = null;
      return;
    }

    const schedule = Array.isArray(scheduleBody?.games) ? scheduleBody.games : [];
    let emitted = 0, kept = 0, killed = 0, superseded = 0;
    let skippedSchedule = 0, skippedProjection = 0, seededTape = 0, scopeDrain = 0;

    for (const event of events) {
      const scheduleGame = matchScheduleGame(event, schedule);
      if (!scheduleGame) { skippedSchedule += 1; continue; }

      const context = scheduleContext(scheduleBody, scheduleGame, event);
      let tape = await marketTape(env, event.id);
      if (!tape.rows.length) {
        const board = await getJson(
          `${intelligenceBase(env)}/v1/nfl/props/board?event_id=${encodeURIComponent(event.id)}`
          + `&markets=${encodeURIComponent(PROP_MARKET)}`,
        );
        tape = tapeFromBoard(board);
        if (tape.rows.length) seededTape += 1;
      }
      if (!tape.rows.length) continue;

      const model = await getJson(
        `${gatewayBase(env)}/api/picks/pass?event_id=${encodeURIComponent(event.id)}`,
      ).catch(() => null);
      const projections = projectionRows(model);
      if (!projections.length) { skippedProjection += 1; continue; }

      const paired = pairCurrentQuotes(tape.rows);
      if (!paired.length) continue;
      const pairsByPlayer = new Map();
      for (const quote of paired) {
        if (!pairsByPlayer.has(quote.player_key)) pairsByPlayer.set(quote.player_key, []);
        pairsByPlayer.get(quote.player_key).push(quote);
      }

      for (const projection of projections) {
        const pKey = playerKey(playerOf(projection));
        if (!pKey) continue;
        const quotes = pairsByPlayer.get(pKey) || [];
        if (!quotes.length) continue;
        const bookCount = new Set(quotes.map(q => String(q.book || '').toLowerCase()).filter(Boolean)).size;
        const evaluated = quotes.map(quote => evaluatePropQuote({
          projection, quote, bookCount, selector,
          kickoffTs: context.kickoff_ts, nowMs: now,
        }));

        const decision = evaluated
          .filter(row => row.available)
          .sort((a, b) => Number(b.qualifies) - Number(a.qualifies)
            || Number(b.ev_pct || 0) - Number(a.ev_pct || 0)
            || Number(b.edge_pct || 0) - Number(a.edge_pct || 0))[0];
        if (!decision) continue;

        decision.projection_model_version = modelVersion(model);
        decision.model_snapshot = sanitizedSnapshot({
          projection, decision, selector, event, context,
        });

        const open = await openPickFor(env, event.id, pKey);
        const result = await reconcile(env, {
          open, decision, selector, context, event, scope,
        });
        emitted += result.emitted;
        kept += result.kept;
        killed += result.killed;
        superseded += result.superseded;
        scopeDrain += result.scope_drain;
      }
    }

    health.engine_state = scope === 'tracking'
      ? 'PROP ENGINE GATED — MODEL VALIDATION IN PROGRESS'
      : emitted || kept
        ? 'PROP ENGINE LIVE — picks available'
        : 'PROP ENGINE LIVE — no qualified player props';
    health.last_result = `scope=${scope} emitted=${emitted} kept=${kept} killed=${killed}`
      + ` superseded=${superseded} seeded_tape=${seededTape}`
      + ` schedule_skips=${skippedSchedule} projection_skips=${skippedProjection}`
      + ` scope_drain=${scopeDrain}`;
    health.last_error_class = null;
  } catch (error) {
    health.engine_state = 'PROP ENGINE DEGRADED — source unavailable';
    health.last_error_class = errorClass(error);
    console.error(`[${SERVICE}] orchestration failed class=${health.last_error_class}`);
  }
}

async function reconcile(env, { open, decision, selector, context, event, scope }) {
  const tally = { emitted: 0, kept: 0, killed: 0, superseded: 0, scope_drain: 0 };
  const config = selector.config || {};
  const issuanceRow = {
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
    const row = await insert(env, 'nfl_prop_picks', issuanceRow);
    const pickId = Array.isArray(row) ? row[0]?.id : row?.id;
    await auditProp(env, pickId, 'prop_pick_created', selector.version, {
      market: PROP_MARKET, side: decision.side, player_key: decision.player_key,
      book: decision.book, line: decision.market_line, price: decision.market_price,
      edge_pct: decision.edge_pct, ev_pct: decision.ev_pct,
      phase: decision.phase, publication_scope: scope,
    });
    await auditProp(env, pickId, 'prop_model_snapshot_locked', selector.version, {
      projection_model_version: decision.projection_model_version,
      model_prob: decision.model_prob, market_prob: decision.market_prob,
      model_fair_line: decision.model_fair_line, predictive_sd: decision.predictive_sd,
    });
    tally.emitted = 1;
    return tally;
  }

  // Tracking rows drain naturally across selector promotion. Never reclassify or
  // supersede a bootstrap observation merely because the champion later trains.
  if (open.publication_scope !== scope) {
    tally.scope_drain = 1;
    return tally;
  }

  const sideFlipped = decision.side && decision.side !== open.side;
  if (sideFlipped && decision.qualifies && decision.stake_units > 0) {
    const newId = await rpc(env, 'nfl_replace_open_prop_pick', {
      p_open_id: open.id,
      p_event_id: issuanceRow.event_id,
      p_season: issuanceRow.season,
      p_week: issuanceRow.week,
      p_kickoff_ts: issuanceRow.kickoff_ts,
      p_player_name: issuanceRow.player_name,
      p_player_key: issuanceRow.player_key,
      p_market: issuanceRow.market,
      p_side: issuanceRow.side,
      p_book: issuanceRow.book,
      p_book_key: issuanceRow.book_key,
      p_market_line: issuanceRow.market_line,
      p_market_price: issuanceRow.market_price,
      p_opposite_price: issuanceRow.opposite_price,
      p_model_fair_line: issuanceRow.model_fair_line,
      p_predictive_sd: issuanceRow.predictive_sd,
      p_model_prob: issuanceRow.model_prob,
      p_market_prob: issuanceRow.market_prob,
      p_edge_pct: issuanceRow.edge_pct,
      p_ev_pct: issuanceRow.ev_pct,
      p_stake_units: issuanceRow.stake_units,
      p_confidence_bucket: issuanceRow.confidence_bucket,
      p_projection_model_version: issuanceRow.projection_model_version,
      p_selector_version: issuanceRow.selector_version,
      p_phase: issuanceRow.phase,
      p_publication_scope: issuanceRow.publication_scope,
      p_model_snapshot: issuanceRow.model_snapshot,
    });
    await auditProp(env, open.id, 'prop_pick_superseded', selector.version, {
      superseded_by: newId, from_side: open.side, to_side: decision.side,
    });
    await auditProp(env, newId, 'prop_pick_created', selector.version, {
      market: PROP_MARKET, side: decision.side, player_key: decision.player_key,
      book: decision.book, line: decision.market_line, price: decision.market_price,
      edge_pct: decision.edge_pct, ev_pct: decision.ev_pct,
      phase: decision.phase, publication_scope: scope,
    });
    tally.superseded = 1;
    tally.emitted = 1;
    return tally;
  }

  // Do not kill because book depth disappeared or the engine is between its two
  // issuance windows. A kill is a model decision, not a data-availability state.
  const minBooks = finite(config.min_books, 4);
  if (decision.book_count < minBooks) return tally;
  const killEdge = finite(config.kill_edge, PROP_KILL_EDGE_DEFAULT);
  const killEv = finite(config.kill_ev_pct, 0);
  if (!decision.qualifies && decision.edge_pct < killEdge && decision.ev_pct < killEv) {
    await patch(env, 'nfl_prop_picks', `id=eq.${open.id}`, {
      status: 'killed', closed_at: new Date().toISOString(),
    });
    await auditProp(env, open.id, 'prop_pick_killed', selector.version, {
      reason: 'edge_and_ev_collapsed', edge_pct: decision.edge_pct, ev_pct: decision.ev_pct,
    });
    tally.killed = 1;
    return tally;
  }

  // Same-side economics never rewrite the original issued price.
  tally.kept = 1;
  return tally;
}

async function latestSelector(env) {
  const rows = await select(
    env, 'nfl_prop_selector_models',
    `market=eq.${PROP_MARKET}&promoted=is.true&select=*&order=version.desc&limit=1`,
  ) || [];
  const row = rows[0];
  if (!row) throw new Error('no_promoted_prop_selector');
  return row;
}

function issuanceScope(selector) {
  if (!selector || selector.promoted !== true) throw new Error('prop_selector_not_promoted');
  return selector.trained === true ? 'official' : 'tracking';
}

async function openPickFor(env, eventId, pKey) {
  const rows = await select(
    env, 'nfl_prop_picks',
    `event_id=eq.${encodeURIComponent(eventId)}&player_key=eq.${encodeURIComponent(pKey)}`
      + `&market=eq.${PROP_MARKET}&status=eq.open&select=*&limit=1`,
  ) || [];
  return rows[0] || null;
}

async function marketTape(env, eventId) {
  const out = await getJson(
    `${intelligenceBase(env)}/v1/nfl/line-movement?event_id=${encodeURIComponent(eventId)}`
      + `&market=${encodeURIComponent(PROP_MARKET)}`,
  ).catch(() => null);
  return { rows: Array.isArray(out?.rows) ? out.rows : [] };
}

function tapeFromBoard(board) {
  return {
    rows: (Array.isArray(board?.quotes) ? board.quotes : []).map(row => ({
      player: row.player,
      book: row.book,
      side: row.direction,
      current: { point: row.point, price: row.price, captured_at: row.last_update || board.provider_last_update || null },
      open: { point: row.point, price: row.price, captured_at: row.last_update || board.provider_last_update || null },
    })),
  };
}

function projectionRows(model) {
  const rows = model?.models || model?.picks || model?.data || [];
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const fair = Number(row?.fair_line ?? row?.projected_line);
    const sd = Number(row?.predictive_sd);
    return row?.available !== false && playerOf(row) && Number.isFinite(fair) && Number.isFinite(sd) && sd > 0;
  });
}

function playerOf(row) {
  return row?.player || row?.player_name || row?.name || '';
}

function modelVersion(model) {
  return String(model?.model_version || model?.source?.model_version || model?.lineage || 'pbe-passing-production');
}

function sanitizedSnapshot({ projection, decision, selector, event, context }) {
  return {
    projection: {
      player: playerOf(projection),
      fair_line: projection?.fair_line ?? projection?.projected_line ?? null,
      predictive_sd: projection?.predictive_sd ?? null,
      projected_attempts: projection?.projected_attempts ?? null,
      raw_games: projection?.raw_games ?? null,
      effective_games: projection?.effective_games ?? null,
      decision_status: projection?.decision_status ?? projection?.status ?? null,
      missing_inputs: Array.isArray(projection?.missing_inputs) ? projection.missing_inputs.slice(0, 20) : [],
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

function matchScheduleGame(event, games) {
  const away = teamCode(event?.away_team), home = teamCode(event?.home_team);
  const kickoff = Date.parse(event?.commence_time || '');
  if (!away || !home || !Number.isFinite(kickoff)) return null;
  const candidates = games.filter(game => teamCode(game?.away_team) === away && teamCode(game?.home_team) === home);
  if (!candidates.length) return null;
  return candidates
    .map(game => ({ game, ts: scheduleKickoff(game) }))
    .filter(row => Number.isFinite(row.ts) && Math.abs(row.ts - kickoff) <= 8 * 3600000)
    .sort((a, b) => Math.abs(a.ts - kickoff) - Math.abs(b.ts - kickoff))[0]?.game || null;
}

function scheduleContext(body, game, event) {
  const season = Number(game?.season || body?.season || new Date(event.commence_time).getUTCFullYear());
  const week = Number(game?.week);
  if (!Number.isFinite(season) || !Number.isFinite(week)) throw new Error('schedule_context_unavailable');
  return { season, week, kickoff_ts: new Date(event.commence_time).toISOString() };
}

function scheduleKickoff(game) {
  if (game?.kickoff_ts) return Date.parse(game.kickoff_ts);
  if (!game?.gameday) return NaN;
  return Date.parse(`${game.gameday}T${game.gametime || '00:00'}:00Z`);
}

const TEAM = {
  ARI:'ARI',CARDINALS:'ARI',ATL:'ATL',FALCONS:'ATL',BAL:'BAL',RAVENS:'BAL',BUF:'BUF',BILLS:'BUF',
  CAR:'CAR',PANTHERS:'CAR',CHI:'CHI',BEARS:'CHI',CIN:'CIN',BENGALS:'CIN',CLE:'CLE',BROWNS:'CLE',
  DAL:'DAL',COWBOYS:'DAL',DEN:'DEN',BRONCOS:'DEN',DET:'DET',LIONS:'DET',GB:'GB',PACKERS:'GB',
  HOU:'HOU',TEXANS:'HOU',IND:'IND',COLTS:'IND',JAX:'JAX',JAGUARS:'JAX',KC:'KC',CHIEFS:'KC',
  LV:'LV',RAIDERS:'LV',LAC:'LAC',CHARGERS:'LAC',LAR:'LAR',RAMS:'LAR',MIA:'MIA',DOLPHINS:'MIA',
  MIN:'MIN',VIKINGS:'MIN',NE:'NE',PATRIOTS:'NE',NO:'NO',SAINTS:'NO',NYG:'NYG',GIANTS:'NYG',
  NYJ:'NYJ',JETS:'NYJ',PHI:'PHI',EAGLES:'PHI',PIT:'PIT',STEELERS:'PIT',SF:'SF',49ERS:'SF',
  SEA:'SEA',SEAHAWKS:'SEA',TB:'TB',BUCCANEERS:'TB',BUCS:'TB',TEN:'TEN',TITANS:'TEN',
  WAS:'WAS',WSH:'WAS',COMMANDERS:'WAS',
};
function teamCode(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
  if (TEAM[raw]) return TEAM[raw];
  const last = raw.split(' ').filter(Boolean).at(-1) || '';
  return TEAM[last] || (TEAM[raw.replace(/ /g, '')] || null);
}

function gatewayBase(env) {
  return String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
}
function intelligenceBase(env) {
  return String(env.NFL_INTELLIGENCE_URL || 'https://pbe-nfl-intelligence.sales-fd3.workers.dev').replace(/\/$/, '');
}
async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}
function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
