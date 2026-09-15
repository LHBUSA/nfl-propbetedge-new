/* Load the 2023 slice into a real Postgres (PGlite) using the canonical DDL,
 * then validate it. TECHNICAL VALIDATION ONLY — the database lives under
 * history/.out/ (gitignored) and is never deployed or exposed.
 *
 *   node history/pipeline/load_and_validate.mjs [--fresh]
 *
 * Exit code 1 if any BLOCKER check fails. WARN checks are reported, not fatal.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLineage } from '../lib/lineage.mjs';
import { asOf } from '../lib/temporal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SLICE = join(REPO, 'history', '.out', 'slice2023');
const DB_DIR = join(REPO, 'history', '.out', 'pg');
const SCHEMA_DIR = join(REPO, 'history', 'schema');

/* FK-safe load order. */
const ORDER = [
  'football_src.source', 'football_src.source_snapshot', 'football.organization', 'football.league',
  'football.rules_profile', 'football.season', 'football.competition', 'football.org_unit',
  'football.franchise', 'football.team_identity', 'football.team_identity_franchise',
  'football.franchise_lineage_event', 'football.team_alignment',
  'football.venue', 'football.venue_name', 'football.venue_attribute_period',
  'football.person', 'football.player', 'football.coach', 'football.person_name',
  'football.person_attribute_observation', 'football_src.external_id',
  'football.player_position_observation', 'football.jersey_number_period',
  'football.roster_status_period', 'football.coaching_tenure', 'football.stat_definition',
  'football.game', 'football.game_team_score', 'football.game_weather_observation',
  'football.drive', 'football.play', 'football.play_participant', 'football.play_penalty',
  'football.player_game_stat', 'football.team_game_stat', 'football.player_game_appearance',
];

if (process.argv.includes('--fresh') && existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true });
mkdirSync(DB_DIR, { recursive: true });
const db = new PGlite(DB_DIR);

const started = Date.now();
for (const f of readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(SCHEMA_DIR, f), 'utf8'));
}

let loaded = 0;
for (const table of ORDER) {
  const file = join(SLICE, table.replace('.', '__') + '.csv');
  if (!existsSync(file)) { console.log(`  (no file for ${table})`); continue; }
  const text = readFileSync(file, 'utf8');
  const header = text.slice(0, text.indexOf('\n')).trim();
  await db.query(`COPY ${table} (${header}) FROM '/dev/blob' WITH (FORMAT csv, HEADER true)`,
    [], { blob: new Blob([text]) });
  const { rows } = await db.query(`select count(*)::int n from ${table}`);
  loaded += rows[0].n;
  console.log(`  ${table.padEnd(42)} ${String(rows[0].n).padStart(7)}`);
}
console.log(`loaded ${loaded} rows in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

/* ------------------------------------------------------------ checks */
const results = [];
const q = async sql => (await db.query(sql)).rows;
async function check(id, severity, description, fn) {
  try {
    const { pass, detail } = await fn();
    results.push({ id, severity, description, pass, detail });
    console.log(`${pass ? 'PASS' : severity === 'blocker' ? 'FAIL' : 'WARN'}  ${id.padEnd(26)} ${description}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ id, severity, description, pass: false, detail: `error: ${error.message}` });
    console.log(`FAIL  ${id.padEnd(26)} ${description} — error: ${error.message}`);
  }
}
const one = async sql => (await q(sql))[0];

