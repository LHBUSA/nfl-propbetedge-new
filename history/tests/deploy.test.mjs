/**
 * The deployment package, proven without a server.
 *
 * The migrations are applied to a real Postgres (PGlite), the registry is
 * seeded, and the checks that would run against the history project run here.
 * The point of interest is the rights gate: a reader on the public surface must
 * not be able to read a row whose source is not public, whatever query it
 * writes — because the filter is a policy in the database, not a decision an
 * endpoint is trusted to make.
 *
 *   node --test history/tests/deploy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { CHECKS, CANARIES, runChecks } from '../deploy/checks.mjs';
import { resolveTarget, RefusedTarget, FORBIDDEN_PROJECT_REFS } from '../deploy/target.mjs';
import { registrySql, lanePolicySql, REGISTRY_FILE, LANES_FILE } from '../deploy/seed.mjs';
import { buildRightsSql, parseTables, plan } from '../deploy/generate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MIGRATIONS = join(REPO, 'history', 'deploy', 'migrations');

/* ------------------------------------------------------------ target guard */
test('a deployment command refuses the databases that serve live product', () => {
  for (const ref of FORBIDDEN_PROJECT_REFS) {
    assert.throws(() => resolveTarget({ url: `postgres://postgres:pw@db.${ref}.supabase.co:5432/postgres` }),
      (e) => e instanceof RefusedTarget && /serves live product/.test(e.message),
      `must refuse project ${ref}`);
  }
});

test('there is no default target, and writing needs an explicit confirmation', () => {
  assert.throws(() => resolveTarget({ env: {} }), /no target database/);
  assert.throws(() => resolveTarget({ url: 'postgres://u:p@db.history.example:5432/postgres', allowWrite: true, env: {} }),
    /HISTORY_DEPLOY_CONFIRM/);
  const ok = resolveTarget({ url: 'postgres://u:p@db.history.example:5432/postgres', allowWrite: true,
    env: { HISTORY_DEPLOY_CONFIRM: 'i-understand-this-writes-to-the-history-database' } });
  assert.equal(ok.write, true);
});

test('a non-postgres target is refused', () => {
  assert.throws(() => resolveTarget({ url: 'https://db.history.example' }), /not postgres/);
});

/* ------------------------------------------------------------ generation */
test('every table has a rights rule, and adding one without a decision fails the build', () => {
  const { tables } = plan();
  assert.ok(tables.length > 50, `expected the full schema, saw ${tables.length} tables`);
  assert.ok(buildRightsSql(tables).includes('enable row level security'));
  const undecided = parseTables(`create table football.brand_new (
  id text primary key,
  note text
);`);
  assert.throws(() => buildRightsSql(undecided), /no rights rule for: football.brand_new/);
});

test('the committed migrations match the schema', async () => {
  const { steps } = plan();
  const onDisk = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  assert.deepEqual(onDisk, steps.map(s => s.name));
});

/* ------------------------------------------------------------ applied */
const db = await PGlite.create();
for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
}
await db.exec(registrySql(JSON.parse(readFileSync(join(REPO, 'history', 'registry', REGISTRY_FILE), 'utf8'))));
await db.exec(lanePolicySql(JSON.parse(readFileSync(join(REPO, 'history', 'registry', LANES_FILE), 'utf8'))));
await db.exec(`insert into football_deploy.migration (filename, sha256)
  select f, repeat('0', 64) from unnest(array[${readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).map(f => `'${f}'`).join(',')}]) f;`);

/* Two snapshots from two sources with different rights, and one row from each
   in the same table. A public reader must see exactly one of them. */
await db.exec(`
  insert into football_src.source_snapshot (source_snapshot_id, source_id, dataset, retrieved_from, retrieved_at, content_sha256, parser_name, parser_version, row_count)
  values ('snp_cc0', 'src_wikidata', 'test', 'test', now(), 'x', 'test', '1', 1),
         ('snp_restricted', 'src_nflverse_pbp', 'test', 'test', now(), 'x', 'test', '1', 1);
  insert into football.league (league_id, name, short_name, level, country_code, source_snapshot_id)
  values ('glg_public', 'Public League', 'PUB', 'professional', 'US', 'snp_cc0'),
         ('glg_restricted', 'Restricted League', 'RES', 'professional', 'US', 'snp_restricted');`);

const asReader = async (surface, sql) => {
  await db.exec(`set role pbe_history_reader; set app.surface = '${surface}';`);
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role; reset app.surface;'); }
};

