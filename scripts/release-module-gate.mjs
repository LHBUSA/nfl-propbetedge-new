/* RELEASE MODULE GATE
 *
 *   node scripts/release-module-gate.mjs [candidateRef] [baselineRef]
 *
 * Refuses a production release whose tree has LOST work that the last shipped
 * release contained. This exists because of the Sep 7 2026 rollback: a one-file
 * UFC footer commit was pushed to a stale `main`, Vercel auto-deployed `main` to
 * production, and the entire Player DNA implementation silently vanished from
 * nfl.propbetedge.ai. Nothing failed — the build was green, because "green"
 * only ever meant "this tree compiles", never "this tree is not a regression".
 *
 * The gate judges the candidate against a baseline (the authoritative release
 * lineage) on three counts:
 *
 *   1. REQUIRED MODULES — the load-bearing Player DNA entrypoints must exist in
 *      the candidate tree. These are named explicitly so the failure message
 *      says what is missing, not just "N files changed".
 *   2. NO DISAPPEARANCE — no file the baseline shipped may be absent from the
 *      candidate. Deleting a file is legitimate work, so a delete is allowed
 *      only when the commit that removed it is in the candidate's own history;
 *      a file that is absent merely because the candidate never had that commit
 *      is a rollback, and fails.
 *   3. ANCESTRY — the baseline commit must be reachable from the candidate.
 *      A candidate that does not contain the last release is, by definition,
 *      a divergent lineage; shipping it moves production backwards.
 *
 * Baseline resolution, first hit wins:
 *   argv[2] · $RELEASE_BASELINE_REF · release/last-production.json · origin/prototype/nfl-data-harvest
 *
 * Exit 0 = safe to release. Exit 1 = the candidate would drop shipped work.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const REQUIRED_MODULES = [
  'qb-dna-v2.js',
  'rb-dna-v1.js',
  'wr-dna-v1.js',
  'te-dna-v1.js',
  'player-dna-shared.js',
];

/* Trees under which a vanished file is always a release regression, never a
 * tidy-up. Everything else is reported but judged by the delete-provenance
 * rule in check 2. */
const PROTECTED_PREFIXES = ['api/', 'workers/', 'scripts/'];

const CANDIDATE = process.argv[2] || 'HEAD';
const BASELINE = process.argv[3] || process.env.RELEASE_BASELINE_REF || readPinnedBaseline() || 'origin/prototype/nfl-data-harvest';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
function gitOk(...args) {
  try { git(...args); return true; } catch { return false; }
}
function readPinnedBaseline() {
  if (!existsSync('release/last-production.json')) return null;
  try {
    const pin = JSON.parse(readFileSync('release/last-production.json', 'utf8'));
    return pin.sha || pin.ref || null;
  } catch { return null; }
}
function treeFiles(ref) {
  return new Set(git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean));
}

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}

const candidateSha = git('rev-parse', CANDIDATE);
const baselineSha = git('rev-parse', BASELINE);
console.log(`RELEASE MODULE GATE`);
console.log(`  candidate ${CANDIDATE} = ${candidateSha.slice(0, 10)}`);
console.log(`  baseline  ${BASELINE} = ${baselineSha.slice(0, 10)}\n`);

if (candidateSha === baselineSha) {
  console.log('Candidate is the baseline; nothing to compare.\nCLEAN');
  process.exit(0);
}

const candidateFiles = treeFiles(candidateSha);
const baselineFiles = treeFiles(baselineSha);

/* 1 — required modules ---------------------------------------------------- */
console.log('[1] required release modules');
const missingRequired = REQUIRED_MODULES.filter((f) => !candidateFiles.has(f));
check(
  `all ${REQUIRED_MODULES.length} Player DNA entrypoints present`,
  missingRequired.length === 0,
  missingRequired.length ? `vanished: ${missingRequired.join(', ')}` : '',
);

/* 2 — no disappearance ---------------------------------------------------- */
console.log('\n[2] files shipped by the baseline that the candidate no longer has');
const vanished = [...baselineFiles].filter((f) => !candidateFiles.has(f)).sort();
/* A delete is intentional only if the candidate's history contains the commit
 * that performed it. `git log <candidate> -- <path>` walking to a deletion the
 * candidate itself made is the signal; no history at all means the candidate
 * simply predates the file. */
const unexplained = vanished.filter((f) => {
  const touched = gitOk('rev-list', '-1', candidateSha, '--', f) && git('rev-list', '-1', candidateSha, '--', f) !== '';
  return !touched;
});
const protectedLoss = unexplained.filter((f) => PROTECTED_PREFIXES.some((p) => f.startsWith(p)));
check(
  'no baseline file is absent without a delete in the candidate history',
  unexplained.length === 0,
  unexplained.length ? `${unexplained.length} file(s) rolled back, e.g. ${unexplained.slice(0, 8).join(', ')}` : '',
);
check(
  'no protected api/ workers/ scripts/ module rolled back',
  protectedLoss.length === 0,
  protectedLoss.length ? `${protectedLoss.length} protected path(s), e.g. ${protectedLoss.slice(0, 8).join(', ')}` : '',
);

/* 3 — ancestry ------------------------------------------------------------ */
console.log('\n[3] release ancestry');
const contains = gitOk('merge-base', '--is-ancestor', baselineSha, candidateSha);
let divergence = '';
if (!contains) {
  const [behind, ahead] = git('rev-list', '--left-right', '--count', `${baselineSha}...${candidateSha}`).split(/\s+/);
  divergence = `candidate is ${ahead} ahead / ${behind} behind the baseline; merge-base ${git('merge-base', baselineSha, candidateSha).slice(0, 10)}`;
}
check('candidate contains the last shipped release commit', contains, divergence);

console.log(`\n${failures ? `${failures} FAILURE(S) — this candidate would move production backwards. Do not release.` : 'CLEAN — candidate contains everything the last release shipped.'}`);
process.exit(failures ? 1 : 0);