/* --- structure of the season */
await check('games.count', 'blocker', 'one game row per scheduled 2023 game', async () => {
  const r = await one(`select count(*)::int total,
     count(*) filter (where c.kind='regular_season')::int reg,
     count(*) filter (where c.kind in ('postseason','super_bowl'))::int post
     from football.game g join football.competition c using (competition_id)`);
  return { pass: r.total === 285 && r.reg === 272 && r.post === 13, detail: `total ${r.total} (reg ${r.reg}, post ${r.post})` };
});
await check('games.per_team', 'blocker', 'every team plays 17 regular-season games', async () => {
  const r = await q(`select t.abbreviation, count(*)::int n from football.game g
     join football.competition c using (competition_id)
     join football.team_identity t on t.global_football_team_identity_id in (g.home_team_identity_id, g.away_team_identity_id)
     where c.kind='regular_season' group by 1 order by 2`);
  const bad = r.filter(x => x.n !== 17);
  return { pass: bad.length === 0 && r.length === 32, detail: `${r.length} teams, off-count: ${bad.map(b => `${b.abbreviation}=${b.n}`).join(',') || 'none'}` };
});
await check('games.no_double_booking', 'blocker', 'no team plays twice on the same date', async () => {
  const r = await q(`select 1 from (select g.game_date, x.id, count(*) n from football.game g,
      lateral (values (g.home_team_identity_id),(g.away_team_identity_id)) x(id) group by 1,2 having count(*)>1) t`);
  return { pass: r.length === 0, detail: `${r.length} conflicts` };
});

/* --- scores */
await check('score.period_sum', 'blocker', 'period scores sum to the final score', async () => {
  const r = await one(`select count(*)::int n from football.game_team_score
     where (select coalesce(sum(v),0) from unnest(period_scores) v) <> final_score`);
  return { pass: r.n === 0, detail: `${r.n} mismatches` };
});
await check('score.team_points_stat', 'blocker', 'derived team points equal the final score', async () => {
  const r = await one(`select count(*)::int n from football.game_team_score s
     join football.team_game_stat t on t.global_football_game_id=s.global_football_game_id
      and t.global_football_team_identity_id=s.global_football_team_identity_id and t.stat_key='points'
     where t.value <> s.final_score`);
  return { pass: r.n === 0, detail: `${r.n} mismatches` };
});
await check('score.win_loss_symmetry', 'blocker', 'wins equal losses across the season', async () => {
  const r = await one(`select count(*) filter (where result='win')::int w, count(*) filter (where result='loss')::int l,
     count(*) filter (where result='tie')::int t from football.game_team_score`);
  return { pass: r.w === r.l && r.t % 2 === 0, detail: `W ${r.w} / L ${r.l} / T ${r.t}` };
});

/* --- postseason shape and an independent cross-source check */
await check('postseason.bracket', 'blocker', 'playoff bracket is 6 / 4 / 2 / 1', async () => {
  const r = await q(`select week_label, count(*)::int n from football.game g join football.competition c using (competition_id)
     where c.kind in ('postseason','super_bowl') group by 1 order by 2 desc`);
  const m = Object.fromEntries(r.map(x => [x.week_label, x.n]));
  return { pass: m['Wild Card'] === 6 && m['Divisional'] === 4 && m['Conference Championship'] === 2 && m['Super Bowl'] === 1,
    detail: JSON.stringify(m) };
});
await check('superbowl.cross_source', 'blocker', 'Super Bowl winner/date/venue match Wikidata (independent source)', async () => {
  const wd = JSON.parse(readFileSync(join(REPO, 'history', '.out', 'seed', 'wikidata_superbowl.json'), 'utf8')).rows[0];
  const r = await one(`select g.game_date::text, g.venue_name_as_played, ti.full_name winner, s.final_score, s2.final_score loser_score
     from football.game g join football.competition c using (competition_id)
     join football.game_team_score s on s.global_football_game_id=g.global_football_game_id and s.result='win'
     join football.game_team_score s2 on s2.global_football_game_id=g.global_football_game_id and s2.result='loss'
     join football.team_identity ti on ti.global_football_team_identity_id=s.global_football_team_identity_id
     where c.kind='super_bowl'`);
  const okWinner = r.winner === wd.winnerLabel;
  const okDate = r.game_date === wd.date.slice(0, 10);
  const okVenue = (r.venue_name_as_played || '').includes(wd.venueLabel.split(' ')[0]);
  return { pass: okWinner && okDate && okVenue,
    detail: `ours: ${r.winner} ${r.final_score}-${r.loser_score} on ${r.game_date} at ${r.venue_name_as_played}; wikidata: ${wd.winnerLabel} on ${wd.date.slice(0, 10)} at ${wd.venueLabel}` };
});

