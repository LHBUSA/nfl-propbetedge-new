/* GET /api/qb-dna/compare
 *
 * Two modes.
 *
 *  mode=players   ?player_a=00-0033873&player_b=00-0034857
 *      Two quarterbacks side by side on their own baselines, plus the games in
 *      which they ACTUALLY faced each other (a real intersection of game ids,
 *      not a notional matchup).
 *
 *  mode=context   ?player_id=00-0033873&roof=outdoors&temp_f=28&wind_mph=14
 *                 &home=true&opponent=BUF&primetime=true&divisional=false
 *      Today's game conditions against that quarterback's own history: which
 *      historical windows this game falls into, and how he moved from his
 *      baseline inside each one.
 *
 * Every comparison carries both sides' N. A window with no games is reported
 * available:false with a reason. It is never reported as zero.
 */
import { resolvePlayer, gamesFor, baseline, splitRows, provenance,
         CONDITIONS, MARKETS, SAMPLE } from '../_qbdna/engine.js';

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

const bool = v => v === true || v === 'true' || v === '1';
const numOrNull = v => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/* Which of our real historical windows does a supplied game context fall into?
 * A context field we were not given produces NO window — we never guess that an
 * unspecified game is a dome game, or dry, or a 1pm kick. */
function contextWindows(ctx) {
  const on = [], skipped = [];
  const roof = ctx.roof ? String(ctx.roof).toLowerCase() : null;
  const indoor = roof === 'dome' || roof === 'closed';

  if (ctx.home === null) skipped.push({ condition: 'home/road', reason: 'no home flag supplied' });
  else on.push(ctx.home ? 'home' : 'road');

  if (!roof) skipped.push({ condition: 'roof', reason: 'no roof supplied' });
  else on.push(indoor ? 'dome' : 'outdoor');

  // Weather windows apply to outdoor games only, exactly as the splits are built.
  if (indoor) {
    skipped.push({ condition: 'weather', reason: 'roofed game - weather windows do not apply' });
  } else if (!roof) {
    skipped.push({ condition: 'weather', reason: 'roof unknown - cannot decide whether weather applies' });
  } else {
    if (ctx.temp_f === null) skipped.push({ condition: 'temperature', reason: 'no temp_f supplied' });
    else if (ctx.temp_f < 32) on.push('below_freezing');
    else if (ctx.temp_f <= 50) on.push('cold_33_50');
    else if (ctx.temp_f <= 70) on.push('mild_51_70');
    else on.push('warm_70_plus');

    if (ctx.wind_mph === null) skipped.push({ condition: 'wind', reason: 'no wind_mph supplied' });
    else if (ctx.wind_mph >= 20) on.push('wind_20_plus');
    else if (ctx.wind_mph >= 15) on.push('wind_15_plus');
    else if (ctx.wind_mph >= 10) on.push('wind_10_plus');

    if (ctx.precip === null) skipped.push({ condition: 'precipitation', reason: 'no precip supplied' });
    else if (ctx.precip === 'snow') on.push('snow');
    else if (ctx.precip === 'rain') on.push('rain');
    else if (ctx.precip === 'none') on.push('dry');
  }

  if (ctx.primetime === true) on.push('primetime');
  else if (ctx.primetime === null) skipped.push({ condition: 'primetime', reason: 'no kickoff hour supplied' });

  if (ctx.divisional === true) on.push('divisional');
  else if (ctx.divisional === null) skipped.push({ condition: 'divisional', reason: 'not supplied' });

  return { on: [...new Set(on)], skipped };
}

function summarise(rows) {
  const b = baseline(rows);
  if (!b) return null;
  const st = b.passing_yards;
  return {
    games: b.games,
    wins: b.wins, losses: b.losses,
    passing_yards_avg: st ? st.mean : null,
    passing_yards_median: st ? st.median : null,
    attempts_avg: b.attempts_per_game ? b.attempts_per_game.mean : null,
    completion_pct: b.completion_pct,
    ypa: b.ypa,
    td_rate: b.td_rate,
    int_rate: b.int_rate,
    sack_rate: b.sack_rate,
    tds_avg: b.tds_per_game ? b.tds_per_game.mean : null,
    ints_avg: b.ints_per_game ? b.ints_per_game.mean : null,
    sample_label: SAMPLE(b.games)
  };
}

/* A delta always states both sides and both Ns, so a -13% built on 3 games can
 * never be read as if it were built on 30. */
function delta(a, b, field) {
  const av = a && a[field], bv = b && b[field];
  if (typeof av !== 'number' || typeof bv !== 'number') {
    return { available: false, reason: 'one side has no value for this field' };
  }
  return {
    available: true, a: av, b: bv,
    diff: +(av - bv).toFixed(2),
    pct: bv === 0 ? null : +(100 * (av - bv) / Math.abs(bv)).toFixed(1),
    n_a: a.games ?? null, n_b: b.games ?? null,
    sample_label_a: a.games != null ? SAMPLE(a.games) : null,
    sample_label_b: b.games != null ? SAMPLE(b.games) : null
  };
}

