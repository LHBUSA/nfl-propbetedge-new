/* Reconcile Opportunity Radar counts against an INDEPENDENT source: the ESPN
 * box scores nfl-current already publishes per player (/api/current-player).
 *
 *   node scripts/opportunity-reconcile.mjs [.gate/opportunity/rollup.json] [--per-position 4] [--pbp <play_by_play_YYYY.csv.gz>]
 *
 * Sample: the top N players by opportunity at each of QB/RB/WR/TE (position
 * from the Player DNA datasets, by ESPN id), spread across teams.
 *
 * Expected identities, per game:
 *   targets        radar t        == ESPN receiving.targets
 *   carries        radar c + sc (scrambles) + kneels == ESPN rushing.carries
 *                  (ESPN counts scrambles and kneels as rushes; the radar's
 *                  designed-run carry excludes both by definition, and
 *                  two-point tries are in neither; ESPN also records an
 *                  aborted snap as a rush, the radar excludes it)
 * Scrambles and kneels are counted per player-game from the raw season file
 * (--pbp), so a QB row is EXPLAINED only when designed runs + scrambles +
 * kneels + aborted snaps equal ESPN's rushes exactly. Without --pbp a QB difference is
 * reported as UNVERIFIED, never passed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseCsv } from '../workers/nfl-replay/src/nflverse.js';

const args = process.argv.slice(2);
const rollupPath = args.find(a => a.endsWith('.json')) || '.gate/opportunity/rollup.json';
const perPos = Number(args[args.indexOf('--per-position') + 1]) || 4;
const API = process.env.NFL_API || 'https://nfl-api.propbetedge.ai';
const rollup = JSON.parse(readFileSync(rollupPath, 'utf8'));
const pbpPath = args.includes('--pbp') ? args[args.indexOf('--pbp') + 1] : null;
/* gsis|week -> { scrambles, kneels } from the raw file, via a separate code path. */
const qbExtra = {};
if (pbpPath) {
  const rows = parseCsv(gunzipSync(readFileSync(pbpPath)).toString('utf8'));
  const h = rows[0], at = n => h.indexOf(n);
  for (const r of rows.slice(1)) {
    const id = r[at('rusher_player_id')];
    if (!id || id === 'NA' || r[at('play_type')] === 'no_play' || r[at('two_point_attempt')] === '1') continue;
    const k = `${id}|${r[at('week')]}`;
    const x = (qbExtra[k] ||= { scrambles: 0, kneels: 0, aborted: 0 });
    if (r[at('qb_scramble')] === '1') x.scrambles++;
    if (r[at('qb_kneel')] === '1') x.kneels++;
    if (r[at('aborted_play')] === '1') x.aborted++;
  }
}

const pos = {};
for (const [p, f] of [['QB', 'qb'], ['RB', 'rb'], ['WR', 'wr'], ['TE', 'te']]) {
  const d = JSON.parse(readFileSync(`data/dist/${f}-dna-dataset.json`, 'utf8'));
  for (const row of d.players || []) if (row.espn_id) pos[String(row.espn_id)] = p;
}
const byPos = { QB: [], RB: [], WR: [], TE: [] };
for (const p of rollup.players) {
  const P = pos[p.espn_id];
  if (!P || byPos[P].length >= perPos * 3) continue;
  byPos[P].push(p);
}
const sample = [];
for (const [P, list] of Object.entries(byPos)) {
  const teams = new Set();
  for (const p of list) { if (teams.has(p.team)) continue; teams.add(p.team); sample.push({ ...p, pos: P }); if (teams.size >= perPos) break; }
}

const rows = [];
let exact = 0, explained = 0, mismatch = 0;
for (const p of sample) {
  const r = await fetch(`${API}/api/current-player?espn_id=${p.espn_id}&team=${p.team}`, { headers: { 'user-agent': 'Mozilla/5.0 pbe-opportunity-reconcile' } });
  const body = r.ok ? await r.json() : null;
  const games = body?.recent_games || [];
  for (const s of p.series) {
    const g = games.find(x => Number(x.week) === Number(s.w) && x.team === p.team);
    if (!g) { rows.push({ player: p.pbp_name, espn: p.espn_id, pos: p.pos, team: p.team, week: s.w, verdict: 'NO_ESPN_GAME' }); mismatch++; continue; }
    const espnT = g.receiving?.targets ?? 0;
    const espnC = g.rushing?.carries ?? 0;
    const tOk = espnT === s.t;
    const extra = qbExtra[`${p.gsis_id}|${s.w}`] || null;
    const cDiff = espnC - s.c;
    let verdict;
    if (tOk && cDiff === 0) { verdict = 'EXACT'; exact++; }
    else if (tOk && extra && cDiff === extra.scrambles + extra.kneels + extra.aborted) { verdict = 'EXPLAINED'; explained++; }
    else if (tOk && !pbpPath) { verdict = 'UNVERIFIED_NO_PBP'; mismatch++; }
    else { verdict = 'MISMATCH'; mismatch++; }
    rows.push({ player: p.pbp_name, espn: p.espn_id, pos: p.pos, team: p.team, week: s.w, radar_targets: s.t, espn_targets: espnT, radar_carries: s.c, espn_carries: espnC, scrambles: extra?.scrambles ?? null, kneels: extra?.kneels ?? null, aborted: extra?.aborted ?? null, team_targets: s.tt, team_designed_runs: s.tc, verdict });
  }
}
mkdirSync('.gate/opportunity', { recursive: true });
const report = { generated_at: new Date().toISOString(), rollup_revision: rollup.source?.revision, data_through: rollup.data_through, sample: sample.map(p => `${p.pbp_name} ${p.pos} ${p.team}`), totals: { games: rows.length, exact, explained, mismatch }, rows };
writeFileSync('.gate/opportunity/reconcile.json', JSON.stringify(report, null, 1));
console.table(rows.map(r => ({ player: r.player, pos: r.pos, team: r.team, wk: r.week, t: `${r.radar_targets}/${r.espn_targets}`, c: `${r.radar_carries}/${r.espn_carries}`, 'scr+kn': r.scrambles === null ? '' : `${r.scrambles}+${r.kneels}+${r.aborted}`, verdict: r.verdict })));
console.log(report.totals);
process.exit(mismatch ? 1 : 0);
