/* Public surfaces may only state history that carries provenance.
 *
 * These tests run the REAL renderers against the REAL archive datasets in a VM
 * and assert that the unprovenanced claims cannot reach the page, that the
 * provenanced 2025 datasets still do, and that a renderer which cannot see the
 * guard suppresses itself rather than publishing.
 *
 *   node --test tests/nfl-history-provenance.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const repo = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, repo), 'utf8');

/* A DOM stub just large enough for these renderers: they set innerHTML on
   #view-container and then query for controls to wire. */
function domContext({ withGuard = true } = {}) {
  const view = { id: 'view-container', innerHTML: '', querySelectorAll: () => [], addEventListener() {} };
  const noop = { addEventListener() {}, querySelectorAll: () => [], innerHTML: '', classList: { add() {}, remove() {}, contains: () => false } };
  const document = {
    getElementById: id => (id === 'view-container' ? view : null),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    createElement: () => ({ ...noop, style: {}, dataset: {}, appendChild() {} }),
    body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
  };
  const window = { document, addEventListener() {}, App: { VIEWS: {} }, requestAnimationFrame: fn => fn() };
  window.window = window;
  const ctx = vm.createContext({ window, document, console, setTimeout, clearTimeout, requestAnimationFrame: fn => fn(), App: window.App });
  vm.runInContext(read('archive/utils.js'), ctx);
  vm.runInContext(read('archive/teams.js'), ctx);
  vm.runInContext(read('archive/superbowls.js'), ctx);
  vm.runInContext(read('archive/hof.js'), ctx);
  vm.runInContext(read('archive/seasons.js'), ctx);
  vm.runInContext(read('archive/records.js'), ctx);
  vm.runInContext(read('archive/stats-2025.js'), ctx);
  vm.runInContext(read('archive/standings-2025.js'), ctx);
  /* the classic archive scripts use top-level const; mirror to window the way
     team-globals-v1.js does in the browser */
  vm.runInContext(`window.SUPER_BOWLS=typeof SUPER_BOWLS!=='undefined'?SUPER_BOWLS:undefined;
    window.HOF_MEMBERS=typeof HOF_MEMBERS!=='undefined'?HOF_MEMBERS:undefined;
    window.NFL_SEASONS=typeof NFL_SEASONS!=='undefined'?NFL_SEASONS:undefined;
    window.MVP_HISTORY=typeof MVP_HISTORY!=='undefined'?MVP_HISTORY:undefined;
    window.NFL_RECORDS=typeof NFL_RECORDS!=='undefined'?NFL_RECORDS:undefined;
    window.NFL_TEAMS=typeof NFL_TEAMS!=='undefined'?NFL_TEAMS:undefined;`, ctx);
  if (withGuard) vm.runInContext(read('history-provenance-v1.js'), ctx);
  return { ctx, view };
}

function renderRoute(file, globalName, { withGuard = true } = {}) {
  const { ctx, view } = domContext({ withGuard });
  vm.runInContext(read(file), ctx);
  const api = vm.runInContext(`window.${globalName}`, ctx);
  api.render();
  return view.innerHTML;
}

const ROUTES = [
  ['super-bowls-v2.js', 'PBESuperBowlsV2', 'pbe11-sb'],
  ['records-v2.js', 'PBERecordsV2', 'pbe10-records'],
  ['season-archive-v2.js', 'PBESeasonArchiveV2', 'pbe8-archive'],
];

/* Claims measured in the archive datasets that must not reach a public page.
   The Hall of Fame row is provably false: Wikidata records no Pro Football Hall
   of Fame induction for that player, and the file files him under a class
   header for a different year. */
const MUST_NOT_APPEAR = [
  'Kenneth Walker III',          // unverified Super Bowl LX MVP/score/notes
  'Dark Side defense',           // narrative prose stored as a record
  'Bill Belichick will likely',  // speculation stored as a record annotation
  'LATEST ARCHIVED CHAMPIONSHIP',
  'Dynasty Board',
  'Latest induction class',
];

for (const [file, globalName, rootClass] of ROUTES) {
  test(`${file}: publishes a provenance notice instead of the unprovenanced archive`, () => {
    const html = renderRoute(file, globalName);
    assert.match(html, new RegExp(rootClass), 'keeps the route shell and its CSS classes');
    assert.match(html, /re-sourc/i, 'says why it is empty');
    assert.ok(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length >= 120, 'route gates require >= 120 characters of copy');
    for (const claim of MUST_NOT_APPEAR) assert.equal(html.includes(claim), false, `${file} leaked: ${claim}`);
  });

  test(`${file}: fails closed when the guard is absent`, () => {
    const html = renderRoute(file, globalName, { withGuard: false });
    for (const claim of MUST_NOT_APPEAR) assert.equal(html.includes(claim), false, `${file} published ${claim} without the guard`);
    assert.match(html, /provenance/i);
  });
}