const FIELDS = ['passing_yards_avg', 'attempts_avg', 'tds_avg', 'ints_avg'];
function deltaSet(a, b) {
  const out = {};
  for (const f of FIELDS) out[f] = delta(a, b, f);
  // rate objects compare on their pct, keeping numerator/denominator visible
  for (const f of ['completion_pct', 'td_rate', 'int_rate', 'sack_rate']) {
    const av = a && a[f], bv = b && b[f];
    out[f] = (av && bv && av.pct !== null && bv.pct !== null)
      ? { available: true, a: av, b: bv, diff_pts: +(av.pct - bv.pct).toFixed(1),
          n_a: a.games ?? null, n_b: b.games ?? null }
      : { available: false, reason: 'a rate with no denominator on one side' };
  }
  // ypa is a ratio in yards, not a percentage — it differences in its own units
  const ya = a && a.ypa, yb = b && b.ypa;
  out.ypa = (ya && yb && ya.value !== null && yb.value !== null)
    ? { available: true, a: ya, b: yb, diff: +(ya.value - yb.value).toFixed(2),
        unit: 'yards per attempt', n_a: a.games ?? null, n_b: b.games ?? null }
    : { available: false, reason: 'a ratio with no denominator on one side' };
  return out;
}

function playersMode(res, q) {
  const A = resolvePlayer({ player_id: q.player_a, espn_id: q.espn_a, name: q.name_a });
  const B = resolvePlayer({ player_id: q.player_b, espn_id: q.espn_b, name: q.name_b });
  if (!A.player) return send(res, 404, { ok: false, error: 'player_a_not_resolved', detail: A.reason });
  if (!B.player) return send(res, 404, { ok: false, error: 'player_b_not_resolved', detail: B.reason });
  if (A.player.gsis_id === B.player.gsis_id) {
    return send(res, 400, { ok: false, error: 'same_player' });
  }

  let ra = gamesFor(A.player.gsis_id), rb = gamesFor(B.player.gsis_id);
  if (q.season) {
    const s = Number(q.season);
    ra = ra.filter(r => r.s === s); rb = rb.filter(r => r.s === s);
  }

  const baseA = summarise(ra), baseB = summarise(rb);

  // real head-to-head: the same game id appears in both players' logs
  const idsB = new Set(rb.map(r => r.g));
  const idsA = new Set(ra.map(r => r.g));
  const h2hA = ra.filter(r => idsB.has(r.g));
  const h2hB = rb.filter(r => idsA.has(r.g));

  const hA = summarise(h2hA), hB = summarise(h2hB);
  const headToHead = h2hA.length
    ? {
        available: true, games: h2hA.length,
        a: hA, b: hB, deltas: deltaSet(hA, hB),
        sample_label: SAMPLE(h2hA.length),
        meetings: h2hA.map(r => {
          const bm = h2hB.find(x => x.g === r.g);
          return {
            game_id: r.g, date: r.d, season: r.s, week: r.w,
            a: { team: r.t, home: r.ha === 1, passing_yards: r.py ?? null,
                 attempts: r.att ?? null, td: r.td ?? null, int: r.int ?? null,
                 result: r.win === 1 ? 'W' : r.win === 0 ? 'L' : null },
            b: bm ? { team: bm.t, home: bm.ha === 1, passing_yards: bm.py ?? null,
                      attempts: bm.att ?? null, td: bm.td ?? null, int: bm.int ?? null,
                      result: bm.win === 1 ? 'W' : bm.win === 0 ? 'L' : null } : null
          };
        }).reverse()
      }
    : { available: false, games: 0,
        reason: 'these two quarterbacks have not appeared in the same game in this dataset' };

  const conditions = {};
  for (const key of Object.keys(CONDITIONS)) {
    const sa = splitRows(ra, key), sb = splitRows(rb, key);
    const na = sa.rows.length, nb = sb.rows.length;
    if (!na || !nb) {
      conditions[key] = { available: false, label: CONDITIONS[key].label,
        games_a: na, games_b: nb,
        reason: !na && !nb ? 'neither quarterback has a game in this window'
              : !na ? 'player A has no game in this window'
              : 'player B has no game in this window' };
      continue;
    }
    const a = summarise(sa.rows), b = summarise(sb.rows);
    conditions[key] = {
      available: true, label: CONDITIONS[key].label,
      a, b, deltas: deltaSet(a, b),
      // each side against ITS OWN baseline - the only honest way to read a split
      a_vs_own_baseline: baseA && baseA.passing_yards_avg
        ? +(100 * (a.passing_yards_avg - baseA.passing_yards_avg) / baseA.passing_yards_avg).toFixed(1) : null,
      b_vs_own_baseline: baseB && baseB.passing_yards_avg
        ? +(100 * (b.passing_yards_avg - baseB.passing_yards_avg) / baseB.passing_yards_avg).toFixed(1) : null,
      sample_label_a: SAMPLE(na), sample_label_b: SAMPLE(nb),
      coverage_a: sa.coverage || undefined, coverage_b: sb.coverage || undefined
    };
  }

  send(res, 200, {
    ok: true, mode: 'players',
    player_a: { gsis_id: A.player.gsis_id, espn_id: A.player.espn_id ?? null,
                name: A.player.display_name, team: ra.length ? ra[ra.length - 1].t : null,
                matched_by: A.matched_by },
    player_b: { gsis_id: B.player.gsis_id, espn_id: B.player.espn_id ?? null,
                name: B.player.display_name, team: rb.length ? rb[rb.length - 1].t : null,
                matched_by: B.matched_by },
    baseline: { a: baseA, b: baseB, deltas: deltaSet(baseA, baseB) },
    head_to_head: headToHead,
    conditions,
    provenance: provenance()
  }, 300);
}

