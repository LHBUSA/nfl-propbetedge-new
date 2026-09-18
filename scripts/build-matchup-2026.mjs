/* Build the 2026 Matchup Lab data layer.
 *
 *   node scripts/build-matchup-2026.mjs [--season=2026]
 *
 * Writes data/dist/matchup-2026.json: per-team pass/rush/explosive splits,
 * per-player offensive role, and per-team red-zone work — all from the current
 * season, so /api/matchup-intel can stop reporting them UNAVAILABLE.
 *
 * SOURCES, the same nflverse releases the picks engine already streams for
 * nfl_team_ratings (workers/nfl-picks-engine-shared/ratings.mjs):
 *
 *   pbp/play_by_play_2026.csv.gz        splits, usage, red zone
 *   snap_counts/snap_counts_2026.csv.gz snap share
 *   depth_charts/depth_charts_2026.csv.gz depth rank
 *   weekly_rosters/roster_weekly_2026.csv.gz the id crosswalk
 *
 * IDENTITY. Never by name. play-by-play and depth charts speak GSIS; snap
 * counts speak only PFR; the product speaks ESPN. roster_weekly carries all
 * three on one row and is the hub every join goes through. A player who cannot
 * be resolved on a strong id is counted in the team totals (the play happened)
 * and omitted from the per-player rows — he is not guessed at.
 *
 * NOTHING IS DERIVED FROM THE AGGREGATE RATING. A split is computed from the
 * plays that belong to it or it is absent. An aggregate EPA/play is not a pass
 * EPA/play, and turning one into the other would be inventing the number the
 * page exists to show.
 *
 * NOT COMPUTED, because the source does not carry it: routes run, pressure
 * rate, blitz rate, coverage shell. 2026 charting data is not licensed.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT = join(REPO, 'data', 'dist', 'matchup-2026.json');
const SEASON = Number((process.argv.find(a => a.startsWith('--season=')) || '--season=2026').split('=')[1]);
const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

/* The roadmap's definition, kept in one place and published in the payload. */
export const EXPLOSIVE_YARDS = 20;
export const LIMITED_SAMPLE_PLAYS = 50;

/* ------------------------------------------------------------------ csv */

function splitCsvLine(line) {
  const out = [];
  let field = '', quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
      continue;
    }
    if (c === ',' && !quoted) { out.push(field); field = ''; continue; }
    field += c;
  }
  out.push(field);
  return out;
}

/** Stream a gzipped nflverse CSV, yielding one object per row. */
async function* rows(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '', header = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      if (!header) { header = splitCsvLine(line); continue; }
      const cells = splitCsvLine(line);
      const row = {};
      for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i];
      yield row;
    }
  }
  if (buffer.trim() && header) {
    const cells = splitCsvLine(buffer.trim());
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i];
    yield row;
  }
}

