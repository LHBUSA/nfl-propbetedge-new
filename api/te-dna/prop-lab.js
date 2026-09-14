/* GET /api/te-dna/prop-lab
 *   ?player_id=00-0033857&event_id=<market event id>[&condition=dome]
 *
 * Every currently offered receiving market for this game, each against its own
 * real line over career / season / last 10 / last 5 / similar conditions.
 *
 * ANYTIME TD IS DIFFERENT AND IS TREATED DIFFERENTLY.
 * It is priced as American odds, not as a threshold. Comparing a price to a
 * yardage line would be a category error, so it gets its own representation:
 * a count of games with a receiving touchdown, and the market PRICE shown as a
 * price. The historical rate is never called an implied probability.
 */
import { resolvePlayer, gamesFor, propThreshold, tdHistory, splitRows,
         provenance, dataWindow, MARKETS, CONDITIONS } from '../_tedna/engine.js';
import { eventMarkets, RECEIVING_MARKET_MAP, MARKET_UNAVAILABLE } from '../_playerdna/markets.js';
import { playerMedia, teamBlock } from '../_playerdna/media.js';

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

function windowSplit(rows, market, line, label) {
  const t = propThreshold(rows, market, line);
  if (!t.available) return { label, available: false, games: 0, reason: t.reason };
  return {
    label, available: true, total: t.total, over: t.over, under: t.under, push: t.push,
    over_pct: t.over_pct, mean: t.mean, median: t.median,
    statement: `${t.over}/${t.total} over ${line}`, sample_label: t.sample_label
  };
}

function tdWindow(rows, label) {
  const t = tdHistory(rows);
  if (!t.available) return { label, available: false, games: 0, reason: t.reason };
  return {
    label, available: true, total: t.total, td_games: t.td_games,
    no_td_games: t.no_td_games, td_game_rate: t.td_game_rate,
    statement: t.statement, sample_label: t.sample_label
  };
}

