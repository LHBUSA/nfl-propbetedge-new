/**
 * Load the history database: the source registry and rights policy first, then
 * the built datasets.
 *
 *   node history/deploy/seed.mjs --url postgres://... [--execute]
 *   node history/deploy/seed.mjs --url postgres://... --only registry --execute
 *
 * Order matters and is not negotiable: a dataset cannot be loaded before the
 * sources it cites exist, because every row's rights are resolved through its
 * snapshot. Loading is idempotent (on conflict do nothing) so a re-run after a
 * partial failure is safe, and each run is recorded in football_deploy.load.
 *
 * Dry run by default. Refuses any database that serves live product.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveTarget, describeTarget, RefusedTarget } from './target.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(REPO, 'history', '.out');

/* Load order. Each dataset is a directory of <schema>__<table>.csv written by a
   builder; the table order inside comes from the schema's foreign keys. */
export const DATASETS = [
  { name: 'registry', kind: 'registry', describe: 'source registry and rights policy (history/registry/sources.v1.json)' },
  { name: 'skeleton', kind: 'csv', dir: join(OUT, 'skeleton'), describe: 'all-era CC0 skeleton (build_skeleton.py)' },
  { name: 'slice2023', kind: 'csv', dir: join(OUT, 'slice2023'), describe: '2023 NFL vertical slice (build_slice_2023.py)' },
];

export const TABLE_ORDER = [
  'football_src.source', 'football_src.source_snapshot',
  'football.organization', 'football.league', 'football.rules_profile', 'football.season', 'football.competition',
  'football.org_unit', 'football.franchise', 'football.team_identity', 'football.team_identity_franchise',
  'football.franchise_lineage_event', 'football.team_alignment',
  'football.venue', 'football.venue_name', 'football.venue_attribute_period', 'football.team_home_venue',
  'football.person', 'football.person_name', 'football.player', 'football.coach', 'football.coaching_tenure',
  'football.school', 'football.college_team', 'football.career_stage',
  'football.position_ontology_entry', 'football.player_position_observation',
  'football.jersey_number_period', 'football.roster_status_period',
  'football.stat_definition', 'football.championship_result',
  'football.game', 'football.game_team_score', 'football.game_weather_observation',
  'football.drive', 'football.play', 'football.play_participant', 'football.play_penalty',
  'football.player_game_stat', 'football.team_game_stat', 'football.player_game_appearance',
  'football_src.entity_source_record', 'football_src.external_id',
];

/** SQL that loads the registry JSON as rows, so rights live in the database. */
export function registrySql(registry) {
  const lit = v => v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
  const rows = registry.sources.map(s => `(${[
    lit(s.source_id), lit(s.name), lit(s.governing_org || s.origin), 'null', lit(s.licence_class),
    lit(s.commercial_verdict), lit(s.obligations || null), lit(s.terms_url || null), lit(s.terms_quote || null),
    lit(s.owner_decision || null), s.owner_decision ? 'now()' : 'null',
    lit(s.display_policy), s.model_use_allowed ? 'true' : 'false', lit(s.notes || null),
  ].join(', ')})`).join(',\n    ');
  return `insert into football_src.source
    (source_id, name, governing_org, origin_source_id, licence_class, commercial_verdict, obligations,
     terms_url, terms_quote, decided_by, decided_at, display_policy, model_use_allowed, notes)
  values
    ${rows}
  on conflict (source_id) do update set
    licence_class = excluded.licence_class,
    commercial_verdict = excluded.commercial_verdict,
    display_policy = excluded.display_policy,
    model_use_allowed = excluded.model_use_allowed,
    terms_url = excluded.terms_url,
    terms_quote = excluded.terms_quote,
    obligations = excluded.obligations,
    notes = excluded.notes;`;
}

/** Files present for a dataset, in load order. */
export function filesFor(dir) {
  if (!existsSync(dir)) return [];
  const present = new Set(readdirSync(dir).filter(f => f.endsWith('.csv')));
  return TABLE_ORDER
    .map(table => ({ table, file: table.replace('.', '__') + '.csv' }))
    .filter(x => present.has(x.file))
    .map(x => ({ ...x, path: join(dir, x.file) }));
}

/* A CSV is loaded through a staging table so that rows two datasets share — a
   league, a season, a source — are inserted once rather than colliding. */
export function loadSql(table, header) {
  return [
    `create temp table _stage (like ${table});`,
    `\\copy _stage (${header}) from '%FILE%' with (format csv, header true)`,
    `insert into ${table} select * from _stage on conflict do nothing;`,
    `drop table _stage;`,
  ].join('\n');
}

function psqlFile(dsn, sql) {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', dsn, '-c', sql], { encoding: 'utf8' });
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  let target;
  try {
    target = resolveTarget({ url: argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : undefined, allowWrite: execute });
  } catch (e) {
    if (e instanceof RefusedTarget) { console.error(e.message); process.exit(2); }
    throw e;
  }
  console.log(`target: ${describeTarget(target)}`);

  for (const dataset of DATASETS) {
    if (only && dataset.name !== only) continue;
    if (dataset.kind === 'registry') {
      const registry = JSON.parse(readFileSync(join(REPO, 'history', 'registry', 'sources.v1.json'), 'utf8'));
      console.log(`  registry     ${registry.sources.length} sources — ${dataset.describe}`);
      if (execute) {
        psqlFile(target.dsn, registrySql(registry));
        psqlFile(target.dsn, `insert into football_deploy.load (dataset, rows_loaded, started_at) values ('registry', ${registry.sources.length}, now())`);
      }
      continue;
    }
    const files = filesFor(dataset.dir);
    if (!files.length) {
      console.log(`  ${dataset.name.padEnd(12)} not built — run the builder first (${dataset.describe})`);
      continue;
    }
    console.log(`  ${dataset.name.padEnd(12)} ${files.length} tables — ${dataset.describe}`);
    if (!execute) continue;
    const started = new Date().toISOString();
    let rows = 0;
    for (const { table, path } of files) {
      const text = readFileSync(path, 'utf8');
      const header = text.slice(0, text.indexOf('\n')).trim();
      psqlFile(target.dsn, loadSql(table, header).replace('%FILE%', path.replace(/\\/g, '/')));
      rows += text.split('\n').length - 2;
    }
    psqlFile(target.dsn, `insert into football_deploy.load (dataset, rows_loaded, started_at) values ('${dataset.name}', ${rows}, '${started}')`);
    console.log(`  ${dataset.name.padEnd(12)} loaded ~${rows} rows`);
  }
  if (!execute) console.log('\ndry run. Re-run with --execute to load.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
