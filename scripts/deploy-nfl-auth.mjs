#!/usr/bin/env node
// Upload propbetedge-nfl-auth ONLY from committed, pushed source, tagged with the git commit.
//
//   node scripts/deploy-nfl-auth.mjs            -> checks + `wrangler versions upload` (preview URL, NOT live)
//   then canary the preview, then promote:       npx wrangler versions deploy <version-id>@100% -y   (from workers/nfl-auth)
//   then append the receipt line this script prints to workers/nfl-auth/DEPLOYMENTS.md and commit it.
//
// Refuses to run when the Worker's inputs have uncommitted changes or HEAD is not on origin/main,
// so production can never again run code that exists only on someone's disk.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = ['workers/nfl-auth', 'api/_nfl-entitlement-ledger.js', 'api/_nfl-entitlement.js'];
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const fail = (m) => { console.error(`[deploy-nfl-auth] REFUSED: ${m}`); process.exit(1); };

const dirty = git('status', '--porcelain', '--', ...INPUTS);
if (dirty) fail(`uncommitted changes in the Worker's inputs:\n${dirty}`);
git('fetch', '-q', 'origin', 'main');
const head = git('rev-parse', 'HEAD');
try { git('merge-base', '--is-ancestor', head, 'origin/main'); } catch { fail(`HEAD ${head.slice(0, 7)} is not on origin/main; push first`); }

const short = head.slice(0, 7);
const message = `git ${short} (${git('log', '-1', '--format=%s').slice(0, 80)})`;
// On Windows npx is a .cmd shim and needs a shell; quote every argument so the message stays one argument.
const args = ['wrangler', 'versions', 'upload', '--tag', short, '--message', message.replace(/["%^&|<>]/g, '')];
const win = process.platform === 'win32';
const up = spawnSync('npx', win ? args.map((a) => `"${a}"`) : args, {
  cwd: path.join(ROOT, 'workers/nfl-auth'), encoding: 'utf8', shell: win,
});
process.stdout.write(up.stdout || ''); process.stderr.write(up.stderr || '');
if (up.status !== 0) fail('wrangler versions upload failed');
const id = (up.stdout.match(/Worker Version ID:\s*([0-9a-f-]{36})/) || [])[1] || '<version-id>';
console.log(`\n[deploy-nfl-auth] uploaded ${id} from ${short}. Canary the preview URL, then promote:`);
console.log(`  (cd workers/nfl-auth && npx wrangler versions deploy ${id}@100% --message "git ${short}" -y)`);
console.log(`receipt: | ${new Date().toISOString()} | ${short} | ${id} | <rollback-version> |`);
