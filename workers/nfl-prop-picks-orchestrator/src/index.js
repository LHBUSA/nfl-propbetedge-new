/* nfl-prop-picks-orchestrator — Algorithm #2: governed NFL player props.
 * v1 is player_pass_yds only. Projection authority stays upstream; this Worker
 * selects executable sportsbook quotes, persists immutable decisions and never
 * promotes bootstrap output into the customer record.
 */
import { select, insert, patch, rpc } from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  PROP_MARKET, PROP_KILL_EDGE_DEFAULT, playerKey, pairCurrentQuotes,
  evaluatePropQuote, selectorFeatures,
} from '../../nfl-prop-picks-shared/prop-math.mjs';

const SERVICE = 'nfl-prop-picks-orchestrator';
const VERSION = 'v1.0.1';
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
    if (url.pathname === '/v1/engine/state' && req.method === 'GET') return engineState(env);
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
    return json({
      service: SERVICE, version: VERSION, market: PROP_MARKET,
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
    const count = { emitted: 0, kept: 0, killed: 0, superseded: 0, schedule_skip: 0, projection_skip: 0, seeded: 0, scope_drain: 0 };

    for (const event of events) {
      const scheduleGame = matchScheduleGame(event, schedule);
      if (!scheduleGame) { count.schedule_skip += 1; continue; }
      const context = scheduleContext(scheduleBody, scheduleGame, event);

      let tape = await marketTape(env, event.id);
      if (!tape.rows.length) {
        const board = await getJson(
          `${intelligenceBase(env)}/v1/nfl/props/board?event_id=${encodeURIComponent(event.id)}`
            + `&markets=${encodeURIComponent(PROP_MARKET)}`,
        );
        tape = tapeFromBoard(board);
        if (tape.rows.length) count.seeded += 1;
      }
      if (!tape.rows.length) continue;

      const model = await getJson(`${gatewayBase(env)}/api/picks/pass?event_id=${encodeURIComponent(event.id)}`).catch(() => null);
      const projections = projectionRows(model);
      if (!projections.length) { count.projection_skip += 1; continue; }

      const byPlayer = groupPairedQuotes(pairCurrentQuotes(tape.rows));
      for (const projection of projections) {
        const pKey = playerKey(playerOf(projection));
        const quotes = byPlayer.get(pKey) || [];
        if (!pKey || !quotes.length) continue;
        const bookCount = new Set(quotes.map(q => String(q.book || '').toLowerCase()).filter(Boolean)).size;
        const decision = quotes
          .map(quote => evaluatePropQuote({ projection, quote, bookCount, selector, kickoffTs: context.kickoff_ts, nowMs: now }))
          .filter(row => row.available)
          .sort((a, b) => Number(b.qualifies) - Number(a.qualifies)
            || Number(b.ev_pct || 0) - Number(a.ev_pct || 0)
            || Number(b.edge_pct || 0) - Number(a.edge_pct || 0))[0];
        if (!decision) continue;

        decision.projection_model_version = modelVersion(model);
        decision.model_snapshot = sanitizedSnapshot({ projection, decision, selector, event, context });
        const open = await openPickFor(env, event.id, pKey);
        const result = await reconcile(env, { open, decision, selector, context, event, scope });
        for (const key of ['emitted', 'kept', 'killed', 'superseded', 'scope_drain']) count[key] += result[key];
      }
    }

    health.engine_state = scope === 'tracking'
      ? 'PROP ENGINE GATED — MODEL VALIDATION IN PROGRESS'
      : count.emitted || count.kept
        ? 'PROP ENGINE LIVE — picks available'
        : 'PROP ENGINE LIVE — no qualified player props';
    health.last_result = `scope=${scope} emitted=${count.emitted} kept=${count.kept} killed=${count.killed}`
      + ` superseded=${count.superseded} seeded_tape=${count.seeded}`
      + ` schedule_skips=${count.schedule_skip} projection_skips=${count.projection_skip}`
      + ` scope_drain=${count.scope_drain}`;
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
      superseded_by: newId, from_side: open.side, to_side: decision.side,
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
    await patch(env, 'nfl_prop_picks', `id=eq.${open.id}`, { status: 'killed', closed_at: new Date().toISOString() });
    await auditProp(env, open.id, 'prop_pick_killed', selector.version, {
      reason: decision.edge_pct < killEdge ? 'edge_collapsed' : 'expected_value_negative',
      edge_pct: decision.edge_pct, ev_pct: decision.ev_pct,
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
    market: PROP_MARKET, side: decision.side, player_key: decision.player_key,
    book: decision.book, line: decision.market_line, price: decision.market_price,
    edge_pct: decision.edge_pct, ev_pct: decision.ev_pct,
    phase: decision.phase, publication_scope: scope,
  });
  await auditProp(env, pickId, 'prop_model_snapshot_locked', selectorVersion, {
    projection_model_version: decision.projection_model_version,
    model_prob: decision.model_prob, market_prob: decision.market_prob,
    model_fair_line: decision.model_fair_line, predictive_sd: decision.predictive_sd,
  });
}

async function latestSelector(env) {
  const rows = await select(env, 'nfl_prop_selector_models',
    `market=eq.${PROP_MARKET}&promoted=is.true&select=*&order=version.desc&limit=1`) || [];
  if (!rows[0]) throw new Error('no_promoted_prop_selector');
  return rows[0];
}
function issuanceScope(selector) {
  if (!selector || selector.promoted !== true) throw new Error('prop_selector_not_promoted');
  return selector.trained === true ? 'official' : 'tracking';
}
async function openPickFor(env, eventId, pKey) {
  const rows = await select(env, 'nfl_prop_picks',
    `event_id=eq.${encodeURIComponent(eventId)}&player_key=eq.${encodeURIComponent(pKey)}`
      + `&market=eq.${PROP_MARKET}&status=eq.open&select=*&limit=1`) || [];
  return rows[0] || null;
}

async function marketTape(env, eventId) {
  const out = await getJson(`${intelligenceBase(env)}/v1/nfl/line-movement?event_id=${encodeURIComponent(eventId)}`
    + `&market=${encodeURIComponent(PROP_MARKET)}`).catch(() => null);
  return { rows: Array.isArray(out?.rows) ? out.rows : [] };
}
function tapeFromBoard(board) {
  return { rows: (Array.isArray(board?.quotes) ? board.quotes : []).map(row => ({
    player: row.player, book: row.book, side: row.direction,
    current: { point: row.point, price: row.price, captured_at: row.last_update || board.provider_last_update || null },
    open: { point: row.point, price: row.price, captured_at: row.last_update || board.provider_last_update || null },
  })) };
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
    return row?.available !== false && playerOf(row) && Number.isFinite(fair) && Number.isFinite(sd) && sd > 0;
  });
}
function playerOf(row) { return row?.player || row?.player_name || row?.name || ''; }
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
      event_id: event.id, away_team: event.away_team, home_team: event.home_team,
      commence_time: event.commence_time, season: context.season, week: context.week,
    },
  };
}

