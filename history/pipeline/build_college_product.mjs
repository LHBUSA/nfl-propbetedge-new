/**
 * Build the product artifact for the College Path section of Player DNA.
 *
 *   node history/pipeline/build_college_product.mjs
 *
 * Writes data/dist/college-path.json — one deterministic record per NFL player
 * the Career Ledger tracks, so a profile view is a single object lookup rather
 * than a graph query. The history graph is not deployed anywhere, and a page
 * view must not depend on it being deployed.
 *
 * TWO SURFACES, ON PURPOSE
 * ------------------------
 * Identity is resolved on the INTERNAL lane and content is read on the PUBLIC
 * one, in that order, and they are not the same permission:
 *
 *   * The identifier crosswalk (Wikidata's PFR / ESPN id statements, and
 *     nflverse's approved id columns) is internal reconciliation only. It is
 *     used here to decide WHICH graph player a profile is, and none of it is
 *     written to the artifact.
 *   * Everything that reaches the file is read back through
 *     football_rights.surface_allows(..., 'public', ...) as the pbe_history_reader
 *     role, then composed by history/api/college-pipeline.mjs. So a row the
 *     public surface may not see cannot reach the product even if this script
 *     asked for it — the database refuses, not the script.
 *
 * Identity is strong-id only: gsis -> pfr -> Wikidata, or ESPN id -> Wikidata.
 * Where two strong ids disagree about which graph player this is, the player is
 * recorded as AMBIGUOUS and gets no college section. A name is never a join.
 *
 * No CollegeFootballData. No college statistics. No ratings, rankings or grades.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { registrySql, lanePolicySql, REGISTRY_FILE, LANES_FILE } from '../deploy/seed.mjs';
import {
  COLLEGE_PIPELINE_SQL, COLLEGE_TRANSITION_SQL,
  composeCollegePipeline, assertContract,
} from '../api/college-pipeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SPINE = join(REPO, 'history', '.out', 'college-spine');
const MIGRATIONS = join(REPO, 'history', 'deploy', 'migrations');
const REGISTRY_DIR = join(REPO, 'history', 'registry');
const LEDGER = join(REPO, 'data', 'dist', 'career-ledger.json');
const CROSSWALK = join(REPO, 'history', '.out', 'college-spine', '_crosswalk.json');
const OUT = join(REPO, 'data', 'dist', 'college-path.json');

const CONTRACT = 'college-path/v1';

/* FK-safe load order for the spine CSVs. */
const ORDER = [
  'football_src.source_snapshot',
  'football.school', 'football.college_conference', 'football.college_team',
  'football.college_conference_membership', 'football.college_program_season',
  'football.person', 'football.player', 'football.coach', 'football.person_name',
  'football.coaching_tenure',
  'football.player_college_affiliation', 'football.college_to_pro_transition',
  'football_src.entity_source_record', 'football_src.external_id',
];

/** RFC 4180 enough for what the builder writes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
      else field += c;
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

async function loadSpine(db) {
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  await db.exec(registrySql(JSON.parse(readFileSync(join(REGISTRY_DIR, REGISTRY_FILE), 'utf8'))));
  await db.exec(lanePolicySql(JSON.parse(readFileSync(join(REGISTRY_DIR, LANES_FILE), 'utf8'))));
  for (const table of ORDER) {
    const path = join(SPINE, table.replace('.', '__') + '.csv');
    if (!existsSync(path)) continue;
    const records = parseCsv(readFileSync(path, 'utf8'));
    const cols = records.shift();
    const values = records.map(parts =>
      '(' + parts.map(v => (v === '' ? 'null' : `'${v.replace(/'/g, "''")}'`)).join(',') + ')');
    for (let i = 0; i < values.length; i += 2000) {
      await db.exec(`insert into ${table} (${cols.join(',')}) values ${values.slice(i, i + 2000).join(',')}
                     on conflict do nothing;`);
    }
  }
}

/* ---------------------------------------------------------------- identity */
/**
 * Resolve ledger players to graph players using strong identifiers only.
 *
 * The crosswalk file is produced by history/pipeline/build_college_crosswalk.py,
 * which reads three nflverse id columns (approved for internal reconciliation)
 * so this script needs no parquet reader. It maps espn_id -> pfr_id, and
 * nothing else.
 */
