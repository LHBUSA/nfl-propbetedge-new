/**
 * The college spine, loaded into a real Postgres and checked.
 *
 * Skipped unless the spine has been built:
 *   python history/pipeline/fetch_college_seed.py
 *   python history/pipeline/fetch_eada.py
 *   python history/pipeline/build_college_spine.py
 *   node --test history/tests/college-spine.test.mjs
 *
 * The questions worth asking of this dataset are not "did it load". They are:
 * does the CC0 half reach the public surface while the proprietary identifiers
 * do not; is the absence of college statistics structural rather than
 * incidental; and does a draft pick we have no licence for stay null instead of
 * quietly appearing because everyone knows it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { registrySql, lanePolicySql, REGISTRY_FILE, LANES_FILE } from '../deploy/seed.mjs';
import { COLLEGE_PIPELINE_SQL, COLLEGE_TRANSITION_SQL, composeCollegePipeline, assertContract } from '../api/college-pipeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SPINE = join(REPO, 'history', '.out', 'college-spine');
const MIGRATIONS = join(REPO, 'history', 'deploy', 'migrations');
const REGISTRY_DIR = join(REPO, 'history', 'registry');

/** RFC 4180 enough for what the builder writes: quoted fields, doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

const built = existsSync(join(SPINE, '_report.json'));
const t = (name, fn) => test(name, { skip: built ? false : 'college spine not built' }, fn);

/* FK-safe order. A table missing from the build is skipped, not an error. */
const ORDER = [
  'football_src.source_snapshot',
  'football.school', 'football.college_conference', 'football.college_team',
  'football.college_conference_membership', 'football.college_program_season',
  'football.person', 'football.player', 'football.coach', 'football.person_name',
  'football.coaching_tenure',
  'football.player_college_affiliation', 'football.college_to_pro_transition',
  'football_src.entity_source_record', 'football_src.external_id',
];

let db = null;
let report = null;

if (built) {
  report = JSON.parse(readFileSync(join(SPINE, '_report.json'), 'utf8'));
  db = await PGlite.create();
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  await db.exec(registrySql(JSON.parse(readFileSync(join(REGISTRY_DIR, REGISTRY_FILE), 'utf8'))));
  await db.exec(lanePolicySql(JSON.parse(readFileSync(join(REGISTRY_DIR, LANES_FILE), 'utf8'))));

  for (const table of ORDER) {
    const path = join(SPINE, table.replace('.', '__') + '.csv');
    if (!existsSync(path)) continue;
    // Institution names contain commas ("California State Polytechnic
    // University, Humboldt"), so the file is real CSV and is parsed as such.
    const records = parseCsv(readFileSync(path, 'utf8'));
    const cols = records.shift();
    const values = records.map(parts => {
      assert.equal(parts.length, cols.length, `${table}: malformed row ${parts.join(',').slice(0, 120)}`);
      return '(' + parts.map(v => (v === '' ? 'null' : `'${v.replace(/'/g, "''")}'`)).join(',') + ')';
    });
    for (let i = 0; i < values.length; i += 2000) {
      await db.exec(`insert into ${table} (${cols.join(',')}) values ${values.slice(i, i + 2000).join(',')}
                     on conflict do nothing;`);
    }
  }
}

const asReader = async (surface, sql) => {
  await db.exec(`set role pbe_history_reader; set app.surface = '${surface}';`);
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role; reset app.surface;'); }
};
const count = async (surface, table, where = 'true') =>
  (await asReader(surface, `select count(*)::int n from ${table} where ${where}`))[0].n;

t('the CC0 half of the spine reaches the public surface', async () => {
  for (const table of ['football.school', 'football.college_team', 'football.college_conference',
    'football.player_college_affiliation', 'football.college_program_season']) {
    assert.ok(await count('public', table) > 0, `${table} must be visible publicly`);
  }
  // and it is the same data at every wider surface, not a different dataset
  assert.equal(await count('public', 'football.school'), await count('internal', 'football.school'));
});

t('the proprietary identifiers stay internal, and the CC0 one does not', async () => {
  const proprietary = `id_system in ('pfr_player_id','espn_athlete_id','nfl_com_player_id',
                                     'sports_reference_cfb_player_id','sports_reference_cfb_school_id',
                                     'ncaa_statistics_coach_id')`;
  assert.equal(await count('public', 'football_src.external_id', proprietary), 0);
  assert.equal(await count('pro', 'football_src.external_id', proprietary), 0);
  assert.ok(await count('internal', 'football_src.external_id', proprietary) > 0,
    'they must exist internally — they are the reconciliation keys');

  // The Wikidata QID is our own canonical link and is CC0 on both counts.
  assert.ok(await count('public', 'football_src.external_id', `id_system = 'wikidata_qid'`) > 0);
  // The IPEDS unit id is a federal identifier, and the EADA join depends on it.
  assert.ok(await count('public', 'football_src.external_id', `id_system = 'ipeds_unitid'`) > 0);
});

t('there are no college statistics in the graph at all', async () => {
  for (const table of ['football.player_game_stat', 'football.team_game_stat', 'football.play',
    'football.drive', 'football.player_game_snaps', 'football.combine_measurement']) {
    assert.equal(await count('internal', table), 0,
      `${table} must be empty: the spine carries no performance data`);
  }
});

