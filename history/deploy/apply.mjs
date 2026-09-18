/**
 * Apply the ordered migrations to the history database.
 *
 *   node history/deploy/apply.mjs --url postgres://... [--execute]
 *
 * Without --execute this prints the plan and changes nothing, which is the
 * default because a migration run is the one command here that is hard to take
 * back. Applied migrations are recorded in football_deploy.migration with the
 * checksum of exactly what ran, so a later run applies only what is new and a
 * changed file is reported rather than silently re-run.
 *
 * Requires: psql on PATH (Supabase gives the connection string; we do not add a
 * driver dependency for a command an operator runs by hand).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveTarget, describeTarget, RefusedTarget } from './target.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, 'migrations');
const sha = (t) => createHash('sha256').update(t.replace(/\r\n/g, '\n')).digest('hex');

export function migrationFiles() {
  if (!existsSync(MIGRATIONS)) return [];
  return readdirSync(MIGRATIONS).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
}

function psql(dsn, sql, { file = null } = {}) {
  const args = ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', dsn];
  if (file) args.push('-f', file); else args.push('-c', sql);
  return execFileSync('psql', args, { encoding: 'utf8' });
}

function appliedMigrations(dsn) {
  try {
    const out = psql(dsn, `select filename || ' ' || sha256 from football_deploy.migration`);
    return new Map(out.trim().split('\n').filter(Boolean).map(l => {
      const [filename, hash] = l.trim().split(/\s+/);
      return [filename, hash];
    }));
  } catch {
    return new Map();                  // ledger does not exist yet: nothing applied
  }
}

function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const url = argv[argv.indexOf('--url') + 1];
  let target;
  try {
    target = resolveTarget({ url: argv.includes('--url') ? url : undefined, allowWrite: execute });
  } catch (e) {
    if (e instanceof RefusedTarget) { console.error(e.message); process.exit(2); }
    throw e;
  }
  const files = migrationFiles();
  if (!files.length) { console.error('no migrations; run node history/deploy/generate.mjs'); process.exit(1); }

  const applied = execute || argv.includes('--url') ? appliedMigrations(target.dsn) : new Map();
  console.log(`target: ${describeTarget(target)}`);
  const pending = [];
  for (const file of files) {
    const body = readFileSync(join(MIGRATIONS, file), 'utf8');
    const hash = sha(body);
    const before = applied.get(file);
    if (!before) { pending.push({ file, body, hash }); console.log(`  pending  ${file}`); }
    else if (before !== hash) {
      console.error(`  CHANGED  ${file} — applied as ${before.slice(0, 12)}, now ${hash.slice(0, 12)}`);
      console.error('A migration that has already run must not be edited. Add a new one.');
      process.exit(3);
    } else console.log(`  applied  ${file}`);
  }
  if (!pending.length) { console.log('nothing to do'); return; }
  if (!execute) {
    console.log(`\n${pending.length} migration(s) would be applied. Re-run with --execute to apply.`);
    return;
  }
  for (const step of pending) {
    process.stdout.write(`applying ${step.file} ... `);
    psql(target.dsn, null, { file: join(MIGRATIONS, step.file) });
    psql(target.dsn, `insert into football_deploy.migration (filename, sha256) values ('${step.file}', '${step.hash}')
                      on conflict (filename) do update set sha256 = excluded.sha256, applied_at = now()`);
    console.log('ok');
  }
  console.log(`applied ${pending.length} migration(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
