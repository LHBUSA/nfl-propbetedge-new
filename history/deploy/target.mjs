/**
 * Which database a deployment command is allowed to touch.
 *
 * The history graph gets its own Supabase project (owner decision D2). The
 * hazard is not a typo in a project name — it is a connection string picked up
 * from an environment that was set for something else and quietly writing
 * historical tables into the database that serves live NFL customers. So the
 * target is never implicit: it must be passed, it must be named as the history
 * database, and a connection that points at a known production project is
 * refused rather than trusted.
 */

/* Project refs that must never receive history data. These serve live product:
   NFL and UFC on one, MLB and PropTech on the other. */
export const FORBIDDEN_PROJECT_REFS = ['tkmlnhmylqnttmnsnief', 'rlfyavnhbngwbldebrid'];

export class RefusedTarget extends Error {}

export function resolveTarget({ url, allowWrite = false, env = process.env } = {}) {
  const dsn = url || env.HISTORY_DATABASE_URL || null;
  if (!dsn) {
    throw new RefusedTarget(
      'no target database. Pass --url, or set HISTORY_DATABASE_URL to the history project only.\n' +
      'There is no default: a default is how data lands in the wrong database.');
  }
  let parsed;
  try {
    parsed = new URL(dsn);
  } catch {
    throw new RefusedTarget('target is not a valid connection URL');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new RefusedTarget(`target protocol ${parsed.protocol} is not postgres`);
  }
  const host = parsed.hostname.toLowerCase();
  const hit = FORBIDDEN_PROJECT_REFS.find(ref => host.includes(ref) || (parsed.username || '').includes(ref));
  if (hit) {
    throw new RefusedTarget(
      `refusing to touch ${host}: project ${hit} serves live product.\n` +
      'The history graph has its own project by owner decision; nothing here writes to production.');
  }
  if (allowWrite && env.HISTORY_DEPLOY_CONFIRM !== 'i-understand-this-writes-to-the-history-database') {
    throw new RefusedTarget(
      'write commands need HISTORY_DEPLOY_CONFIRM=i-understand-this-writes-to-the-history-database.\n' +
      'Reads and --dry-run need nothing.');
  }
  return { dsn, host, database: parsed.pathname.replace(/^\//, '') || 'postgres', write: allowWrite };
}

export function describeTarget(target) {
  return `${target.host}/${target.database} (${target.write ? 'write' : 'read-only'})`;
}
