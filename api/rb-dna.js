/* GET /api/rb-dna
 *   ?player_id=00-0034844            GSIS id (preferred)
 *   ?espn_id=3929630                 ESPN athlete id
 *   ?name=Saquon%20Barkley           exact name only, never fuzzy
 *   ?list=1                          the backs this dataset can answer for
 *
 * Baseline, USAGE DNA, recency, condition matrix, DNA signals and form series.
 * Sibling of /api/qb-dna and /api/wr-dna, with the metric set a running back
 * is actually judged on: touches, shares and scrimmage yards rather than
 * rushing yards alone.
 */
import { resolvePlayer, gamesFor, baseline, conditionProfile, dnaSignals,
         usageProfile, provenance, dataWindow, SAMPLE, dataset }
  from './_rbdna/engine.js';
import { playerMedia, teamBlock } from './_playerdna/media.js';

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

/** A window with its own N, saying how short it is when it cannot be filled. */
function windowOf(rows, want, label) {
  const take = want === null ? rows : rows.slice(-want);
  const b = baseline(take);
  if (!b) return { label, requested: want, games: 0, available: false,
                   reason: 'no games in this window' };
  return {
    label, requested: want, games: b.games, available: true,
    complete: want === null || b.games >= want,
    shortfall_note: (want !== null && b.games < want)
      ? `only ${b.games} game${b.games === 1 ? '' : 's'} exist, not ${want}` : null,
    ...b
  };
}