const num = v => {
  if (v === undefined || v === null || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = v => (v === undefined || v === null || v === '' || v === 'NA' ? null : String(v));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (v, d = 4) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/* --------------------------------------------------------------- collect */

function emptySplit() { return { epa: [], plays: 0, explosive: 0 }; }
function emptyTeam() {
  return {
    off: { pass: emptySplit(), rush: emptySplit(), all: emptySplit() },
    def: { pass: emptySplit(), rush: emptySplit(), all: emptySplit() },
    red_zone: { trips: new Set(), touchdowns: 0, plays: 0, carries: 0, targets: 0, goal_to_go_plays: 0 },
    weeks: new Set(),
  };
}

function addPlay(bucket, epa, yards) {
  bucket.plays += 1;
  if (epa !== null) bucket.epa.push(epa);
  if (yards !== null && yards >= EXPLOSIVE_YARDS) bucket.explosive += 1;
}

function finishSplit(bucket) {
  return {
    epa_per_play: round(mean(bucket.epa)),
    plays: bucket.plays,
    explosive_plays: bucket.explosive,
    explosive_rate: bucket.plays ? round(bucket.explosive / bucket.plays) : null,
    limited: bucket.plays < LIMITED_SAMPLE_PLAYS,
  };
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log(`season ${SEASON}`);

  /* 1. The crosswalk. roster_weekly is the only file carrying gsis, pfr and
        espn on one row, so every later join goes through it. */
  const byGsis = new Map(), byPfr = new Map();
  let rosterRows = 0;
  for await (const r of rows(`${BASE}/weekly_rosters/roster_weekly_${SEASON}.csv.gz`)) {
    if (num(r.season) !== SEASON) continue;
    rosterRows += 1;
    const gsis = str(r.gsis_id);
    if (!gsis) continue;
    const entry = {
      gsis_id: gsis, pfr_id: str(r.pfr_id), espn_id: str(r.espn_id),
      name: str(r.full_name) || str(r.football_name),
      position: str(r.position), team: str(r.team),
      week: num(r.week) ?? 0,
    };
    const prior = byGsis.get(gsis);
    if (!prior || entry.week >= prior.week) byGsis.set(gsis, entry);
    if (entry.pfr_id) {
      const p = byPfr.get(entry.pfr_id);
      if (!p || entry.week >= p.week) byPfr.set(entry.pfr_id, entry);
    }
  }
  console.log(`  roster_weekly   ${rosterRows} rows, ${byGsis.size} players (${byPfr.size} with a PFR id)`);

  /* 2. Play by play: team splits, red zone, and per-player targets/carries. */
  const teams = new Map();
  const team = t => { if (!teams.has(t)) teams.set(t, emptyTeam()); return teams.get(t); };
  const usage = new Map();          // gsis -> { targets, carries, rz_targets, rz_carries, byWeek }
  const player = id => {
    if (!usage.has(id)) usage.set(id, { targets: 0, carries: 0, rz_targets: 0, rz_carries: 0, byWeek: new Map() });
    return usage.get(id);
  };
  const weekly = (rec, week) => {
    if (!rec.byWeek.has(week)) rec.byWeek.set(week, { targets: 0, carries: 0 });
    return rec.byWeek.get(week);
  };
  const teamWeekTotals = new Map();  // `${team}|${week}` -> { targets, carries }
  const tw = (t, w) => {
    const k = `${t}|${w}`;
    if (!teamWeekTotals.has(k)) teamWeekTotals.set(k, { targets: 0, carries: 0 });
    return teamWeekTotals.get(k);
  };

  let playRows = 0, offensive = 0;
  for await (const r of rows(`${BASE}/pbp/play_by_play_${SEASON}.csv.gz`)) {
    playRows += 1;
    if (str(r.season_type) !== 'REG') continue;
    const off = str(r.posteam), def = str(r.defteam);
    if (!off || !def) continue;
    const isPass = num(r.pass) === 1, isRush = num(r.rush) === 1;
    if (!isPass && !isRush) continue;          // no-play, kneel, spike, special teams
    offensive += 1;

    const epa = num(r.epa);
    const yards = num(r.yards_gained);
    const week = num(r.week);
    const O = team(off), D = team(def);
    if (week !== null) { O.weeks.add(week); D.weeks.add(week); }

    addPlay(O.off.all, epa, yards);
    addPlay(D.def.all, epa, yards);
    addPlay(isPass ? O.off.pass : O.off.rush, epa, yards);
    addPlay(isPass ? D.def.pass : D.def.rush, epa, yards);

    /* Red zone: the documented field, not a guess about field position. */
    const y100 = num(r.yardline_100);
    const inRedZone = y100 !== null && y100 <= 20;
    if (inRedZone) {
      O.red_zone.plays += 1;
      const drive = str(r.fixed_drive) || str(r.drive);
      if (drive) O.red_zone.trips.add(`${str(r.game_id)}|${drive}`);
      if (num(r.touchdown) === 1) O.red_zone.touchdowns += 1;
      if (num(r.goal_to_go) === 1) O.red_zone.goal_to_go_plays += 1;
    }

    const rusher = str(r.rusher_player_id);
    const receiver = str(r.receiver_player_id);
    if (isRush && rusher) {
      player(rusher).carries += 1;
      if (week !== null) { weekly(player(rusher), week).carries += 1; tw(off, week).carries += 1; }
      if (inRedZone) { player(rusher).rz_carries += 1; O.red_zone.carries += 1; }
    }
    if (isPass && receiver) {
      player(receiver).targets += 1;
      if (week !== null) { weekly(player(receiver), week).targets += 1; tw(off, week).targets += 1; }
      if (inRedZone) { player(receiver).rz_targets += 1; O.red_zone.targets += 1; }
    }
  }
  console.log(`  play_by_play    ${playRows} rows, ${offensive} offensive plays, ${teams.size} teams`);

  /* 3. Snap counts. This file carries no gsis id — only pfr_player_id — so the
        crosswalk is the only way in, and a row that does not resolve is left
        out rather than matched on the name beside it. */
  const snaps = new Map();          // gsis -> { offense_snaps, team_snaps_max, pct[] }
  let snapRows = 0, snapUnresolved = 0;
  for await (const r of rows(`${BASE}/snap_counts/snap_counts_${SEASON}.csv.gz`)) {
    if (num(r.season) !== SEASON || str(r.game_type) !== 'REG') continue;
    snapRows += 1;
    const pfr = str(r.pfr_player_id);
    const resolved = pfr ? byPfr.get(pfr) : null;
    if (!resolved) { snapUnresolved += 1; continue; }
    const gsis = resolved.gsis_id;
    if (!snaps.has(gsis)) snaps.set(gsis, { offense_snaps: 0, pct: [], weeks: new Map() });
    const rec = snaps.get(gsis);
    const off = num(r.offense_snaps) ?? 0;
    const pct = num(r.offense_pct);
    rec.offense_snaps += off;
    if (pct !== null) rec.pct.push(pct);
    const w = num(r.week);
    if (w !== null) rec.weeks.set(w, { snaps: off, pct });
  }
  console.log(`  snap_counts     ${snapRows} rows, ${snaps.size} resolved, ${snapUnresolved} unresolved on a strong id`);

  /* 4. Depth charts.
        The 2026 file is NOT the 2024 file. It carries no season or week at all:
        it is a point-in-time snapshot stamped `dt`, with pos_rank instead of
        depth_team and pos_abb instead of depth_position — and it publishes both
        gsis_id and espn_id directly. Filtering it on `season` silently matched
        zero rows and produced an empty depth layer, which is the failure mode
        this comment exists to stop repeating. */
  const depth = new Map();
  let depthRows = 0, depthStamp = null;
  for await (const r of rows(`${BASE}/depth_charts/depth_charts_${SEASON}.csv.gz`)) {
    depthRows += 1;
    const stamp = str(r.dt);
    if (stamp && (!depthStamp || stamp > depthStamp)) depthStamp = stamp;
    const gsis = str(r.gsis_id);
    if (!gsis) continue;
    const rank = num(r.pos_rank);
    const prior = depth.get(gsis);
    /* One player holds several rows (a slot per package). The lowest rank is
       the one that describes his standing. */
    if (!prior || (rank !== null && (prior.rank === null || rank < prior.rank))) {
      depth.set(gsis, {
        rank,
        position: str(r.pos_abb) || str(r.pos_name),
        group: str(r.pos_grp),
        team: str(r.team),
        espn_id: str(r.espn_id),
        as_of: stamp,
      });
    }
  }
  console.log(`  depth_charts    ${depthRows} rows, ${depth.size} players, as of ${depthStamp || 'unknown'}`);

  /* ------------------------------------------------------------- compose */

  const teamOut = {};
  for (const [abbr, t] of teams) {
    const weeks = [...t.weeks].sort((a, b) => a - b);
    const rzTrips = t.red_zone.trips.size;
    teamOut[abbr] = {
      team: abbr,
      weeks,
      games: weeks.length,
      offence: {
        pass: finishSplit(t.off.pass), rush: finishSplit(t.off.rush), all: finishSplit(t.off.all),
      },
      defence: {
        pass: finishSplit(t.def.pass), rush: finishSplit(t.def.rush), all: finishSplit(t.def.all),
      },
      red_zone: {
        trips: rzTrips,
        plays: t.red_zone.plays,
        touchdowns: t.red_zone.touchdowns,
        /* Trips that ended in a touchdown, over trips. A trip with no
           touchdown may have ended in a field goal or a turnover; this does not
           claim to know which. */
        touchdown_rate: rzTrips ? round(t.red_zone.touchdowns / rzTrips) : null,
        carries_inside_20: t.red_zone.carries,
        targets_inside_20: t.red_zone.targets,
        goal_to_go_plays: t.red_zone.goal_to_go_plays,
        limited: rzTrips < 6,
      },
    };
  }

  /* Team totals for the share denominators. */
  const teamTotals = new Map();
  for (const [key, v] of teamWeekTotals) {
    const [abbr] = key.split('|');
    if (!teamTotals.has(abbr)) teamTotals.set(abbr, { targets: 0, carries: 0 });
    const t = teamTotals.get(abbr);
    t.targets += v.targets; t.carries += v.carries;
  }

  const playerOut = {};
  let roleRows = 0, roleUnresolved = 0;
  for (const [gsis, u] of usage) {
    const who = byGsis.get(gsis);
    if (!who) { roleUnresolved += 1; continue; }        // never matched by name
    const abbr = who.team;
    const totals = teamTotals.get(abbr) || { targets: 0, carries: 0 };
    const snap = snaps.get(gsis) || null;
    const d = depth.get(gsis) || null;

    /* Week-over-week only when two real weeks exist for this player. One
       observation is not a trend, and a 2025 role is not a 2026 week. */
    const weeksSeen = [...u.byWeek.keys()].sort((a, b) => a - b);
    let delta = null;
    if (weeksSeen.length >= 2) {
      const last = u.byWeek.get(weeksSeen[weeksSeen.length - 1]);
      const prev = u.byWeek.get(weeksSeen[weeksSeen.length - 2]);
      const lastTeam = teamWeekTotals.get(`${abbr}|${weeksSeen[weeksSeen.length - 1]}`) || { targets: 0, carries: 0 };
      const prevTeam = teamWeekTotals.get(`${abbr}|${weeksSeen[weeksSeen.length - 2]}`) || { targets: 0, carries: 0 };
      const share = (n, d2) => (d2 ? n / d2 : null);
      const ls = share(last.targets, lastTeam.targets), ps = share(prev.targets, prevTeam.targets);
      const lc = share(last.carries, lastTeam.carries), pc = share(prev.carries, prevTeam.carries);
      const snapLast = snap?.weeks?.get(weeksSeen[weeksSeen.length - 1])?.pct ?? null;
      const snapPrev = snap?.weeks?.get(weeksSeen[weeksSeen.length - 2])?.pct ?? null;
      delta = {
        from_week: weeksSeen[weeksSeen.length - 2],
        to_week: weeksSeen[weeksSeen.length - 1],
        target_share: ls !== null && ps !== null ? round(ls - ps) : null,
        carry_share: lc !== null && pc !== null ? round(lc - pc) : null,
        snap_share: snapLast !== null && snapPrev !== null ? round(snapLast - snapPrev) : null,
      };
    }

    roleRows += 1;
    playerOut[gsis] = {
      gsis_id: gsis,
      espn_id: who.espn_id,
      name: who.name,
      position: who.position,
      team: abbr,
      snap_share: snap && snap.pct.length ? round(mean(snap.pct)) : null,
      offense_snaps: snap ? snap.offense_snaps : null,
      targets: u.targets,
      target_share: totals.targets ? round(u.targets / totals.targets) : null,
      carries: u.carries,
      carry_share: totals.carries ? round(u.carries / totals.carries) : null,
      red_zone: { targets: u.rz_targets, carries: u.rz_carries },
      depth_rank: d?.rank ?? null,
      depth_position: d?.position ?? null,
      depth_group: d?.group ?? null,
      depth_as_of: d?.as_of ?? null,
      /* Stated, so a consumer never reads a missing comparison as "no change". */
      week_over_week: delta,
      week_over_week_state: delta ? 'OK' : 'ONE_WEEK_ONLY',
    };
  }
  console.log(`  role rows       ${roleRows} (${roleUnresolved} dropped: no strong id)`);

  const payload = {
    meta: {
      contract: 'matchup-2026/v1',
      season: SEASON,
      generated_at: new Date().toISOString(),
      sources: {
        play_by_play: `${BASE}/pbp/play_by_play_${SEASON}.csv.gz`,
        snap_counts: `${BASE}/snap_counts/snap_counts_${SEASON}.csv.gz`,
        depth_charts: `${BASE}/depth_charts/depth_charts_${SEASON}.csv.gz`,
        roster_weekly: `${BASE}/weekly_rosters/roster_weekly_${SEASON}.csv.gz`,
      },
      definitions: {
        explosive_play: `yards_gained >= ${EXPLOSIVE_YARDS}`,
        limited_sample_plays: LIMITED_SAMPLE_PLAYS,
        red_zone: 'yardline_100 <= 20',
        red_zone_trip: 'one drive reaching the red zone, counted once',
        pass_rush: 'the nflverse pass / rush flags; no-plays, kneels and spikes excluded',
        epa_per_play: 'unadjusted mean EPA over the plays in the split',
      },
      identity: 'gsis is the spine; snap counts resolve through roster_weekly pfr_id; '
        + 'a player who resolves on no strong id is counted in team totals and omitted from role rows. '
        + 'Names are never joined.',
      not_included: ['routes run', 'pressure rate', 'blitz rate', 'coverage shell'],
      weeks: [...new Set(Object.values(teamOut).flatMap(t => t.weeks))].sort((a, b) => a - b),
      counts: {
        teams: Object.keys(teamOut).length,
        players_with_role: roleRows,
        players_dropped_no_strong_id: roleUnresolved,
        snap_rows_unresolved: snapUnresolved,
        players_with_depth_rank: depth.size,
      },
    },
    teams: teamOut,
    players: playerOut,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload) + '\n');
  console.log(`\nwrote ${OUT}`);
  console.log(`  teams ${payload.meta.counts.teams}  players ${roleRows}  weeks ${payload.meta.weeks.join(',')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