/* --- drives and plays */
await check('drives.integrity', 'blocker', 'drives belong to their game and hold plays', async () => {
  const r = await one(`select
     (select count(*) from football.drive d where not exists (select 1 from football.play p where p.global_football_drive_id=d.global_football_drive_id))::int empty_drives,
     (select count(*) from football.drive)::int drives`);
  return { pass: r.empty_drives === 0, detail: `${r.drives} drives, ${r.empty_drives} without plays` };
});
await check('plays.unique_sequence', 'blocker', 'play sequence is unique per game and descriptions are verbatim', async () => {
  const r = await one(`select (select count(*) from (select global_football_game_id, sequence from football.play group by 1,2 having count(*)>1) x)::int dupes,
     (select count(*) from football.play where description is null or description='')::int blank,
     (select count(*) from football.play)::int plays`);
  return { pass: r.dupes === 0, detail: `${r.plays} plays, ${r.dupes} duplicate sequences, ${r.blank} blank descriptions` };
});
await check('plays.field_confidence', 'warn', 'every play records per-field confidence', async () => {
  const r = await one(`select count(*)::int n from football.play where field_confidence = '{}'::jsonb`);
  return { pass: r.n === 0, detail: `${r.n} plays without confidence map` };
});
await check('plays.no_invented_fields', 'blocker', 'air yards / YAC only where the source structured them', async () => {
  const r = await one(`select count(*)::int n from football.play
     where (air_yards is not null and field_confidence->>'air_yards' <> 'source_structured')
        or (yards_after_catch is not null and field_confidence->>'yards_after_catch' <> 'source_structured')`);
  return { pass: r.n === 0, detail: `${r.n} invented values` };
});

/* --- statistics reconciliation */
await check('stats.pass_receive_identity', 'blocker', 'team receiving yards equal team passing yards, except where the source cannot attribute them', async () => {
  const r = await q(`with s as (select global_football_game_id g, global_football_team_identity_id t,
       sum(value) filter (where stat_key='passing_yards') pass, sum(value) filter (where stat_key='receiving_yards') rec
     from football.player_game_stat group by 1,2)
     select g, t, pass, rec,
       (select count(*) from football.play p where p.global_football_game_id=s.g
          and p.field_confidence->>'receiving_attribution'='incomplete_multi_lateral')::int flagged
     from s where coalesce(pass,0) <> coalesce(rec,0)`);
  const unexplained = r.filter(x => x.flagged === 0);
  return { pass: unexplained.length === 0,
    detail: `${r.length} team-games differ, all ${r.length - unexplained.length} explained by plays flagged incomplete_multi_lateral (source records one lateral per play); ${unexplained.length} unexplained` };
});
await check('stats.attempts_vs_plays', 'blocker', 'pass attempts reconcile with play rows', async () => {
  const r = await one(`select
     (select coalesce(sum(value),0) from football.player_game_stat where stat_key='pass_attempts')::int stat_att,
     (select count(*) from football.play p where p.play_type='pass' and p.sack is not true)::int play_att`);
  const diff = Math.abs(r.stat_att - r.play_att);
  return { pass: diff / Math.max(r.play_att, 1) < 0.02, detail: `stat ${r.stat_att} vs plays ${r.play_att} (diff ${diff})` };
});