function resolveIdentities(db, ledger, crosswalk) {
  return (async () => {
    const rows = (await db.query(`
      select entity_id, id_system, id_value
        from football_src.external_id
       where entity_type = 'player'
         and id_system in ('pfr_player_id','espn_athlete_id')`)).rows;

    const byPfr = new Map(), byEspn = new Map();
    for (const r of rows) {
      if (r.id_system === 'pfr_player_id') {
        // Wikidata stores the PFR id with its directory prefix ("A/AdamCo00");
        // nflverse stores the bare key. Same identifier, two spellings, and a
        // literal compare silently matches nothing at all.
        const bare = r.id_value.includes('/') ? r.id_value.split('/').pop() : r.id_value;
        byPfr.set(bare, r.entity_id);
      } else {
        byEspn.set(String(r.id_value), r.entity_id);
      }
    }

    const resolved = new Map();
    const ambiguous = [];
    let viaPfr = 0, viaEspn = 0;
    for (const espnId of Object.keys(ledger)) {
      const pfr = crosswalk.espn_to_pfr[espnId] || null;
      const fromPfr = pfr ? byPfr.get(pfr) || null : null;
      const fromEspn = byEspn.get(String(espnId)) || null;
      if (fromPfr && fromEspn && fromPfr !== fromEspn) {
        // Two strong ids naming two different people. That is not a match to
        // pick between; it is a match to refuse.
        ambiguous.push({ espn_id: espnId, via_pfr: fromPfr, via_espn: fromEspn });
        continue;
      }
      const graphId = fromPfr || fromEspn;
      if (!graphId) continue;
      if (fromPfr) viaPfr += 1; else viaEspn += 1;
      resolved.set(espnId, graphId);
    }
    return { resolved, ambiguous, viaPfr, viaEspn };
  })();
}

