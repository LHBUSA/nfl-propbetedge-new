/* PropBetEdge NFL — binds the committed model artefact to a live game.
 *
 * The kernel does the arithmetic and knows nothing about where its inputs came
 * from. This file is the only place that reads the artefact's shape and turns
 * "this player, this game, this forecast" into the kernel's arguments, so the
 * orchestrator never reaches into the model object and the tests can drive the
 * same binding with a fixture artefact.
 */

import { lambdaFor, scriptBucketOf, weatherBucketOf, spreadFromOddsPoint, round } from './td-kernel.mjs';

/* A scorer bound to one artefact. Throws on an artefact that cannot produce a
 * probability at all — a missing calibration or no position priors — because
 * that is a degraded source, not a model with no opinion. */
export function makeScorer(model) {
  if (!model || typeof model !== 'object') throw new Error('td_model_unavailable');
  if (!model.position_priors || !Object.keys(model.position_priors).length) throw new Error('td_model_priors_missing');
  if (!Number.isFinite(Number(model?.calibration?.a)) || !Number.isFinite(Number(model?.calibration?.b))) {
    throw new Error('td_model_calibration_missing');
  }

  return function scoreLambda({ player, side, currentSeason, gameContext }) {
    return lambdaFor({
      baseline: player,
      currentSeason,
      prior: model.position_priors[player?.position] || null,
      rzTier: player?.rz_tier || 'unknown',
      team: model.teams?.scored?.[side?.team] ?? null,
      leagueScored: model.teams?.league_scored ?? null,
      opponent: model.teams?.allowed?.[side?.opponent] ?? null,
      leagueAllowed: model.teams?.league_allowed ?? null,
      scriptBucket: scriptBucketOf(spreadForTeam(gameContext, side)),
      weatherBucket: weatherBucketOf(gameContext?.environment || null),
      coefficients: model.coefficients || {},
      weights: model.weights || {},
    });
  };
}

/* The spread, in the Player DNA convention the coefficients were fitted in:
 * positive means THIS player's team is favoured. The market handicap arrives
 * in the opposite sign, so it is converted here, once. */
export function spreadForTeam(gameContext, side) {
  const handicaps = gameContext?.spread_points || null;
  if (!handicaps || !side?.team) return null;
  const point = handicaps[side.team];
  return point === null || point === undefined ? null : spreadFromOddsPoint(point);
}

/* -------------------------------------------------------- live game context */

/* Consensus handicap and total for one game from the featured-market snapshot,
 * plus the implied team totals that follow from them.
 *
 * The implied team total is RECORDED and NOT consumed by the champion: the
 * Player DNA rows carry a spread but no game total, so there is no historical
 * sample to fit a total-based term on without inventing one. It is in the
 * snapshot so a challenger can earn it under the promotion gate. */
export function gameContextFrom({ featured, awayTeam, homeTeam, weather, teamNameToCode }) {
  const spreads = { [awayTeam]: [], [homeTeam]: [] };
  const totals = [];
  let books = 0;
  for (const book of arr(featured?.bookmakers)) {
    let counted = false;
    for (const market of arr(book?.markets)) {
      if (market?.key === 'spreads') {
        for (const outcome of arr(market?.outcomes)) {
          const code = teamNameToCode(outcome?.name);
          const point = Number(outcome?.point);
          if (!code || !Number.isFinite(point) || !(code in spreads)) continue;
          spreads[code].push(point);
          counted = true;
        }
      } else if (market?.key === 'totals') {
        for (const outcome of arr(market?.outcomes)) {
          const point = Number(outcome?.point);
          if (Number.isFinite(point)) { totals.push(point); counted = true; }
        }
      }
    }
    if (counted) books += 1;
  }

  const awaySpread = median(spreads[awayTeam]);
  const homeSpread = median(spreads[homeTeam]);
  const total = median(totals);
  const impliedTeamTotal = (handicap) => (total === null || handicap === null
    ? null : round(total / 2 - handicap / 2, 3));

  return {
    books,
    spread_points: { [awayTeam]: awaySpread, [homeTeam]: homeSpread },
    total,
    /* Recorded, not consumed — see the note above. */
    implied_team_total: { [awayTeam]: impliedTeamTotal(awaySpread), [homeTeam]: impliedTeamTotal(homeSpread) },
    implied_team_total_consumed_by_champion: false,
    environment: weather || null,
    available: {
      spread: awaySpread !== null || homeSpread !== null,
      total: total !== null,
      weather: Boolean(weather && weather.available !== false),
    },
  };
}

