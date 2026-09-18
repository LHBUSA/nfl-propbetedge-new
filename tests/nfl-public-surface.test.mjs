/* The public surface of nfl.propbetedge.ai is a deliberate list.
 *
 * The deployment serves the repository as a static root, so every tracked file
 * that .vercelignore does not exclude is readable by anyone. This test
 * classifies EVERY tracked file against the current .vercelignore and fails if
 * an internal engineering artefact would ship, or if anything the product needs
 * would not.
 *
 *   node --test tests/nfl-public-surface.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repo = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, repo), 'utf8');
const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);

/* Minimal gitignore semantics: the subset .vercelignore actually uses —
   directory prefixes, `*` globs inside one path segment, and plain paths. */
function ruleToRegExp(rule) {
  const dir = rule.endsWith('/');
  const body = dir ? rule.slice(0, -1) : rule;
  const escaped = body.split('/').map(seg => seg.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('/');
  return new RegExp(`^${escaped}${dir ? '(/|$)' : '(/|$)'}`);
}
const rules = read('.vercelignore').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const matchers = rules.map(r => ({ rule: r, re: ruleToRegExp(r), anywhere: !r.includes('/') && r.startsWith('*') }));
function excluded(path) {
  for (const m of matchers) {
    if (m.re.test(path)) return m.rule;
    /* a bare pattern such as *.md applies at every level */
    if (m.anywhere && m.re.test(path.split('/').pop())) return m.rule;
  }
  return null;
}

/* ---------------------------------------------------- must never be served */
const INTERNAL_PREFIXES = ['docs/', 'migrations/', 'research/', 'scripts/', 'tests/', '.github/', 'release/', 'history/'];

test('internal engineering artefacts are excluded from the deployment', () => {
  const leaking = tracked.filter(p => INTERNAL_PREFIXES.some(prefix => p.startsWith(prefix)) && !excluded(p));
  assert.deepEqual(leaking, [], `these internal files would be publicly served: ${leaking.slice(0, 12).join(', ')}`);
});

test('worker source, wrangler config and worker tests are excluded; only the shared engine library ships', () => {
  const workerFiles = tracked.filter(p => p.startsWith('workers/'));
  const shipped = workerFiles.filter(p => !excluded(p));
  for (const p of shipped) {
    assert.ok(p.startsWith('workers/nfl-picks-engine-shared/'), `unexpected worker file would ship: ${p}`);
    assert.ok(!p.includes('/tests/'), `worker test would ship: ${p}`);
  }
  /* api/ imports these two at build time, so they must still ship. */
  for (const required of ['workers/nfl-picks-engine-shared/odds-normalize.mjs', 'workers/nfl-picks-engine-shared/publication.mjs', 'workers/nfl-picks-engine-shared/pick-math.mjs']) {
    assert.equal(excluded(required), null, `${required} is imported by api/ and must ship`);
  }
  assert.ok(workerFiles.some(p => p.endsWith('wrangler.toml')));
  for (const p of workerFiles.filter(p => p.endsWith('wrangler.toml'))) {
    assert.ok(excluded(p), `${p} carries the Cloudflare account id and must not ship`);
  }
});

test('every worker directory is named in .vercelignore, so a new worker cannot ship by accident', () => {
  const dirs = [...new Set(tracked.filter(p => p.startsWith('workers/')).map(p => p.split('/')[1]))];
  const missing = dirs.filter(d => d !== 'nfl-picks-engine-shared' && !rules.includes(`workers/${d}/`));
  assert.deepEqual(missing, [], `add these to .vercelignore: ${missing.map(d => `workers/${d}/`).join(', ')}`);
});

test('planning and audit markdown does not ship', () => {
  const md = tracked.filter(p => p.endsWith('.md'));
  assert.ok(md.length > 5);
  assert.deepEqual(md.filter(p => !excluded(p)), []);
});

/* ---------------------------------------------------- must always be served */
const REQUIRED = [
  'index.html', 'site.webmanifest',
  'app-core-v3.js', 'page-loader.js', 'paywall.js', 'ui-v2.js', 'prop-board-v3.js', 'model-lab.js',
  'pbe-tokens.css', 'pbe-system.css', 'base-v3.css', 'ui-v2.css', 'paywall.css',
  'archive/utils.js', 'archive/teams.js', 'archive/superbowls.js', 'archive/hof.js',
  'archive/seasons.js', 'archive/records.js', 'archive/stats-2025.js', 'archive/standings-2025.js',
  'stadiums/sofi-bg.webp', 'stadiums/lambeau-thumb.webp',
  /* the six datasets api/* reads from the deployment filesystem at runtime */
  'data/dist/nfl-venues.json', 'data/dist/career-ledger.json', 'data/dist/qb-dna-dataset.json',
  'data/dist/rb-dna-dataset.json', 'data/dist/wr-dna-dataset.json', 'data/dist/te-dna-dataset.json',
];

test('everything the product serves or reads at runtime still ships', () => {
  for (const path of REQUIRED) {
    assert.ok(tracked.includes(path), `${path} is not tracked`);
    assert.equal(excluded(path), null, `${path} must ship but is excluded by ${excluded(path)}`);
  }
});

test('every script and stylesheet index.html references still ships', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"?]+)/g)].map(m => m[1]);
  assert.ok(refs.length > 15);
  for (const ref of refs) assert.equal(excluded(ref), null, `index.html loads ${ref}, which would not ship`);
});

test('every module page-loader.js lazy-loads still ships', () => {
  const loader = read('page-loader.js');
  const refs = [...loader.matchAll(/'\.\/([^']+\.(?:js|css))'/g)].map(m => m[1]);
  assert.ok(refs.length > 100, `expected the full manifest, found ${refs.length}`);
  const missing = refs.filter(r => tracked.includes(r) && excluded(r));
  assert.deepEqual(missing, []);
});

test('api/ function source is never exposed as a static file', () => {
  /* Vercel serves api/* as functions, not static files; this pins the reason
     they are safe so a future change to that assumption is noticed. */
  const apiFiles = tracked.filter(p => p.startsWith('api/') && p.endsWith('.js'));
  assert.ok(apiFiles.length > 20);
  assert.ok(apiFiles.every(p => !p.endsWith('.map')), 'no source maps in api/');
});
