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
import { resolvePlayer, gamesFor, baseline, conditionProfile, provenance, dataWindow,
         MARKETS, SAMPLE, dataset } from './_qbdna/engine.js';
import { gateReport, SERVED_FIELDS } from './_qbdna/gating.js';
import { playerMedia, teamBlock } from './_qbdna/media.js';

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

/* LAST 5 / LAST 10 / CURRENT SEASON / CAREER, each with its own N.
   When a window cannot be filled, it says exactly how many games exist rather
   than silently returning a shorter window as if it were the full one. */
function windowOf(rows, want, label) {
  const take = want === null ? rows : rows.slice(-want);
  const b = baseline(take);
  if (!b) return { label, requested: want, games: 0, available: false,
                   reason: 'no games in this window' };
  return {
    label, requested: want, games: b.games,
    available: true,
    complete: want === null || b.games >= want,
    shortfall_note: (want !== null && b.games < want)
      ? `only ${b.games} game${b.games === 1 ? '' : 's'} exist, not ${want}` : null,
    ...b
  };
}

function recency(rows) {
  const seasons = [...new Set(rows.map(r => r.s))].sort();
  const latest = seasons[seasons.length - 1];
  const seasonRows = rows.filter(r => r.s === latest);
  return {
    last_5:  windowOf(rows, 5, 'Last 5'),
    last_10: windowOf(rows, 10, 'Last 10'),
    current_season: { ...windowOf(seasonRows, null, `${latest} season`), season: latest },
    career: windowOf(rows, null, 'Career in window')
  };
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
        last_game: g.length ? g[g.length - 1].d : null,
        // 2026 status, so the UI can offer current starters first and can flag
        // a quarterback who has no NFL history at all
        active_2026: Boolean(p.active_2026),
        team_2026: p.team_2026 ?? null,
        market_priced_2026: Boolean(p.market_priced_2026),
        experience_years: p.experience_years ?? null,
        history_available: g.length > 0,
        // identity media, built from the STABLE ESPN athlete id only
        media: playerMedia(p.espn_id),
        team_media: teamBlock(p.team_2026 || (g.length ? g[g.length - 1].t : null))
      };
    }).sort((a, b) =>
      Number(b.market_priced_2026) - Number(a.market_priced_2026) ||
      Number(b.active_2026) - Number(a.active_2026) ||
      b.games - a.games || a.name.localeCompare(b.name));
    return send(res, 200, {
      ok: true, count: rows.length, players: rows,
      active_2026: rows.filter(r => r.active_2026).length,
      market_priced_2026: rows.filter(r => r.market_priced_2026).length,
      zero_history: rows.filter(r => !r.history_available).length,
      inclusion_rule: D.meta.inclusion_rule,
      data_window: dataWindow(),
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

  /* A quarterback on a 2026 roster with no NFL history is a REAL, expected
     state — a rookie or a first-time starter. It is a 200 that says so, not an
     error, and emphatically not a zero. No college statistics are substituted. */
  if (!rows.length) {
    return send(res, 200, {
      ok: true,
      history_available: false,
      sample_state: 'NFL SAMPLE UNAVAILABLE',
      reason: p.active_2026
        ? 'This quarterback is on a 2026 roster but has no completed NFL regular-season '
          + 'or postseason game inside our data window.'
        : 'No completed NFL game for this player inside our data window.',
      player: {
        gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, pfr_id: p.pfr_id ?? null,
        name: p.display_name, position: p.position ?? null,
        current_team: p.team_2026 ?? null,
        active_2026: Boolean(p.active_2026),
        market_priced_2026: Boolean(p.market_priced_2026),
        experience_years: p.experience_years ?? null,
        matched_by: found.matched_by,
        media: playerMedia(p.espn_id),
        team: teamBlock(p.team_2026)
      },
      nfl_games: 0,
      baseline: null, current_season: null, recent: null,
      conditions: null, game_log: [],
      disclosure: 'College and preseason statistics are not substituted for NFL history.',
      data_window: dataWindow(),
      provenance: provenance()
    }, 300);
  }

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
      active_2026: Boolean(p.active_2026),
      matched_by: found.matched_by,
      // additive identity media; never a fallback mark, null when unresolved
      media: playerMedia(p.espn_id),
      team: teamBlock(p.team_2026 || rows[rows.length - 1].t)
    },
    metric, metric_label: MARKETS[metric].label,
    window: { seasons, games: rows.length, date_range: [rows[0].d, rows[rows.length - 1].d] },
    baseline: baseline(rows),
    career: baseline(rows),
    current_season: { season: latest, ...(baseline(seasonRows) || {}) },
    recent: recency(rows),
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
    history_available: true,
    sample: {
      baseline_games: profile.baseline_n,
      baseline_mean: profile.baseline_mean,
      label: SAMPLE(rows.length),
      scale: { 'STRONG SAMPLE': 'N>=20', 'MODERATE SAMPLE': 'N 10-19',
               'SMALL SAMPLE': 'N 5-9', 'VERY SMALL SAMPLE': 'N<5' }
    },
    // the window this answer covers, so nothing can imply a stale season is current
    data_window: dataWindow(),
    // what is being served, and what is being withheld and why
    served_fields: SERVED_FIELDS,
    advanced_availability: gateReport(seasons),
    provenance: provenance()
  }, 300);
}