export default async function handler(req, res) {
  const q = req.query || {};
  const found = resolvePlayer({ player_id: q.player_id, gsis_id: q.gsis_id,
                                espn_id: q.espn_id, name: q.name });
  if (!found.player) {
    return send(res, 404, { ok: false, error: 'player_not_resolved', detail: found.reason });
  }
  const p = found.player;
  const rows = gamesFor(p.gsis_id);
  const identity = {
    gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, name: p.display_name,
    position: p.position ?? 'TE', matched_by: found.matched_by,
    media: playerMedia(p.espn_id),
    team: teamBlock(p.team_2026 || (rows.length ? rows[rows.length - 1].t : null))
  };

  if (!rows.length) {
    return send(res, 200, {
      ok: true, history_available: false, sample_state: 'NFL SAMPLE UNAVAILABLE',
      reason: 'no completed NFL game for this tight end inside our data window',
      player: identity, markets: [], data_window: dataWindow(), provenance: provenance()
    }, 300);
  }
  if (!q.event_id) {
    return send(res, 400, { ok: false, error: 'event_id_required',
      detail: 'the prop lab reads the CURRENT market for a specific game' });
  }

  let board;
  try {
    board = await eventMarkets(String(q.event_id), 'tight_end');
  } catch (e) {
    board = { available: false, state: MARKET_UNAVAILABLE, reason: String(e.message) };
  }
  const mine = board.available ? board.players.find(x => x.gsis_id === p.gsis_id) : null;

  const seasons = [...new Set(rows.map(r => r.s))].sort();
  const latest = seasons[seasons.length - 1];
  const seasonRows = rows.filter(r => r.s === latest);

  let similar = null, similarLabel = null, similarCoverage = null;
  if (q.condition && CONDITIONS[q.condition]) {
    const sp = splitRows(rows, String(q.condition));
    similar = sp.rows; similarLabel = sp.label; similarCoverage = sp.coverage || null;
  }

  const cards = Object.values(RECEIVING_MARKET_MAP).map(market => {
    const offered = mine ? mine.markets[market] : null;
    const isTd = market === 'anytime_td';
    const label = isTd ? 'Anytime TD' : MARKETS[market].label;

    if (!offered) {
      return { market, market_label: label, available: false, state: MARKET_UNAVAILABLE,
        reason: board.available
          ? 'no book in the current market is offering this market for this tight end'
          : (board.reason || 'the market source returned nothing for this game') };
    }

    if (isTd) {
      /* Anytime TD carries a PRICE, not a line. It is represented as a count of
         touchdown games, and the price is labelled as a price. */
      return {
        market, market_label: label, available: true, kind: 'price',
        market_price: offered.line ?? null,
        line: null,
        line_source: { source: 'current_market', gateway_market: offered.gateway_market,
                       books: offered.book_count },
        windows: {
          career: tdWindow(rows, 'Career'),
          current_season: { ...tdWindow(seasonRows, `${latest} season`), season: latest },
          last_10: tdWindow(rows.slice(-10), 'Last 10'),
          last_5: tdWindow(rows.slice(-5), 'Last 5'),
          similar_conditions: similar
            ? { ...tdWindow(similar, similarLabel || 'Similar conditions'),
                condition: q.condition, coverage: similarCoverage }
            : { label: 'Similar conditions', available: false, games: 0,
                reason: 'no condition window supplied for this game' }
        },
        distribution: rows.map(r => ({
          date: r.d, season: r.s, week: r.w, opponent: r.opp, home: r.ha === 1,
          value: r.rtd ?? 0, outcome: (r.rtd ?? 0) > 0 ? 'TD' : 'NO TD' })),
        note: 'A count of games with a receiving touchdown. Not an implied '
            + 'probability, and not comparable to a bookmaker price.'
      };
    }

    if (!Number.isFinite(Number(offered.line))) {
      return { market, market_label: label, available: false, state: MARKET_UNAVAILABLE,
               reason: 'the current market carries no numeric line for this market' };
    }
    const line = Number(offered.line);
    const k = MARKETS[market].key;
    return {
      market, market_label: label, available: true, kind: 'threshold', line,
      line_source: { source: 'current_market', gateway_market: offered.gateway_market,
                     books: offered.book_count, line_low: offered.line_low,
                     line_high: offered.line_high },
      windows: {
        career: windowSplit(rows, market, line, 'Career'),
        current_season: { ...windowSplit(seasonRows, market, line, `${latest} season`), season: latest },
        last_10: windowSplit(rows.slice(-10), market, line, 'Last 10'),
        last_5: windowSplit(rows.slice(-5), market, line, 'Last 5'),
        similar_conditions: similar
          ? { ...windowSplit(similar, market, line, similarLabel || 'Similar conditions'),
              condition: q.condition, coverage: similarCoverage }
          : { label: 'Similar conditions', available: false, games: 0,
              reason: 'no condition window supplied for this game' }
      },
      distribution: rows.filter(r => typeof r[k] === 'number').map(r => ({
        date: r.d, season: r.s, week: r.w, opponent: r.opp, home: r.ha === 1,
        value: r[k], outcome: r[k] > line ? 'OVER' : r[k] < line ? 'UNDER' : 'PUSH',
        roof: r.rf ?? null, temp_f: r.tf ?? null, wind_mph: r.wd ?? null,
        environment_status: r.ws ?? 'not_resolved' }))
    };
  });

  send(res, 200, {
    ok: true, history_available: true, player: identity,
    event_id: String(q.event_id), event: board.event || null,
    markets: cards,
    offered_count: cards.filter(c => c.available).length,
    unavailable_count: cards.filter(c => !c.available).length,
    market_source: board.source || null,
    disclosure: {
      wording: 'Historical clear rate',
      caveat: 'Counts of completed games against the current number. Not a '
            + 'probability for the next game, not a projection, not betting advice, '
            + 'and not a PropBetEdge model pick.'
    },
    data_window: dataWindow(), provenance: provenance()
  }, 120);
}
