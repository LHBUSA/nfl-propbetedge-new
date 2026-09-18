/* Prove against PRODUCTION that internal engineering artefacts are not served
 * and that the product's own assets still are.
 *
 *   node scripts/public-surface-gate.mjs [--target https://nfl.propbetedge.ai]
 *
 * Exit 1 on any internal path that answers 200, or any required asset that does
 * not. Run after a deployment; .vercelignore is the control, this is the proof.
 */
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const TARGET = String(arg('target', 'https://nfl.propbetedge.ai')).replace(/\/$/, '');
const UA = { 'user-agent': 'pbe-public-surface-gate/1.0', accept: '*/*' };

/* One representative path per internal category, plus the specific files whose
   exposure mattered most: worker source, wrangler config, migrations, rights
   documents, test fixtures. */
const MUST_NOT_SERVE = [
  '/docs/risk/ESPN_PRODUCTION_DEPENDENCY.md',
  '/docs/career-ledger/SOURCE_RIGHTS_AND_RECONCILIATION_AUDIT.md',
  '/migrations/nfl_picks_engine_v1.sql',
  '/research/schema/CANDIDATE_SCHEMA.sql',
  '/research/ingest/weather.py',
  '/scripts/career-ledger/harvest_career_ledger.py',
  '/scripts/public-surface-gate.mjs',
  '/tests/nfl-auth.test.mjs',
  '/tests/fixtures/espn-cdn-scoreboard-2026.json',
  '/.github/workflows/ci.yml',
  '/workers/nfl-auth/src/index-v5.js',
  '/workers/nfl-auth/wrangler.toml',
  '/workers/nfl-gateway/wrangler.toml',
  '/workers/nfl-billing/src/index.js',
  '/workers/nfl-picks-engine-shared/tests/fixtures/odds-real.json',
  '/release/last-production.json',
  '/.css-ownership.json',
  '/RELEASE_CANDIDATE.md',
  '/PROPBETEDGE_DESIGN_SYSTEM.md',
  '/history/docs/PLAN.md',
  '/data/dist/active-qbs-2026.json',
  '/data/dist/media-coverage.json',
];

const MUST_SERVE = [
  '/', '/page-loader.js', '/app-core-v3.js', '/paywall.js', '/ui-v2.js',
  '/pbe-tokens.css', '/base-v3.css', '/site.webmanifest',
  '/archive/teams.js', '/archive/superbowls.js', '/archive/standings-2025.js',
  '/stadiums/sofi-bg.webp',
  '/api/nfl-live', '/api/pbe-picks?view=state', '/api/auth-session',
  /* The function answers 400 without a matchup and 404 for a pairing that is
     not on the slate; either proves it deployed and ran. */
  { path: '/api/home-market', accept: [200, 400] },
];

async function status(path) {
  try {
    const r = await fetch(TARGET + path, { headers: UA, redirect: 'manual' });
    return r.status;
  } catch (error) {
    return `error:${error.message}`;
  }
}

const failures = [];
console.log(`public surface gate against ${TARGET}\n`);
for (const path of MUST_NOT_SERVE) {
  const code = await status(path);
  const ok = code === 404 || code === 403;
  if (!ok) failures.push(`SERVED ${code} ${path}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(code).padEnd(6)} hidden   ${path}`);
}
for (const entry of MUST_SERVE) {
  const path = typeof entry === 'string' ? entry : entry.path;
  const accept = typeof entry === 'string' ? [200, 304] : entry.accept;
  const code = await status(path);
  const ok = accept.includes(code);
  if (!ok) failures.push(`MISSING ${code} ${path}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(code).padEnd(6)} required ${path}`);
}

console.log(`\n${MUST_NOT_SERVE.length + MUST_SERVE.length - failures.length}/${MUST_NOT_SERVE.length + MUST_SERVE.length} checks pass`);
if (failures.length) { console.error('\n' + failures.join('\n')); process.exit(1); }