async function auditProp(env, pickId, eventType, selectorVersion, detail) {
  try {
    await insert(env, 'nfl_prop_pick_audit_events', {
      pick_id: pickId || null, event_type: eventType,
      selector_version: selectorVersion ?? null, detail: detail || {},
    }, { returning: 'minimal' });
  } catch (error) {
    console.error('[prop-audit] failed', errorClass(error));
  }
}

function matchScheduleGame(event, games) {
  const away = teamCode(event?.away_team), home = teamCode(event?.home_team);
  const kickoff = Date.parse(event?.commence_time || '');
  if (!away || !home || !Number.isFinite(kickoff)) return null;
  return games
    .filter(game => teamCode(game?.away_team) === away && teamCode(game?.home_team) === home)
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

const TEAM_ALIASES = new Map([
  ['ARI','ARI'],['CARDINALS','ARI'],['ARIZONA CARDINALS','ARI'],
  ['ATL','ATL'],['FALCONS','ATL'],['ATLANTA FALCONS','ATL'],
  ['BAL','BAL'],['RAVENS','BAL'],['BALTIMORE RAVENS','BAL'],
  ['BUF','BUF'],['BILLS','BUF'],['BUFFALO BILLS','BUF'],
  ['CAR','CAR'],['PANTHERS','CAR'],['CAROLINA PANTHERS','CAR'],
  ['CHI','CHI'],['BEARS','CHI'],['CHICAGO BEARS','CHI'],
  ['CIN','CIN'],['BENGALS','CIN'],['CINCINNATI BENGALS','CIN'],
  ['CLE','CLE'],['BROWNS','CLE'],['CLEVELAND BROWNS','CLE'],
  ['DAL','DAL'],['COWBOYS','DAL'],['DALLAS COWBOYS','DAL'],
  ['DEN','DEN'],['BRONCOS','DEN'],['DENVER BRONCOS','DEN'],
  ['DET','DET'],['LIONS','DET'],['DETROIT LIONS','DET'],
  ['GB','GB'],['PACKERS','GB'],['GREEN BAY PACKERS','GB'],
  ['HOU','HOU'],['TEXANS','HOU'],['HOUSTON TEXANS','HOU'],
  ['IND','IND'],['COLTS','IND'],['INDIANAPOLIS COLTS','IND'],
  ['JAX','JAX'],['JAGUARS','JAX'],['JACKSONVILLE JAGUARS','JAX'],
  ['KC','KC'],['CHIEFS','KC'],['KANSAS CITY CHIEFS','KC'],
  ['LV','LV'],['RAIDERS','LV'],['LAS VEGAS RAIDERS','LV'],
  ['LAC','LAC'],['CHARGERS','LAC'],['LOS ANGELES CHARGERS','LAC'],
  ['LAR','LAR'],['RAMS','LAR'],['LOS ANGELES RAMS','LAR'],
  ['MIA','MIA'],['DOLPHINS','MIA'],['MIAMI DOLPHINS','MIA'],
  ['MIN','MIN'],['VIKINGS','MIN'],['MINNESOTA VIKINGS','MIN'],
  ['NE','NE'],['PATRIOTS','NE'],['NEW ENGLAND PATRIOTS','NE'],
  ['NO','NO'],['SAINTS','NO'],['NEW ORLEANS SAINTS','NO'],
  ['NYG','NYG'],['GIANTS','NYG'],['NEW YORK GIANTS','NYG'],
  ['NYJ','NYJ'],['JETS','NYJ'],['NEW YORK JETS','NYJ'],
  ['PHI','PHI'],['EAGLES','PHI'],['PHILADELPHIA EAGLES','PHI'],
  ['PIT','PIT'],['STEELERS','PIT'],['PITTSBURGH STEELERS','PIT'],
  ['SF','SF'],['49ERS','SF'],['SAN FRANCISCO 49ERS','SF'],
  ['SEA','SEA'],['SEAHAWKS','SEA'],['SEATTLE SEAHAWKS','SEA'],
  ['TB','TB'],['BUCS','TB'],['BUCCANEERS','TB'],['TAMPA BAY BUCCANEERS','TB'],
  ['TEN','TEN'],['TITANS','TEN'],['TENNESSEE TITANS','TEN'],
  ['WAS','WAS'],['WSH','WAS'],['COMMANDERS','WAS'],['WASHINGTON COMMANDERS','WAS'],
]);
function teamCode(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ');
  if (TEAM_ALIASES.has(raw)) return TEAM_ALIASES.get(raw);
  const last = raw.split(' ').filter(Boolean).at(-1) || '';
  return TEAM_ALIASES.get(last) || null;
}

function gatewayBase(env) { return String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, ''); }
function intelligenceBase(env) { return String(env.NFL_INTELLIGENCE_URL || 'https://pbe-nfl-intelligence.sales-fd3.workers.dev').replace(/\/$/, ''); }
async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}
function finite(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function errorClass(error) { return String(error?.message || 'unknown').split(':')[0].slice(0, 80); }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
