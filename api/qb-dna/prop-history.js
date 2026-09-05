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
import { resolvePlayer, gamesFor, propThreshold, splitRows, provenance,
         MARKETS, CONDITIONS, SAMPLE } from '../_qbdna/engine.js';

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

export default function handler(req, res) {
  const q = req.query || {};
  const market = String(q.market || 'passing_yards');
  if (!MARKETS[market]) {
    return send(res, 400, { ok: false, error: 'unsupported_market',
      supported: Object.keys(MARKETS),
      detail: 'A market is supported only when its outcome is a counted per-game column.' });
  }
  if (q.line === undefined || q.line === '' || !Number.isFinite(Number(q.line))) {
    return send(res, 400, { ok: false, error: 'line_required' });
  }
  const line = Number(q.line);

  const found = resolvePlayer({ player_id: q.player_id, gsis_id: q.gsis_id,
                                espn_id: q.espn_id, name: q.name });
  if (!found.player) {
    return send(res, 404, { ok: false, error: 'player_not_resolved', detail: found.reason });
  }
  const p = found.player;
  let rows = gamesFor(p.gsis_id);
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
    provenance: provenance()
  }, 300);
}
