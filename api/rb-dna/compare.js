/* GET /api/rb-dna/compare
 *
 *  mode=players  ?player_a=00-0034844&player_b=00-0036223
 *      Two backs side by side on their own baselines, plus how each one moves
 *      in every condition relative to HIS OWN average.
 *
 *  mode=context  ?player_id=...&roof=outdoors&temp_f=52&wind_mph=9&home=true
 *                &opponent=GB&primetime=false
 *      This game's conditions placed against that back's own history.
 *
 * Every comparison carries both sides' N. A window with no games is reported
 * available:false with a reason; it is never reported as zero.
 */
import { resolvePlayer, gamesFor, baseline, splitRows, provenance, dataWindow,
         CONDITIONS, SAMPLE } from '../_rbdna/engine.js';
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

const bool = v => v === true || v === 'true' || v === '1';
const numOrNull = v => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function contextWindows(ctx) {
  const on = [], skipped = [];
  const roof = ctx.roof ? String(ctx.roof).toLowerCase() : null;
  const indoor = roof === 'dome' || roof === 'closed';

  if (ctx.home === null) skipped.push({ condition: 'home/road', reason: 'no home flag supplied' });
  else on.push(ctx.home ? 'home' : 'road');

  if (!roof) skipped.push({ condition: 'roof', reason: 'no roof supplied' });
  else on.push(indoor ? 'dome' : 'outdoor');

  if (indoor) {
    skipped.push({ condition: 'weather', reason: 'roofed game - weather windows do not apply' });
  } else if (!roof) {
    skipped.push({ condition: 'weather', reason: 'roof unknown - cannot decide whether weather applies' });
  } else {
    if (ctx.temp_f === null) skipped.push({ condition: 'temperature', reason: 'no temp_f supplied' });
    else if (ctx.temp_f < 20) on.push('arctic_sub20');
    else if (ctx.temp_f < 32) on.push('freezing_20_32');
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

  /* Spread decides favourite/underdog, and it is DESCRIPTIVE — a record of how
     he was used in games his team was favoured in, not a claim that the number
     causes carries. */
  if (ctx.spread === null) skipped.push({ condition: 'market position', reason: 'no spread supplied' });
  else if (ctx.spread > 0) on.push('favorite');
  else if (ctx.spread < 0) on.push('underdog');

  return { on: [...new Set(on)], skipped };
}

function summarise(rows) {
  const b = baseline(rows);
  if (!b) return null;
  const st = b.scrimmage_yards;
  return {
    games: b.games, wins: b.wins, losses: b.losses,
    scrimmage_yards_avg: st ? st.mean : null,
    scrimmage_yards_median: st ? st.median : null,
    rush_yards_avg: b.rush_yards ? b.rush_yards.mean : null,
    receiving_yards_avg: b.receiving_yards ? b.receiving_yards.mean : null,
    touches_avg: b.touches_per_game ? b.touches_per_game.mean : null,
    carries_avg: b.carries_per_game ? b.carries_per_game.mean : null,
    targets_avg: b.targets_per_game ? b.targets_per_game.mean : null,
    receptions_avg: b.receptions_per_game ? b.receptions_per_game.mean : null,
    carry_share: b.carry_share, target_share: b.target_share,
    rush_share_of_touches: b.rush_share_of_touches,
    yards_per_carry: b.yards_per_carry, yards_per_touch: b.yards_per_touch,
    catch_rate: b.catch_rate,
    rz_carries: b.rz_carries, fumble_rate: b.fumble_rate,
    td_games: b.td_games, td_game_rate: b.td_game_rate,
    total_tds: b.total_tds,
    sample_label: SAMPLE(b.games)
  };
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

  const ident = (r, rows) => ({
    gsis_id: r.player.gsis_id, espn_id: r.player.espn_id ?? null,
    name: r.player.display_name, position: r.player.position ?? 'RB',
    team: rows.length ? rows[rows.length - 1].t : null,
    matched_by: r.matched_by,
    media: playerMedia(r.player.espn_id),
    team_identity: teamBlock(r.player.team_2026 || (rows.length ? rows[rows.length - 1].t : null))
  });

  const conditions = {};
  for (const key of Object.keys(CONDITIONS)) {
    const sa = splitRows(ra, key), sb = splitRows(rb, key);
    const na = sa.rows.length, nb = sb.rows.length;
    const meta = { key, group: CONDITIONS[key].group,
                   rollup: Boolean(CONDITIONS[key].rollup), label: CONDITIONS[key].label };
    if (!na || !nb) {
      conditions[key] = { available: false, ...meta, games_a: na, games_b: nb,
        reason: !na && !nb ? 'neither back has a game in this window'
              : !na ? 'back A has no game in this window'
              : 'back B has no game in this window' };
      continue;
    }
    const a = summarise(sa.rows), b = summarise(sb.rows);
    conditions[key] = {
      available: true, ...meta, a, b,
      // each side against ITS OWN baseline — the only honest way to read this
      a_vs_own_baseline: baseA && baseA.scrimmage_yards_avg
        ? +(100 * (a.scrimmage_yards_avg - baseA.scrimmage_yards_avg) / baseA.scrimmage_yards_avg).toFixed(1) : null,
      b_vs_own_baseline: baseB && baseB.scrimmage_yards_avg
        ? +(100 * (b.scrimmage_yards_avg - baseB.scrimmage_yards_avg) / baseB.scrimmage_yards_avg).toFixed(1) : null,
      sample_label_a: SAMPLE(na), sample_label_b: SAMPLE(nb),
      coverage_a: sa.coverage || undefined, coverage_b: sb.coverage || undefined
    };
  }

  send(res, 200, {
    ok: true, mode: 'players',
    player_a: ident(A, ra), player_b: ident(B, rb),
    baseline: { a: baseA, b: baseB },
    conditions,
    comparison_metric: 'scrimmage_yards',
    data_window: dataWindow(), provenance: provenance()
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
    roof: q.roof || null, temp_f: numOrNull(q.temp_f), wind_mph: numOrNull(q.wind_mph),
    precip: q.precip ? String(q.precip).toLowerCase() : null,
    home: q.home === undefined ? null : bool(q.home),
    opponent: q.opponent ? String(q.opponent).toUpperCase() : null,
    primetime: q.primetime === undefined ? null : bool(q.primetime),
    divisional: q.divisional === undefined ? null : bool(q.divisional),
    spread: numOrNull(q.spread)
  };
  const base = summarise(rows);
  const { on, skipped } = contextWindows(ctx);

  const windows = {};
  for (const key of on) {
    const s = splitRows(rows, key);
    const n = s.rows.length;
    if (!n) {
      windows[key] = { available: false, label: CONDITIONS[key].label, games: 0,
        reason: 'this back has no game in this window', coverage: s.coverage || undefined };
      continue;
    }
    const w = summarise(s.rows);
    const have = Boolean(base && base.scrimmage_yards_avg && w.scrimmage_yards_avg !== null);
    const pct = have
      ? (100 * (w.scrimmage_yards_avg - base.scrimmage_yards_avg) / base.scrimmage_yards_avg) : null;
    windows[key] = {
      available: true, label: CONDITIONS[key].label, games: n, ...w,
      vs_baseline: have
        ? { window_avg: w.scrimmage_yards_avg, baseline_avg: base.scrimmage_yards_avg,
            diff: +(w.scrimmage_yards_avg - base.scrimmage_yards_avg).toFixed(1),
            pct: +pct.toFixed(1), n_window: n, n_baseline: base.games }
        : null,
      statement: have
        ? `${w.scrimmage_yards_avg.toFixed(1)} avg vs ${base.scrimmage_yards_avg.toFixed(1)} baseline `
          + `· ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% · N=${n} · ${SAMPLE(n)}`
        : null,
      sample_label: SAMPLE(n), coverage: s.coverage || undefined
    };
  }

  let vsOpponent = null;
  if (ctx.opponent) {
    const opp = rows.filter(r => r.opp === ctx.opponent);
    const o = opp.length ? summarise(opp) : null;
    vsOpponent = opp.length
      ? { available: true, opponent: ctx.opponent, games: opp.length, ...o,
          vs_baseline_pct: base && base.scrimmage_yards_avg
            ? +(100 * (o.scrimmage_yards_avg - base.scrimmage_yards_avg) / base.scrimmage_yards_avg).toFixed(1)
            : null,
          sample_label: SAMPLE(opp.length) }
      : { available: false, opponent: ctx.opponent, games: 0,
          reason: 'no game against this opponent in this dataset' };
  }

  send(res, 200, {
    ok: true, mode: 'context',
    player: { gsis_id: found.player.gsis_id, espn_id: found.player.espn_id ?? null,
              name: found.player.display_name, matched_by: found.matched_by,
              media: playerMedia(found.player.espn_id),
              team: teamBlock(found.player.team_2026) },
    game_context: ctx, baseline: base, comparison_metric: 'scrimmage_yards',
    matched_windows: on, unevaluated: skipped, windows, vs_opponent: vsOpponent,
    data_window: dataWindow(), provenance: provenance()
  }, 300);
}

export default function handler(req, res) {
  const q = req.query || {};
  const mode = q.mode || (q.player_a || q.name_a ? 'players' : 'context');
  if (mode === 'players') return playersMode(res, q);
  if (mode === 'context') return contextMode(res, q);
  return send(res, 400, { ok: false, error: 'unknown_mode', supported: ['players', 'context'] });
}