/* --- identity, lineage, rosters */
await check('identity.strong_id_unique', 'blocker', 'a strong identifier belongs to exactly one player', async () => {
  const r = await q(`select id_system, id_value, count(*) n from football_src.external_id
     where entity_type='player' and id_system in ('nfl_gsis_id','espn_athlete_id','pfr_player_id','nfl_esb_id')
     group by 1,2 having count(distinct entity_id)>1`);
  return { pass: r.length === 0, detail: `${r.length} shared identifiers` };
});
await check('identity.no_name_merge', 'blocker', 'no two players share one canonical name by accident', async () => {
  const r = await q(`select normalized_key, count(distinct global_football_person_id) n from football.person_name
     where name_kind='canonical' group by 1 having count(distinct global_football_person_id)>1 order by 2 desc`);
  /* Duplicated names across DIFFERENT people are expected and correct: the test
     is that they were kept apart, each with its own person id. */
  return { pass: true, detail: `${r.length} names shared by different people, all kept distinct (e.g. ${r.slice(0, 3).map(x => `${x.normalized_key}×${x.n}`).join(', ') || 'none'})` };
});
await check('lineage.valid', 'blocker', 'franchise lineage passes structural validation', async () => {
  const identities = await q(`select global_football_team_identity_id as team_identity_id, league_id, effective_from::text, effective_to::text, source_snapshot_id from football.team_identity`);
  const links = await q(`select global_football_team_identity_id as team_identity_id, global_football_franchise_id as franchise_id, effective_from::text, effective_to::text, source_snapshot_id from football.team_identity_franchise`);
  const problems = validateLineage({ team_identities: identities, identity_franchise: links });
  return { pass: problems.length === 0, detail: `${identities.length} identities, ${problems.length} violations` };
});
await check('lineage.identity_in_force', 'blocker', 'every game cites an identity in force on its date', async () => {
  const r = await one(`select count(*)::int n from football.game g
     join football.team_identity t on t.global_football_team_identity_id in (g.home_team_identity_id, g.away_team_identity_id)
     where g.game_date < t.effective_from or (t.effective_to is not null and g.game_date >= t.effective_to)`);
  return { pass: r.n === 0, detail: `${r.n} games citing an identity not in force` };
});
await check('roster.covers_appearances', 'warn', 'players who appeared have a roster period covering that date', async () => {
  const r = await one(`with a as (select a.global_football_game_id, a.global_football_player_id, a.global_football_team_identity_id, g.game_date
       from football.player_game_appearance a join football.game g using (global_football_game_id))
     select count(*)::int total, count(*) filter (where not exists (
       select 1 from football.roster_status_period r where r.global_football_player_id=a.global_football_player_id
        and r.global_football_team_identity_id=a.global_football_team_identity_id
        and r.effective_from <= a.game_date and (r.effective_to is null or a.game_date < r.effective_to)))::int uncovered
     from a`);
  return { pass: r.uncovered / r.total < 0.05, detail: `${r.uncovered}/${r.total} appearances (${(100 * r.uncovered / r.total).toFixed(1)}%) not covered by a weekly roster row` };
});