function contextMode(res, q) {
  const found = resolvePlayer({ player_id: q.player_id, gsis_id: q.gsis_id,
                                espn_id: q.espn_id, name: q.name });
  if (!found.player) {
    return send(res, 404, { ok: false, error: 'player_not_resolved', detail: found.reason });
  }
  const rows = gamesFor(found.player.gsis_id);
  if (!rows.length) return send(res, 404, { ok: false, error: 'no_games_for_player' });

  const ctx = {
    roof: q.roof || null,
    temp_f: numOrNull(q.temp_f),
    wind_mph: numOrNull(q.wind_mph),
    precip: q.precip ? String(q.precip).toLowerCase() : null,
    home: q.home === undefined ? null : bool(q.home),
    opponent: q.opponent ? String(q.opponent).toUpperCase() : null,
    primetime: q.primetime === undefined ? null : bool(q.primetime),
    divisional: q.divisional === undefined ? null : bool(q.divisional)
  };
  const base = summarise(rows);
  const { on, skipped } = contextWindows(ctx);

  const windows = {};
  for (const key of on) {
    const s = splitRows(rows, key);
    const n = s.rows.length;
    if (!n) {
      windows[key] = { available: false, label: CONDITIONS[key].label, games: 0,
        reason: 'this quarterback has no game in this window',
        coverage: s.coverage || undefined };
      continue;
    }
    const w = summarise(s.rows);
    const haveBase = Boolean(base && base.passing_yards_avg && w.passing_yards_avg !== null);
    const pct = haveBase
      ? (100 * (w.passing_yards_avg - base.passing_yards_avg) / base.passing_yards_avg) : null;
    windows[key] = {
      available: true, label: CONDITIONS[key].label, games: n, ...w,
      vs_baseline: haveBase
        ? { window_avg: w.passing_yards_avg, baseline_avg: base.passing_yards_avg,
            diff: +(w.passing_yards_avg - base.passing_yards_avg).toFixed(1),
            pct: +pct.toFixed(1), n_window: n, n_baseline: base.games }
        : null,
      // the sentence the UI is allowed to print - never "struggles in snow"
      statement: haveBase
        ? `${w.passing_yards_avg.toFixed(1)} avg vs ${base.passing_yards_avg.toFixed(1)} baseline `
          + `· ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% · N=${n} · ${SAMPLE(n)}`
        : null,
      sample_label: SAMPLE(n),
      coverage: s.coverage || undefined
    };
  }

  // history against this specific opponent, if one was named
  let vsOpponent = null;
  if (ctx.opponent) {
    const opp = rows.filter(r => (r.ha === 1 ? r.a : r.h) === ctx.opponent);
    const o = opp.length ? summarise(opp) : null;
    vsOpponent = opp.length
      ? { available: true, opponent: ctx.opponent, games: opp.length, ...o,
          vs_baseline_pct: base && base.passing_yards_avg
            ? +(100 * (o.passing_yards_avg - base.passing_yards_avg) / base.passing_yards_avg).toFixed(1)
            : null,
          game_log: opp.map(r => ({ game_id: r.g, date: r.d, season: r.s, week: r.w,
            home: r.ha === 1, passing_yards: r.py ?? null, attempts: r.att ?? null,
            td: r.td ?? null, int: r.int ?? null,
            result: r.win === 1 ? 'W' : r.win === 0 ? 'L' : null })).reverse(),
          sample_label: SAMPLE(opp.length) }
      : { available: false, opponent: ctx.opponent, games: 0,
          reason: 'no game against this opponent in this dataset' };
  }

  send(res, 200, {
    ok: true, mode: 'context',
    player: { gsis_id: found.player.gsis_id, espn_id: found.player.espn_id ?? null,
              name: found.player.display_name, matched_by: found.matched_by },
    game_context: ctx,
    baseline: base,
    matched_windows: on,
    // what we could NOT evaluate, and why - stated rather than silently omitted
    unevaluated: skipped,
    windows,
    vs_opponent: vsOpponent,
    provenance: provenance()
  }, 300);
}

export default function handler(req, res) {
  const q = req.query || {};
  const mode = q.mode || (q.player_a || q.name_a ? 'players' : 'context');
  if (mode === 'players') return playersMode(res, q);
  if (mode === 'context') return contextMode(res, q);
  return send(res, 400, { ok: false, error: 'unknown_mode', supported: ['players', 'context'] });
}