/* ---------------------------------------------------------------- main */
async function main() {
  if (!existsSync(SPINE)) throw new Error(`no spine at ${SPINE} — run build_college_spine.py first`);
  if (!existsSync(CROSSWALK)) throw new Error(`no crosswalk at ${CROSSWALK} — run build_college_crosswalk.py first`);

  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const crosswalk = JSON.parse(readFileSync(CROSSWALK, 'utf8'));
  const players = ledger.players;
  console.log(`ledger: ${Object.keys(players).length} players`);

  const db = await PGlite.create();
  console.log('loading the spine into Postgres…');
  await loadSpine(db);

  // Identity, on the internal lane. None of this reaches the artifact.
  const { resolved, ambiguous, viaPfr, viaEspn } = await resolveIdentities(db, players, crosswalk);
  console.log(`resolved ${resolved.size} of ${Object.keys(players).length} (pfr ${viaPfr}, espn ${viaEspn}); ambiguous ${ambiguous.length}`);

  // Snapshot freshness, for the provenance line the section shows.
  const snapshots = Object.fromEntries((await db.query(
    `select source_snapshot_id, source_id, lane, retrieved_at from football_src.source_snapshot`
  )).rows.map(r => [r.source_snapshot_id, {
    source_id: r.source_id, lane: r.lane,
    retrieved_at: r.retrieved_at instanceof Date ? r.retrieved_at.toISOString() : String(r.retrieved_at),
  }]));

  /* From here on every read is the PUBLIC surface as the read-only role. If a
     row is not public, the database does not return it to this script. */
  await db.exec(`set role pbe_history_reader; set app.surface = 'public';`);

  /* Coaching tenures, read once. Row-level security evaluates the lane
     predicate per row and is not index-assisted (a security qual runs before an
     index condition, by design), so asking per player turned a two-minute build
     into a twenty-minute one for the same answer. There are a few hundred
     tenures in total; the overlap arithmetic belongs in memory. */
  /* The year is extracted IN SQL. A date column comes back from the driver as a
     JS Date, and String(date) is "Mon Jan 01 2015 …", so slicing the first four
     characters yields the weekday — which silently becomes NaN and drops every
     row. Asking Postgres for the number it already holds removes the question. */
  const tenures = new Map();
  for (const r of (await db.query(`
      select t.global_college_team_id as program_id, n.display_name as coach,
             extract(year from t.effective_from)::int as from_year,
             extract(year from t.effective_to)::int as to_year
        from football.coaching_tenure t
        join football.coach c on c.global_football_coach_id = t.global_football_coach_id
        join football.person_name n on n.global_football_person_id = c.global_football_person_id
       where t.global_college_team_id is not null
         and t.effective_from is not null
       order by 3`)).rows) {
    if (!Number.isFinite(r.from_year)) continue;
    if (!tenures.has(r.program_id)) tenures.set(r.program_id, []);
    tenures.get(r.program_id).push({ coach: r.coach, from: r.from_year, to: r.to_year ?? null });
  }
  console.log(`coaching tenures on ${tenures.size} programmes`);

  const out = {};
  const stats = {
    resolved: resolved.size, with_college: 0, with_conference: 0, with_years: 0,
    with_coach: 0, with_transition: 0, with_program: 0, multi_school: 0,
    resolved_without_college: 0,
  };

  for (const [espnId, graphId] of resolved) {
    const affiliations = (await db.query(COLLEGE_PIPELINE_SQL, [graphId, 'public'])).rows;
    const transitions = (await db.query(COLLEGE_TRANSITION_SQL, [graphId, 'public'])).rows;
    if (!affiliations.length && !transitions.length) { stats.resolved_without_college += 1; continue; }

    const schools = [];
    for (const a of affiliations) {
      /* Each association is composed through the read contract, so the field
         allowlist and the forbidden-name check run on every row that ships. */
      const parts = [
        ['school', a.school], ['school_id', a.school_id], ['program', a.program],
        ['program_id', a.program_id], ['conference', a.conference],
        ['first_season', a.first_season], ['last_season', a.last_season],
        ['date_precision', a.date_precision], ['basis', a.basis],
        ['played_football', a.played_football],
      ].filter(([, v]) => v !== null && v !== undefined);

      const composed = composeCollegePipeline({
        player_id: graphId,
        surface: 'public',
        components: parts.map(([part, value]) => ({
          part, value, source_id: a.__source_id, lane: a.__lane, snapshot_id: a.__snapshot_id,
        })),
      });
      if (!composed.data) continue;
      const { player_id, provenance, ...fields } = composed.data;
      schools.push({ ...fields, snapshot_id: a.__snapshot_id });
    }
    if (!schools.length && !transitions.length) { stats.resolved_without_college += 1; continue; }

    /* Coaching overlap. Only where BOTH the tenure and the player's years are
       dated: an overlap computed against an unknown window is a guess. */
    const coaches = [];
    for (const s of schools) {
      if (!s.program_id || !s.first_season) continue;
      const last = s.last_season || s.first_season;
      for (const t of tenures.get(s.program_id) || []) {
        if (t.from > last) continue;
        if ((t.to ?? 9999) < s.first_season) continue;
        if (coaches.some(c => c.coach === t.coach && c.program_id === s.program_id)) continue;
        coaches.push({
          coach: t.coach, program: s.program, program_id: s.program_id,
          from: String(t.from), to: t.to ? String(t.to) : null,
        });
      }
    }

    const transition = transitions.length ? {
      entry_route: transitions[0].entry_route,
      entry_year: transitions[0].entry_year,
      draft_round: transitions[0].draft_round,
      draft_overall_pick: transitions[0].draft_overall_pick,
      snapshot_id: transitions[0].__snapshot_id,
    } : null;

    const snapIds = [...new Set([...schools.map(s => s.snapshot_id),
      ...(transition ? [transition.snapshot_id] : [])].filter(Boolean))];

    const record = {
      schools, coaches, transition,
      provenance: {
        sources: [...new Set(snapIds.map(id => snapshots[id]?.source_id).filter(Boolean))].sort(),
        lanes: [...new Set(snapIds.map(id => snapshots[id]?.lane).filter(Boolean))].sort(),
        retrieved_at: snapIds.map(id => snapshots[id]?.retrieved_at).filter(Boolean).sort().pop() || null,
      },
    };
    assertContract(record);            // the proof, again, on the shipped shape
    out[espnId] = record;

    stats.with_college += 1;
    if (schools.length > 1) stats.multi_school += 1;
    if (schools.some(s => s.conference)) stats.with_conference += 1;
    if (schools.some(s => s.first_season)) stats.with_years += 1;
    if (schools.some(s => s.program_id)) stats.with_program += 1;
    if (coaches.length) stats.with_coach += 1;
    if (transition) stats.with_transition += 1;
  }

  await db.exec('reset role; reset app.surface;');
  await db.close();

  const total = Object.keys(players).length;
  const active = Object.values(players).filter(p => p.active_2026).length;
  const activeWith = Object.entries(players)
    .filter(([id, p]) => p.active_2026 && out[id]).length;
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '0%');

  const artifact = {
    meta: {
      contract: CONTRACT,
      generated_at: new Date().toISOString(),
      surface: 'public',
      read_contract: 'history/api/college-pipeline.mjs',
      identity:
        'ESPN athlete id -> (nflverse approved id columns) -> Pro-Football-Reference id -> Wikidata QID, '
        + 'or ESPN athlete id -> Wikidata QID directly. Strong identifiers only; a name is never a join. '
        + 'Where two strong ids disagree the player is recorded ambiguous and gets no section.',
      sources: ['src_wikidata (CC0)', 'src_eada (US Dept of Education)'],
      lanes: ['src_wikidata/college_affiliation', 'src_eada/institution_program_year'],
      sampling_bias: {
        bias: 'notability_survivorship',
        meaning:
          'Absence is not evidence. This layer is built from Wikidata items, which exist for people '
          + 'notable enough to have one, so a missing college record means we have not resolved it — '
          + 'never that the player did not play college football.',
      },
      not_included: [
        'college statistics of any kind', 'recruiting ratings, stars or rankings',
        'talent composite, SP+, FPI', 'scouting or draft grades',
        'any CollegeFootballData field (CFBD ingestion is disabled)',
      ],
      coverage: {
        ledger_players: total,
        resolved_to_graph: stats.resolved,
        ambiguous_identities: ambiguous.length,
        unmatched: total - stats.resolved - ambiguous.length,
        with_college_path: stats.with_college,
        with_college_path_pct: pct(stats.with_college, total),
        resolved_without_college: stats.resolved_without_college,
        with_conference: stats.with_conference,
        with_years: stats.with_years,
        with_program: stats.with_program,
        with_coaching_overlap: stats.with_coach,
        with_pro_transition: stats.with_transition,
        multiple_schools: stats.multi_school,
        active_2026: active,
        active_2026_with_college_path: activeWith,
        active_2026_pct: pct(activeWith, active),
      },
      ambiguous,
    },
    players: out,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact) + '\n');

  const c = artifact.meta.coverage;
  console.log(`\nwrote ${OUT}`);
  console.log(`  ledger players            ${c.ledger_players}`);
  console.log(`  resolved to graph         ${c.resolved_to_graph}`);
  console.log(`  ambiguous identities      ${c.ambiguous_identities}`);
  console.log(`  unmatched                 ${c.unmatched}`);
  console.log(`  WITH COLLEGE PATH         ${c.with_college_path}  (${c.with_college_path_pct})`);
  console.log(`  resolved, no college row  ${c.resolved_without_college}`);
  console.log(`  with conference           ${c.with_conference}`);
  console.log(`  with years                ${c.with_years}`);
  console.log(`  with coaching overlap     ${c.with_coaching_overlap}`);
  console.log(`  with pro transition       ${c.with_pro_transition}`);
  console.log(`  multiple schools          ${c.multiple_schools}`);
  console.log(`  active 2026 covered       ${c.active_2026_with_college_path}/${c.active_2026}  (${c.active_2026_pct})`);
}

main();