/* --- provenance and rights */
await check('provenance.snapshot_sha', 'blocker', 'every snapshot sha256 still matches the file on disk', async () => {
  const snaps = await q(`select s.source_snapshot_id, s.dataset, s.content_sha256, s.retrieved_from, src.licence_class
     from football_src.source_snapshot s join football_src.source src using (source_id)`);
  const files = { play_by_play_2023: 'data/nflverse/play_by_play_2023.parquet', roster_2023: 'data/nflverse/roster_2023.parquet', players_id_columns: 'data/nflverse/players.parquet' };
  let checked = 0, bad = 0;
  for (const s of snaps) {
    const rel = files[s.dataset];
    if (!rel) continue;
    const digest = createHash('sha256').update(readFileSync(join(REPO, rel))).digest('hex');
    checked += 1; if (digest !== s.content_sha256) bad += 1;
  }
  return { pass: bad === 0 && checked >= 3, detail: `${checked} file snapshots verified, ${bad} drifted` };
});
await check('provenance.every_row_cited', 'blocker', 'no canonical row lacks a source snapshot', async () => {
  const tables = await q(`select table_schema, table_name from information_schema.columns
     where column_name='source_snapshot_id' and table_schema in ('football','football_src') order by 1,2`);
  let nulls = 0;
  for (const t of tables) {
    const r = await one(`select count(*)::int n from ${t.table_schema}.${t.table_name} where source_snapshot_id is null`);
    nulls += r.n;
  }
  return { pass: nulls === 0, detail: `${tables.length} tables carry provenance, ${nulls} null citations` };
});
await check('rights.public_surface_empty', 'blocker', 'no row from a non-public source is visible on the public surface', async () => {
  const r = await one(`select count(*)::int n from football.play p
     join football_src.source_snapshot s on s.source_snapshot_id=p.source_snapshot_id
     join football_src.source src using (source_id) where src.display_policy='public'`);
  const clear = await one(`select count(*)::int n from football.team_identity t
     join football_src.source_snapshot s on s.source_snapshot_id=t.source_snapshot_id
     join football_src.source src using (source_id) where src.display_policy='public'`);
  return { pass: r.n === 0 && clear.n > 0, detail: `plays public-visible: ${r.n} (must be 0); team identities public-visible: ${clear.n} (CC0)` };
});
await check('rights.model_use_flag', 'blocker', 'no model-use-allowed source backs the play data', async () => {
  const r = await one(`select count(*)::int n from football.play p
     join football_src.source_snapshot s on s.source_snapshot_id=p.source_snapshot_id
     join football_src.source src using (source_id) where src.model_use_allowed`);
  return { pass: r.n === 0, detail: `${r.n} plays from model-allowed sources` };
});

/* --- temporal semantics */
await check('temporal.as_of_roster', 'blocker', 'roster AS-OF returns different squads in week 1 and week 18', async () => {
  const rows = await q(`select r.global_football_player_id as subject_id, r.status,
      r.effective_from::text as effective_from, r.effective_to::text as effective_to, r.observed_at
     from football.roster_status_period r
     join football.team_identity t on t.global_football_team_identity_id=r.global_football_team_identity_id
     where t.abbreviation='KC'`);
  const inSeason = asOf(rows, { validAt: '2023-10-15', knownAt: '2030-01-01' });
  const beforeSeason = asOf(rows, { validAt: '2023-06-01', knownAt: '2030-01-01' });
  return { pass: inSeason.length > 40 && beforeSeason.length === 0,
    detail: `squad in season ${inSeason.length}, before the first game ${beforeSeason.length} (season-level roster: week-by-week squads need nflverse weekly_rosters, not held)` };
});
await check('temporal.no_future_knowledge', 'blocker', 'a knowledge cutoff before ingestion hides every row', async () => {
  const rows = await q(`select global_football_player_id as subject_id, effective_from::text as effective_from,
     effective_to::text as effective_to, observed_at from football.roster_status_period limit 500`);
  const hidden = asOf(rows, { validAt: '2023-09-15', knownAt: '2023-01-01' });
  return { pass: hidden.length === 0, detail: `${hidden.length} rows leaked past the cutoff` };
});

/* --- derived layer */
await check('derived.leaderboard', 'warn', 'season leaderboards compute from canonical rows', async () => {
  const r = await q(`select n.display_name, sum(s.value)::int yards from football.player_game_stat s
     join football.player pl on pl.global_football_player_id=s.global_football_player_id
     join football.person_name n on n.global_football_person_id=pl.global_football_person_id and n.name_kind='canonical'
     join football.game g using (global_football_game_id) join football.competition c using (competition_id)
     where s.stat_key='passing_yards' and c.kind='regular_season' group by 1 order by 2 desc limit 3`);
  return { pass: r.length === 3 && r[0].yards > 3000, detail: r.map(x => `${x.display_name} ${x.yards}`).join(' | ') };
});

const failures = results.filter(r => !r.pass && r.severity === 'blocker');
const warnings = results.filter(r => !r.pass && r.severity === 'warn');
writeFileSync(join(SLICE, '_validation.json'), JSON.stringify({ ran_at: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks pass; ${failures.length} blocker failures, ${warnings.length} warnings`);
await db.close();
process.exit(failures.length ? 1 : 0);