t('a draft detail with no licensed source stays null rather than appearing anyway', async () => {
  const transitions = await count('internal', 'football.college_to_pro_transition');
  assert.ok(transitions > 0, 'expected some transitions');
  const withDetail = await count('internal', 'football.college_to_pro_transition',
    'draft_round is not null or draft_overall_pick is not null');
  assert.equal(withDetail, report.coverage.transitions_with_round_or_pick);
  // and the schema refuses one that is not cited, whatever the loader intends
  await assert.rejects(
    db.exec(`insert into football.college_to_pro_transition
      (college_to_pro_transition_id, global_football_player_id, entry_route, draft_round, observed_at, source_snapshot_id)
      select 'gc2p_uncited', global_football_player_id, 'draft', 1, now(), source_snapshot_id
        from football.player_college_affiliation limit 1`),
    /draft_detail_is_cited/);
});

t('every spine snapshot names a lane, and every lane is one we decided', async () => {
  const bad = (await db.query(`
    select s.source_snapshot_id, s.source_id, s.lane
      from football_src.source_snapshot s
      left join football_src.source_lane_policy lp
             on lp.source_id = s.source_id and lp.lane = s.lane
     where s.lane is null or lp.source_id is null`)).rows;
  assert.deepEqual(bad, [], 'a snapshot with no decided lane would be invisible and is a build error');

  const lanes = (await db.query(
    `select distinct source_id, lane from football_src.source_snapshot order by 1, 2`)).rows;
  assert.deepEqual(lanes, [
    { source_id: 'src_eada', lane: 'institution_program_year' },
    { source_id: 'src_wikidata', lane: 'college_affiliation' },
    { source_id: 'src_wikidata', lane: 'identifiers' },
  ]);
});

t('the read contract returns a composed record, and it carries nothing it must not', async () => {
  const [{ pid }] = (await db.query(`
    select global_football_player_id as pid
      from football.player_college_affiliation
     where global_college_team_id is not null
     order by 1 limit 1`)).rows;

  await db.exec(`set role pbe_history_reader; set app.surface = 'public';`);
  const rows = (await db.query(COLLEGE_PIPELINE_SQL, [pid, 'public'])).rows;
  const transitions = (await db.query(COLLEGE_TRANSITION_SQL, [pid, 'public'])).rows;
  await db.exec('reset role; reset app.surface;');

  assert.ok(rows.length > 0, 'the public contract must return the CC0 affiliation');
  const r = rows[0];
  assert.ok(r.school, 'a school name');
  assert.ok(['educated_at', 'member_of_sports_team', 'draft_listing', 'curated'].includes(r.basis));

  const composed = composeCollegePipeline({
    player_id: pid,
    surface: 'public',
    components: [
      { part: 'school', value: r.school, source_id: 'src_wikidata', lane: 'college_affiliation', snapshot_id: r.__snapshot_id },
      { part: 'program', value: r.program, source_id: 'src_wikidata', lane: 'college_affiliation', snapshot_id: r.__snapshot_id },
      { part: 'basis', value: r.basis, source_id: 'src_wikidata', lane: 'college_affiliation', snapshot_id: r.__snapshot_id },
      ...transitions.map(x => ({ part: 'entered_professional_football',
        value: { entry_route: x.entry_route, entry_year: x.entry_year },
        source_id: 'src_wikidata', lane: 'college_affiliation', snapshot_id: x.__snapshot_id })),
    ],
  });
  assert.ok(composed.data);
  assert.equal(assertContract(composed.data), true);
  assert.ok(composed.data.provenance.length > 0);
});

t('attendance is not silently upgraded into having played there', async () => {
  // P69 "educated at" establishes attendance. Recording it as football would be
  // an invention, so played_football stays null for every educated_at row.
  const wrong = await count('internal', 'football.player_college_affiliation',
    `basis = 'educated_at' and played_football is not null`);
  assert.equal(wrong, 0);
});

t('the EADA layer carries its survey year and its self-reported basis on every row', async () => {
  const bad = await count('internal', 'football.college_program_season',
    `survey_year is null or reporting_basis <> 'institution_self_report'`);
  assert.equal(bad, 0);
  // both the positive and the negative case are present: some institutions
  // filed and reported no football, and that is not the same as being absent
  assert.ok(await count('internal', 'football.college_program_season', 'sponsored') > 0);
});

t('the build recorded its gaps and its sampling bias rather than presenting a clean number', () => {
  assert.ok(report.gaps.length > 0, 'a build with no gaps in this data would be a build that hid them');
  for (const gap of report.gaps) {
    assert.ok(gap.gap && gap.count > 0 && gap.detail, `gap must say what and how many: ${JSON.stringify(gap)}`);
  }
  assert.equal(report.sampling_bias.bias, 'notability_survivorship');
  assert.match(report.sampling_bias.why, /no denominator/);
  assert.ok(report.not_included.some(x => /college statistics/.test(x)));
});

test.after(() => { if (db) db.close(); });