export default function handler(req, res) {
  const q = req.query || {};

  if (q.list) {
    const D = dataset();
    const rows = D.players.map(p => {
      const g = gamesFor(p.gsis_id);
      return {
        gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, pfr_id: p.pfr_id ?? null,
        name: p.display_name, position: p.position ?? 'RB',
        team: g.length ? g[g.length - 1].t : null,
        games: g.length,
        seasons: [...new Set(g.map(r => r.s))].sort(),
        last_game: g.length ? g[g.length - 1].d : null,
        active_2026: Boolean(p.active_2026),
        team_2026: p.team_2026 ?? null,
        market_priced_2026: Boolean(p.market_priced_2026),
        experience_years: p.experience_years ?? null,
        history_available: g.length > 0,
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
      position_scope: D.meta.position_scope,
      data_window: dataWindow(), provenance: provenance()
    }, 600);
  }

  const found = resolvePlayer({ player_id: q.player_id, gsis_id: q.gsis_id,
                               espn_id: q.espn_id, name: q.name });
  if (!found.player) {
    return send(res, 404, { ok: false, error: 'player_not_resolved', detail: found.reason,
                            candidates: found.candidates || undefined });
  }
  const p = found.player;
  let rows = gamesFor(p.gsis_id);

  const identity = {
    gsis_id: p.gsis_id, espn_id: p.espn_id ?? null, pfr_id: p.pfr_id ?? null,
    name: p.display_name, position: p.position ?? 'RB',
    current_team: p.team_2026 || (rows.length ? rows[rows.length - 1].t : null),
    active_2026: Boolean(p.active_2026),
    market_priced_2026: Boolean(p.market_priced_2026),
    experience_years: p.experience_years ?? null,
    matched_by: found.matched_by,
    media: playerMedia(p.espn_id),
    team: teamBlock(p.team_2026 || (rows.length ? rows[rows.length - 1].t : null))
  };

  /* A back on a 2026 roster with no NFL history is a real, expected state.
     It is a 200 that says so, never zeros, and never college numbers. */
  if (!rows.length) {
    return send(res, 200, {
      ok: true, history_available: false, sample_state: 'NFL SAMPLE UNAVAILABLE',
      reason: p.active_2026
        ? 'This back is on a 2026 roster but has no completed NFL game inside our data window.'
        : 'No completed NFL game for this player inside our data window.',
      player: identity, nfl_games: 0,
      baseline: null, usage_dna: null, recent: null, conditions: null,
      dna_signals: null, game_log: [],
      disclosure: 'College and preseason statistics are not substituted for NFL history.',
      data_window: dataWindow(), provenance: provenance()
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
  const profile = conditionProfile(rows, 1);
  const base = baseline(rows);

  send(res, 200, {
    ok: true, history_available: true,
    player: identity,
    window: { seasons, games: rows.length, date_range: [rows[0].d, rows[rows.length - 1].d] },
    baseline: base,
    /* The dimension a back product has that neither the QB nor the WR one does:
       how much of his team's work he takes, and in what mix. */
    usage_dna: {
      career: usageProfile(rows),
      current_season: { season: latest, ...usageProfile(seasonRows) },
      last_5: usageProfile(rows.slice(-5)),
      mix_note: 'Rush share of touches separates a between-the-tackles back from a '
              + 'passing-down back. It is a share of HIS OWN touches, not of the team.',
      withheld: [
        { field: 'snap share',
          reason: 'the nflverse participation file is ~37% covered for 2019-2022 and '
                + 'is not published for 2024-2025' },
        { field: 'routes run', reason: 'same participation file, withheld for the same reason' }
      ]
    },
    recent: {
      last_5: windowOf(rows, 5, 'Last 5'),
      last_10: windowOf(rows, 10, 'Last 10'),
      current_season: { ...windowOf(seasonRows, null, `${latest} season`), season: latest },
      career: windowOf(rows, null, 'Career in window')
    },
    conditions: profile.conditions,
    condition_groups: profile.groups,
    dna_signals: dnaSignals(profile),
    /* Chart series, computed here so the surface draws rather than calculates.
       Scrimmage yards is the series, because a back's game is both halves. */
    form_series: {
      metric: 'scrimmage_yards',
      mean: profile.baseline_mean,
      median: (base.scrimmage_yards || {}).median ?? null,
      games: rows.slice(-20).map(r => ({
        date: r.d, season: r.s, week: r.w, opponent: r.opp, home: r.ha === 1,
        value: (r.ry ?? 0) + (r.recy ?? 0),
        rush_yards: r.ry ?? null, receiving_yards: r.recy ?? null,
        carries: r.car ?? null, targets: r.tg ?? null,
        touches: (r.car ?? 0) + (r.rec ?? 0),
        touchdowns: (r.rtd ?? 0) + (r.rectd ?? 0),
        result: r.win === 1 ? 'W' : r.win === 0 ? 'L' : null
      }))
    },
    game_log: rows.slice(-12).map(r => ({
      game_id: r.g, date: r.d, season: r.s, week: r.w, team: r.t,
      opponent: r.opp, home: r.ha === 1,
      carries: r.car ?? null, rush_yards: r.ry ?? null, rush_tds: r.rtd ?? null,
      targets: r.tg ?? null, receptions: r.rec ?? null,
      receiving_yards: r.recy ?? null, receiving_tds: r.rectd ?? null,
      touches: (r.car ?? 0) + (r.rec ?? 0),
      scrimmage_yards: (r.ry ?? 0) + (r.recy ?? 0),
      rz_carries: r.rzc ?? null, fumbles_lost: r.fum ?? null,
      team_carries: r.tc ?? null, team_targets: r.tt ?? null,
      team_carry_leader: r.lead === 1,
      result: r.win === 1 ? 'W' : r.win === 0 ? 'L' : null,
      roof: r.rf ?? null, temp_f: r.tf ?? null, wind_mph: r.wd ?? null,
      environment_status: r.ws ?? 'not_resolved'
    })).reverse(),
    sample: {
      baseline_games: profile.baseline_n, baseline_mean: profile.baseline_mean,
      baseline_metric: 'scrimmage_yards',
      label: SAMPLE(rows.length),
      scale: { 'STRONG SAMPLE': 'N>=20', 'MODERATE SAMPLE': 'N 10-19',
               'SMALL SAMPLE': 'N 5-9', 'VERY SMALL SAMPLE': 'N<5' }
    },
    data_window: dataWindow(),
    provenance: provenance()
  }, 300);
}