/* nfl-intel's kickoff-window forecast, reduced to the fields the weather
 * bucket reads. A roofed game reports `weather_applies: false` and produces a
 * context the kernel will correctly treat as "no weather", not "fine weather". */
export function environmentFrom(weatherGame) {
  if (!weatherGame) return null;
  const applies = weatherGame?.roof?.weather_applies === true;
  const forecast = weatherGame?.forecast || null;
  return {
    available: weatherGame.available === true,
    roof: applies ? 'outdoors' : (weatherGame?.roof?.state || 'closed'),
    roof_state: weatherGame?.roof?.state ?? null,
    roof_label: weatherGame?.roof?.label ?? null,
    weather_applies: applies,
    indoor: !applies,
    weather_status: weatherGame.available === true && forecast ? 'ok' : 'unavailable',
    temp_f: forecast ? numOrNull(forecast.temp_f) : null,
    wind_mph: forecast ? numOrNull(forecast.wind_mph) : null,
    gust_mph: forecast ? numOrNull(forecast.gust_mph) : null,
    condition: forecast?.condition ?? null,
    /* Recorded only. There is no historical precipitation sample to fit
     * against — the source columns are unpopulated — so no coefficient exists
     * and the champion does not move on it. */
    precip_probability_pct: forecast ? numOrNull(forecast.precip_probability_pct) : null,
    venue: weatherGame?.venue ?? null,
    alerts: arr(weatherGame?.nws).map(alert => ({ event: alert.event, severity: alert.severity })),
  };
}

/* ------------------------------------------------- current-season TD layer */

/* The current-season touchdown layer, from the current-season authority's
 * published leader boards.
 *
 * WHY LEADER BOARDS AND NOT A PER-PLAYER CALL
 * nfl-current serves one player per request out of a whole-season accumulator.
 * Reading it once per candidate would mean a couple of hundred reads and
 * re-parses of that accumulator in a single scheduled invocation. The leader
 * boards arrive in ONE read and cover the players who can actually be a
 * touchdown target. A player outside them has NO current-season layer, which
 * the snapshot records as unavailable with its reason. That is a smaller
 * sample, not a zero: a player with no layer keeps his historical baseline
 * and his prior, which is the correct treatment of an absent observation. */
export function currentSeasonLayer(currentStats) {
  const byEspn = new Map();
  const add = (row, kind) => {
    const id = String(row?.id || '');
    if (!id) return;
    if (!byEspn.has(id)) byEspn.set(id, { espn_id: id, player: row.player || null, team: row.team || null, rushing_td: null, receiving_td: null, games: null });
    const entry = byEspn.get(id);
    const tds = numOrNull(row.tds);
    const games = numOrNull(row.games);
    if (kind === 'rushing') entry.rushing_td = tds;
    if (kind === 'receiving') entry.receiving_td = tds;
    if (games !== null) entry.games = Math.max(entry.games ?? 0, games);
  };
  for (const kind of ['rushing', 'receiving']) {
    for (const row of arr(currentStats?.categories?.[kind]?.leaders)) add(row, kind);
  }

  const layer = new Map();
  for (const entry of byEspn.values()) {
    if (entry.games === null || !(entry.games > 0)) continue;
    const rushing = entry.rushing_td ?? 0;
    const receiving = entry.receiving_td ?? 0;
    layer.set(entry.espn_id, {
      available: true,
      games: entry.games,
      offensive_td: rushing + receiving,
      rushing_td: entry.rushing_td,
      receiving_td: entry.receiving_td,
      source: 'nfl-current /api/current-stats leader boards',
    });
  }
  return {
    available: layer.size > 0,
    season: numOrNull(currentStats?.season),
    completed_games: numOrNull(currentStats?.completed_games),
    covered_players: layer.size,
    last_updated: currentStats?.last_updated ?? null,
    for(espnId) {
      const id = String(espnId || '');
      const hit = id ? layer.get(id) : null;
      return hit || {
        available: false,
        unavailable_reason: layer.size
          ? 'player_outside_published_current_season_leader_boards'
          : 'current_season_accumulator_unavailable',
      };
    },
  };
}

/* ------------------------------------------------------------------- utils */
const arr = value => (Array.isArray(value) ? value : []);
const numOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
function median(values) {
  const xs = arr(values).map(numOrNull).filter(v => v !== null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const middle = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[middle] : round((xs[middle - 1] + xs[middle]) / 2, 3);
}
