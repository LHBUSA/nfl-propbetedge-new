/* GET /api/qb-dna/prop-history
 *   ?player_id=00-0033873
 *   &market=passing_yards            passing_yards|passing_attempts|completions|
 *                                    passing_touchdowns|interceptions
 *   &line=274.5                      the threshold under test
 *   &condition=below_freezing        optional, restricts the window
 *   &season=2024                     optional
 *
 * Answers ONE question: how often did this outcome clear this number, and over
 * how many games. It reports a hit count against a total. It does not price,
 * predict, or recommend, and it never emits a percentage without its N.
 */
import { resolvePlayer, gamesFor, propThreshold, splitRows, provenance, dataWindow,
         MARKETS, CONDITIONS, SAMPLE } from '../_qbdna/engine.js';
import { playerMarkets, MARKET_UNAVAILABLE } from '../_qbdna/markets.js';

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

export default async function handler(req, res) {
  const q = req.query || {};
  const market = String(q.market || 'passing_yards');
  if (!MARKETS[market]) {
    return send(res, 400, { ok: false, error: 'unsupported_market',
      supported: Object.keys(MARKETS),
      detail: 'A market is supported only when its outcome is a counted per-game column.' });
  }
  const found = resolvePlayer({ player_id: q.player_id, gsis_id: q.gsis_id,
                                espn_id: q.espn_id, name: q.name });
  if (!found.player) {
    return send(res, 404, { ok: false, error: 'player_not_resolved', detail: found.reason });
  }
  const p = found.player;
  let rows = gamesFor(p.gsis_id);

  // No NFL history is a real state, not an error. It is never a zero hit rate.
  if (!rows.length) {
    return send(res, 200, {
      ok: true, history_available: false, sample_state: 'NFL SAMPLE UNAVAILABLE',
      reason: 'no completed NFL game for this quarterback inside our data window',
      player: { gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, name: p.display_name,
                active_2026: Boolean(p.active_2026), matched_by: found.matched_by },
      market, market_label: MARKETS[market].label,
      full_history: { available: false, reason: 'no games' },
      data_window: dataWindow(), provenance: provenance()
    }, 300);
  }

  /* THE LINE.
     Precedence: an explicitly supplied line, otherwise the CURRENT MARKET line
     for the given event. There is no third option — no default, no rounded
     season average, nothing invented. A market that is not offered returns
     CURRENT MARKET UNAVAILABLE and no calculation is performed against it. */
  let line = null, lineSource = null, marketBlock = null;
  if (q.line !== undefined && q.line !== '' && Number.isFinite(Number(q.line))) {
    line = Number(q.line);
    lineSource = { source: 'supplied', note: 'line supplied by the caller' };
  } else if (q.event_id) {
    marketBlock = await playerMarkets(String(q.event_id), p.gsis_id);
    const offered = marketBlock.available ? marketBlock.markets[market] : null;
    if (offered && Number.isFinite(Number(offered.line))) {
      line = Number(offered.line);
      lineSource = {
        source: 'current_market', gateway_market: offered.gateway_market,
        books: offered.book_count, line_low: offered.line_low, line_high: offered.line_high,
        provider_last_update: marketBlock.source && marketBlock.source.provider_last_update
      };
    } else {
      return send(res, 200, {
        ok: true,
        market, market_label: MARKETS[market].label,
        line: null,
        market_state: MARKET_UNAVAILABLE,
        reason: marketBlock.available
          ? 'the current market is not offering this market for this quarterback in this event'
          : marketBlock.reason,
        player: { gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, name: p.display_name,
                  matched_by: found.matched_by },
        current_market: marketBlock,
        note: 'No default line is inserted. Without a real number there is nothing to count against.',
        data_window: dataWindow(), provenance: provenance()
      }, 120);
    }
  } else {
    return send(res, 400, {
      ok: false, error: 'line_or_event_required',
      detail: 'supply &line=<number>, or &event_id=<id> to use the current market line'
    });
  }

  if (q.season) rows = rows.filter(r => r.s === Number(q.season));

  const full = propThreshold(rows, market, line);

  // optional condition window, applied on top of the full history
  let windowed = null, coverage = null;
  if (q.condition) {
    const key = String(q.condition);
    if (!CONDITIONS[key]) {
      return send(res, 400, { ok: false, error: 'unknown_condition',
                              supported: Object.keys(CONDITIONS) });
    }
    const s = splitRows(rows, key);
    coverage = s.coverage || null;
    windowed = { condition: key, condition_label: s.label, ...propThreshold(s.rows, market, line) };
    // A window that resolved to nothing is UNAVAILABLE, never 0%.
    if (!s.rows.length) {
      windowed = { condition: key, condition_label: s.label, available: false,
                   games: 0, reason: 'no game in this player\'s history matched the condition' };
    }
  }

  const k = KEY[market];
  const hits = rows.filter(r => typeof r[k] === 'number');

  send(res, 200, {
    ok: true,
    player: { gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, name: p.display_name,
              matched_by: found.matched_by },
    market, market_label: MARKETS[market].label, line,
    line_source: lineSource,
    current_market: marketBlock,
    history_available: true,
    full_history: full,
    windowed,
    coverage,
    game_log: hits.slice(-20).map(r => ({
      game_id: r.g, date: r.d, season: r.s, week: r.w,
      opponent: r.ha === 1 ? r.a : r.h, home: r.ha === 1,
      value: r[k],
      outcome: r[k] > line ? 'OVER' : r[k] < line ? 'UNDER' : 'PUSH',
      roof: r.rf ?? null, temp_f: r.tf ?? null, wind_mph: r.wd ?? null,
      environment_status: r.ws ?? 'not_resolved'
    })).reverse(),
    disclosure: {
      statement: full.available ? full.statement : null,
      sample_label: full.available ? SAMPLE(full.total) : null,
      caveat: 'Historical frequency over the games in this dataset. It is not a '
            + 'probability, a projection, or betting advice. Sample labels describe '
            + 'size only.'
    },
    data_window: dataWindow(),
    provenance: provenance()
  }, 300);
}