test('the public surface cannot read a restricted source, however it asks', async () => {
  assert.deepEqual((await asReader('public', `select league_id from football.league order by 1`)).map(r => r.league_id), ['glg_public']);
  // counting, aggregating and existence probes are all the same policy
  assert.equal((await asReader('public', `select count(*)::int n from football.league`))[0].n, 1);
  assert.deepEqual(await asReader('public', `select league_id from football.league where league_id = 'glg_restricted'`), []);
});

test('a caller that names no surface gets the public one, not everything', async () => {
  await db.exec(`set role pbe_history_reader;`);
  const rows = (await db.query(`select league_id from football.league`)).rows;
  await db.exec('reset role');
  assert.deepEqual(rows.map(r => r.league_id), ['glg_public']);
});

test('internal sees the restricted row; pro does not, because nflverse is internal_only', async () => {
  assert.equal((await asReader('internal', `select count(*)::int n from football.league`))[0].n, 2);
  assert.equal((await asReader('pro', `select count(*)::int n from football.league`))[0].n, 1);
});

test('the reader cannot write, and cannot widen its own surface', async () => {
  await assert.rejects(asReader('public', `insert into football.league (league_id, name, short_name, level, source_snapshot_id)
    values ('glg_x', 'X', 'X', 'professional', 'snp_cc0')`), /permission denied/i);
  await assert.rejects(asReader('public', `update football_src.source set display_policy = 'public' where source_id = 'src_nflverse_pbp'`), /permission denied/i);
});

test('derived output stays internal until its inputs\' rights are recorded', async () => {
  await db.exec(`insert into football_derived.derivation (derivation_id, name, code_version, input_snapshot_ids, computed_at)
                 values ('drv_1', 'test', 'abc1234', array['snp_cc0'], now())`);
  assert.equal((await asReader('public', `select count(*)::int n from football_derived.derivation`))[0].n, 0);
  assert.equal((await asReader('internal', `select count(*)::int n from football_derived.derivation`))[0].n, 1);
});

test('the deployment checks run against the applied database', async () => {
  const { results } = await runChecks(sql => db.query(sql), CHECKS);
  const byName = Object.fromEntries(results.map(r => [r.name, r]));
  for (const name of ['schema.present', 'schema.isolated', 'migrations.recorded', 'rights.rls_on_every_table',
    'rights.surface_function', 'rights.registry_complete', 'rights.lane_policy_present',
    'rights.refused_lanes_cannot_be_ingested', 'rights.cfbd_not_ingested',
    'provenance.every_row_cited', 'provenance.snapshot_has_source']) {
    assert.equal(byName[name].pass, true, `${name}: ${byName[name].detail}`);
  }
  // The skeleton is not loaded in this fixture, so its content check must fail
  // rather than pass vacuously.
  assert.equal(byName['skeleton.eras'].pass, false, 'an empty database must not pass the content checks');
});

test('every canary is safe to run repeatedly: they only read', () => {
  for (const canary of CANARIES) {
    assert.ok(!/\b(insert|update|delete|drop|alter|create)\b/i.test(canary.sql), `${canary.name} must be read-only`);
  }
});

test.after(() => db.close());

test('the registry vocabulary is the vocabulary the schema accepts', async () => {
  // This caught six sources whose verdict ('do_not_use') the schema refused:
  // a rights decision that could never have reached the database.
  const registry = JSON.parse(readFileSync(join(REPO, 'history', 'registry', REGISTRY_FILE), 'utf8'));
  const loaded = (await db.query(`select source_id from football_src.source`)).rows.map(r => r.source_id).sort();
  assert.deepEqual(loaded, registry.sources.map(s => s.source_id).sort(),
    'every source in the registry must be loadable');
});

/* ------------------------------------------------------------ connection */
test('a query parameter can narrow the surface but never widen it', async () => {
  const { surfaceFor, normaliseSurface } = await import('../deploy/connection.mjs');
  assert.equal(surfaceFor({ entitlement: null }), 'public');
  assert.equal(surfaceFor({ entitlement: 'pro' }), 'pro');
  assert.equal(surfaceFor({ entitlement: 'public', requested: 'internal' }), 'public');
  assert.equal(surfaceFor({ entitlement: 'pro', requested: 'internal' }), 'pro');
  assert.equal(surfaceFor({ entitlement: 'internal', requested: 'public' }), 'public');
  assert.equal(normaliseSurface('nonsense'), 'public');
});

test('the surface is set per transaction, so it cannot leak onto a pooled connection', async () => {
  const source = readFileSync(join(REPO, 'history', 'deploy', 'connection.mjs'), 'utf8');
  assert.ok(/set_config\([^)]*true\)/.test(source), 'must use SET LOCAL semantics');
  assert.ok(!/\bquery\('set app\.surface/i.test(source), 'a session-wide SET would outlive the request');
  assert.ok(source.includes('begin read only'), 'the API connection must not be able to write');
});
