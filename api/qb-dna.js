/* GET /api/qb-dna
 *   ?player_id=00-0033873            GSIS id (preferred)
 *   ?espn_id=3139477                 ESPN athlete id, from a live boxscore
 *   ?name=Patrick%20Mahomes          exact name only, never fuzzy
 *   &season=2024                     optional, restricts the whole response
 *   &metric=passing_yards            which per-game outcome drives the splits
 *
 * Returns player, baseline, current_season, career, conditions, sample metadata
 * and provenance. Every rate carries numerator, denominator and N.
 */
import { resolvePlayer, gamesFor, baseline, conditionProfile, provenance, MARKETS, SAMPLE, dataset }
  from './_qbdna/engine.js';
import { gateReport, SERVED_FIELDS } from './_qbdna/gating.js';

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

export default function handler(req, res) {
  const q = req.query || {};

  // ?list=1 — the quarterbacks this dataset can answer for, and nothing more.
  if (q.list) {
    const D = dataset();
    const rows = D.players.map(p => {
      const g = gamesFor(p.gsis_id);
      return {
        gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, pfr_id: p.pfr_id ?? null,
        name: p.display_name, position: p.position ?? null,
        team: g.length ? g[g.length - 1].t : null,
        games: g.length,
        seasons: [...new Set(g.map(r => r.s))].sort(),
        last_game: g.length ? g[g.length - 1].d : null
      };
    }).sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
    return send(res, 200, {
      ok: true, count: rows.length, players: rows,
      inclusion_rule: 'a quarterback appears here only with 8 or more games as the '
                    + 'primary passer inside the dataset window',
      provenance: provenance()
    }, 600);
  }

  const metric = String(q.metric || 'passing_yards');
  if (!MARKETS[metric]) {
    return send(res, 400, { ok: false, error: 'unsupported_metric', supported: Object.keys(MARKETS) });
  }
  const metricKey = MARKETS[metric].key;

  const found = resolvePlayer({
    player_id: q.player_id, gsis_id: q.gsis_id, espn_id: q.espn_id, name: q.name
  });
  if (!found.player) {
    return send(res, 404, { ok: false, error: 'player_not_resolved', detail: found.reason,
                            candidates: found.candidates || undefined });
  }
  const p = found.player;
  let rows = gamesFor(p.gsis_id);
  if (!rows.length) return send(res, 404, { ok: false, error: 'no_games_for_player' });

  if (q.season) {
    const s = Number(q.season);
    rows = rows.filter(r => r.s === s);
    if (!rows.length) return send(res, 404, { ok: false, error: 'no_games_in_season', season: s });
  }

  const seasons = [...new Set(rows.map(r => r.s))].sort();
  const latest = seasons[seasons.length - 1];
  const seasonRows = rows.filter(r => r.s === latest);
  const profile = conditionProfile(rows, metricKey, 1);

  send(res, 200, {
    ok: true,
    player: {
      pbe_player_id: null,                 // assigned by the canonical layer, not by this prototype
      gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, pfr_id: p.pfr_id ?? null,
      name: p.display_name, position: p.position ?? null,
      current_team: rows[rows.length - 1].t ?? null,
      matched_by: found.matched_by
    },
    metric, metric_label: MARKETS[metric].label,
    window: { seasons, games: rows.length, date_range: [rows[0].d, rows[rows.length - 1].d] },
    baseline: baseline(rows),
    career: baseline(rows),
    current_season: { season: latest, ...(baseline(seasonRows) || {}) },
    recent: { last_5: baseline(rows.slice(-5)), last_10: baseline(rows.slice(-10)) },
    game_log: rows.slice(-12).map(r => ({
      game_id: r.g, date: r.d, season: r.s, week: r.w, team: r.t,
      opponent: r.ha === 1 ? r.a : r.h, home: r.ha === 1,
      attempts: r.att ?? null, completions: r.cmp ?? null,
      passing_yards: r.py ?? null, touchdowns: r.td ?? null, interceptions: r.int ?? null,
      result: r.win === 1 ? 'W' : r.win === 0 ? 'L' : null,
      roof: r.rf ?? null, temp_f: r.tf ?? null, wind_mph: r.wd ?? null,
      environment_status: r.ws ?? 'not_resolved'
    })).reverse(),
    conditions: profile.conditions,
    sample: {
      baseline_games: profile.baseline_n,
      baseline_mean: profile.baseline_mean,
      label: SAMPLE(rows.length),
      scale: { 'STRONG SAMPLE': 'N>=20', 'MODERATE SAMPLE': 'N 10-19',
               'SMALL SAMPLE': 'N 5-9', 'VERY SMALL SAMPLE': 'N<5' }
    },
    // what is being served, and what is being withheld and why
    served_fields: SERVED_FIELDS,
    advanced_availability: gateReport(seasons),
    provenance: provenance()
  }, 300);
}