test('the guard suppresses the unprovenanced keys and publishes the verified 2025 datasets', () => {
  const { ctx } = domContext();
  const guard = vm.runInContext('window.PBEHistoryProvenance', ctx);
  for (const key of ['superbowls', 'records', 'seasons', 'franchise_history', 'player_archive']) {
    assert.equal(guard.isSuppressed(key), true, key);
  }
  for (const key of ['hof', 'standings2025', 'stats2025']) assert.equal(guard.isSuppressed(key), false, key);
  assert.equal(guard.isSuppressed('a_key_nobody_registered'), true, 'unknown keys fail closed');
});

test('Hall of Fame is restored only through the rights-clean sourced endpoint', () => {
  const hof = read('hof-v2.js');
  const api = read('api/hof-history.js');
  assert.match(hof, /\/api\/hof-history/, 'Hall UI reads the sourced endpoint');
  assert.equal(hof.includes('HOF_MEMBERS'), false, 'legacy unprovenanced Hall data has no route authority');
  const hofCode = hof.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(hofCode.includes('archive/hof.js'), false, 'renderer never reads the legacy archive');
  assert.match(api, /P6930/, 'endpoint keys membership to the PFHOF identifier');
  assert.match(api, /CC0-1\.0/, 'endpoint declares the approved Wikidata licence');
  assert.equal(api.includes('archive/hof.js'), true, 'endpoint explicitly documents the rejected fallback');
});

test('the verified 2025 archives still carry their provenance block and are untouched', () => {
  for (const [file, symbol] of [['archive/stats-2025.js', 'StatsView'], ['archive/standings-2025.js', 'StandingsView']]) {
    const src = read(file);
    assert.match(src, /provider\s*:\s*'NFL\.com'/, `${file} provider`);
    assert.match(src, /verifiedAt\s*:\s*'2026-08-29'/, `${file} verifiedAt`);
    assert.match(src, /VERIFIED_FINAL/, `${file} semantics`);
    assert.ok(src.includes(symbol));
  }
});

test('the player drawer keeps 2025 verified stats and drops the unprovenanced archives', () => {
  const src = read('player-research-v2.js');
  assert.match(src, /2025 FINAL STATS/, 'the provenanced rows stay');
  for (const global of ['HOF_MEMBERS', 'MVP_HISTORY', 'NFL_RECORDS', 'SUPER_BOWLS', 'NFL_SEASONS']) {
    assert.equal(new RegExp(`window\\.${global}`).test(src), false, `${global} must no longer feed the drawer`);
  }
});

test('the command palette indexes only the provenanced dataset', () => {
  const src = read('command-palette-v3.js');
  const fn = src.slice(src.indexOf('function archivePlayers()'), src.indexOf('function teams()'));
  assert.match(fn, /StatsView/);
  for (const global of ['HOF_MEMBERS', 'MVP_HISTORY', 'NFL_RECORDS', 'SUPER_BOWLS']) {
    assert.equal(fn.includes(global), false, `${global} must not be indexed as fact`);
  }
  assert.equal(src.includes('Hall of Fame · MVPs · record holders'), false, 'context copy updated');
});

test('franchise founding years and championship counts are withheld on team and matchup surfaces', () => {
  const team = read('team-research-v3.js');
  assert.equal(/founded \$\{esc\(t\.founded/.test(team), false, 'founding year withheld');
  assert.equal(team.includes('Franchise Super Bowl wins'), false, 'championship count withheld');
  assert.match(team, /provenance review/i);
  /* Matchups v3 replaced v2. It carries no franchise history at all — the
     unprovenanced 2025/all-time panels were the thing it was built to remove —
     so the assertion is that none of it came back. */
  const matchups = read('matchups-v3.js');
  assert.equal(matchups.includes('Super Bowl wins · franchise'), false);
  /* Comments are stripped: the header deliberately records WHAT v2 showed and
     why it went, and that documentation must not trip the check on the code. */
  const code = matchups.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/2025 Final Context|playoff seed|point differential/i.test(code), false,
    'the retired 2025 panels must not return');
});

test('no hardcoded season-count claim remains on the dashboard', () => {
  assert.equal(read('ui-v2.js').includes('106 SEASONS'), false);
});

test('the guard loads before the surfaces that depend on it', () => {
  const loader = read('page-loader.js');
  const guardAt = loader.indexOf('history-provenance-v1.js');
  assert.ok(guardAt > 0, 'guard is in the loader manifest');
  for (const file of ['super-bowls-v2.js', 'hof-v2.js', 'records-v2.js', 'season-archive-v2.js', 'player-research-v2.js', 'command-palette-v3.js']) {
    assert.ok(guardAt < loader.indexOf(file), `guard must load before ${file}`);
  }
});

test('index.html is unchanged: the archive scripts still load in the same order', () => {
  const scripts = [...read('index.html').matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
  assert.deepEqual(scripts.filter(s => s.startsWith('./archive/')), [
    './archive/utils.js', './archive/teams.js', './archive/superbowls.js', './archive/hof.js',
    './archive/seasons.js', './archive/records.js', './archive/stats-2025.js', './archive/standings-2025.js',
  ]);
});
