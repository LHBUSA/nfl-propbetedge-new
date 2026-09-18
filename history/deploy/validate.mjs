/**
 * Run the deployment validation suite (or just the canaries) against a target.
 *
 *   node history/deploy/validate.mjs --url postgres://...
 *   node history/deploy/validate.mjs --url postgres://... --canary
 *
 * Read-only. Uses psql, and refuses any database that serves live product.
 * The same checks run against PGlite in history/tests/deploy.test.mjs, so the
 * package is proven before it is pointed at a server.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CHECKS, CANARIES, runChecks, report } from './checks.mjs';
import { resolveTarget, describeTarget, RefusedTarget } from './target.mjs';

/** A query function over psql that returns rows as objects. */
export function psqlQuery(dsn) {
  return async (sql) => {
    const wrapped = `select coalesce(json_agg(t), '[]'::json)::text from (${sql.replace(/;\s*$/, '')}) t`;
    const out = execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-At', dsn, '-c', wrapped], { encoding: 'utf8' });
    return { rows: JSON.parse(out.trim() || '[]') };
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const canaryOnly = argv.includes('--canary');
  let target;
  try {
    target = resolveTarget({ url: argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : undefined });
  } catch (e) {
    if (e instanceof RefusedTarget) { console.error(e.message); process.exit(2); }
    throw e;
  }
  console.log(`target: ${describeTarget(target)}\n`);
  const { results, failed } = await runChecks(psqlQuery(target.dsn), canaryOnly ? CANARIES : CHECKS);
  report(results);
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} checks pass; ${failed.length} blocker failures`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
