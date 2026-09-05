/* GET /api/qb-dna/prop-lab
 *   ?player_id=00-0033873&event_id=<market event id>
 *   [&condition=warm_70_plus]   optional "similar conditions" window
 *
 * Every CURRENTLY OFFERED quarterback market for this game, in one response,
 * each measured against its own real line over four windows: career, current
 * season, last 10, and the similar-conditions window for this game.
 *
 * Rules that do not move:
 *   · a market nobody is offering gets an explicit unavailable card, never a
 *     card full of zeros, and never an invented line
 *   · every rate carries numerator, denominator and N
 *   · the distribution is the raw per-game outcomes, so a chart draws real
 *     results rather than a curve fitted to them
 */
import { resolvePlayer, gamesFor, propThreshold, splitRows, provenance, dataWindow,
         MARKETS, CONDITIONS, SAMPLE } from '../_qbdna/engine.js';
import { eventMarkets, MARKET_MAP, MARKET_UNAVAILABLE } from '../_qbdna/markets.js';
import { playerMedia, teamBlock } from '../_qbdna/media.js';

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

const KEY = { passing_yards: 'py', passing_attempts: 'att', completions: 'cmp',
              passing_touchdowns: 'td', interceptions: 'int' };

/** over / under / push over one window, always with its N. */
function windowSplit(rows, market, line, label) {
  const t = propThreshold(rows, market, line);
  if (!t.available) {
    return { label, available: false, games: 0, reason: t.reason };
  }
  return {
    label, available: true,
    total: t.total, over: t.over, under: t.under, push: t.push,
    over_pct: t.over_pct, mean: t.mean, median: t.median,
    statement: `${t.over}/${t.total} over ${line}`,
    sample_label: t.sample_label
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
    position: p.position ?? null, matched_by: found.matched_by,
    media: playerMedia(p.espn_id), team: teamBlock(p.team_2026 || (rows.length ? rows[rows.length - 1].t : null))
  };

  if (!rows.length) {
    return send(res, 200, {
      ok: true, history_available: false, sample_state: 'NFL SAMPLE UNAVAILABLE',
      reason: 'no completed NFL game for this quarterback inside our data window',
      player: identity, markets: [], data_window: dataWindow(), provenance: provenance()
    }, 300);
  }

  if (!q.event_id) {
    return send(res, 400, { ok: false, error: 'event_id_required',
      detail: 'the prop lab reads the CURRENT market for a specific game' });
  }

  let board;
  try {
    board = await eventMarkets(String(q.event_id));
  } catch (e) {
    board = { available: false, state: MARKET_UNAVAILABLE, reason: String(e.message) };
  }
  const mine = board.available
    ? board.players.find(x => x.gsis_id === p.gsis_id) : null;

  // windows every market card is measured over
  const seasons = [...new Set(rows.map(r => r.s))].sort();
  const latest = seasons[seasons.length - 1];
  const seasonRows = rows.filter(r => r.s === latest);

  let similar = null, similarLabel = null, similarCoverage = null;
  if (q.condition && CONDITIONS[q.condition]) {
    const sp = splitRows(rows, String(q.condition));
    similar = sp.rows; similarLabel = sp.label; similarCoverage = sp.coverage || null;
  }

  const cards = Object.values(MARKET_MAP).map(market => {
    const offered = mine ? mine.markets[market] : null;
    const label = MARKETS[market].label;
    if (!offered || !Number.isFinite(Number(offered.line))) {
      /* No card of zeros. The market is simply not being offered, and that is
         what the surface says. */
      return {
        market, market_label: label, available: false, state: MARKET_UNAVAILABLE,
        reason: board.available
          ? 'no book in the current market is offering this market for this quarterback'
          : (board.reason || 'the market source returned nothing for this game')
      };
    }
    const line = Number(offered.line);
    const k = KEY[market];
    return {
      market, market_label: label, available: true, line,
      line_source: {
        source: 'current_market', gateway_market: offered.gateway_market,
        books: offered.book_count, line_low: offered.line_low, line_high: offered.line_high
      },
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
      /* Raw per-game outcomes. A chart plots these; it never plots a fitted
         curve, because we are showing what happened, not a model of it. */
      distribution: rows
        .filter(r => typeof r[k] === 'number')
        .map(r => ({ date: r.d, season: r.s, week: r.w,
                     opponent: r.ha === 1 ? r.a : r.h, home: r.ha === 1,
                     value: r[k], outcome: r[k] > line ? 'OVER' : r[k] < line ? 'UNDER' : 'PUSH',
                     roof: r.rf ?? null, temp_f: r.tf ?? null, wind_mph: r.wd ?? null,
                     environment_status: r.ws ?? 'not_resolved' }))
    };
  });

  send(res, 200, {
    ok: true,
    history_available: true,
    player: identity,
    event_id: String(q.event_id),
    event: board.event || null,
    markets: cards,
    offered_count: cards.filter(c => c.available).length,
    unavailable_count: cards.filter(c => !c.available).length,
    market_source: board.source || null,
    disclosure: {
      wording: 'Historical clear rate',
      caveat: 'These are counts of completed games against the current line. '
            + 'They are not a probability for the next game, not a projection, '
            + 'and not betting advice.'
    },
    data_window: dataWindow(),
    provenance: provenance()
  }, 120);
}
