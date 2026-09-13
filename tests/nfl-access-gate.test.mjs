/* Frontend half of the NFL paywall: the paid workspace is not even requested
 * until the server says `granted`, and nothing the page can be told locally
 * grants it. (The server half — every paid route re-checks — is
 * tests/nfl-paywall-entitlement.test.mjs.) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const GATE = read('nfl-access-gate-v1.js');
const INDEX = read('index.html');
const PAYWALL = read('paywall.js');
const LOADER = read('page-loader.js');

function harness(initialState) {
  const listeners = {};
  const appended = [];
  let reloads = 0;
  const html = { dataset: {} };
  const window = {
    PBEPro: {
      state: initialState,
      walls: [],
      setWall(on) { this.walls.push(on); },
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent() { return true; },
  };
  const document = {
    documentElement: html,
    body: { appendChild(node) { appended.push(node); } },
    createElement() { return { dataset: {} }; },
  };
  const ctx = { window, document, location: { reload() { reloads += 1; } }, CustomEvent: class { constructor(t) { this.type = t; } } };
  vm.runInNewContext(GATE, ctx);
  return {
    html, window, appended,
    get reloads() { return reloads; },
    set(state) { window.PBEPro.state = state; (listeners['pbe:pro-state'] || []).forEach(fn => fn()); },
  };
}
const user = { email: 'x@propbetedge.test' };

test('while the server has not answered, only the checking state exists and nothing loads', () => {
  const h = harness({ loading: true });
  assert.equal(h.html.dataset.pbeAccess, 'checking');
  assert.equal(h.appended.length, 0);
});

test('anonymous, no entitlement and unavailable all show the wall and load no workspace code', () => {
  for (const access of ['anonymous', 'no_entitlement', 'unavailable']) {
    const h = harness({ loading: true });
    h.set({ loading: false, access, pro: false, user: access === 'anonymous' ? null : user });
    assert.equal(h.html.dataset.pbeAccess, access);
    assert.deepEqual(h.window.PBEPro.walls, [true], access);
    assert.equal(h.appended.length, 0, `${access}: no workspace script requested`);
  }
});

test('an unknown or inconsistent verdict is treated as unavailable, never granted', () => {
  for (const state of [
    { loading: false, access: 'pro', pro: true, user },
    { loading: false, access: 'granted', pro: false, user },
    { loading: false, access: 'granted', pro: true, user: null },
    { loading: false, pro: true, user },
    { loading: false, access: undefined, pro: true, user, subscribed: true },
  ]) {
    const h = harness({ loading: true });
    h.set(state);
    assert.equal(h.html.dataset.pbeAccess, 'unavailable', JSON.stringify(state));
    assert.equal(h.appended.length, 0);
  }
});

test('granted loads the workspace once, in order, and lifts the wall', () => {
  const h = harness({ loading: true });
  h.set({ loading: false, access: 'granted', pro: true, user });
  h.set({ loading: false, access: 'granted', pro: true, user });
  assert.equal(h.html.dataset.pbeAccess, 'granted');
  const srcs = h.appended.map(s => s.src.split('?')[0]);
  assert.equal(srcs[0], './app-core-v3.js');
  assert.equal(srcs.at(-1), './page-loader.js');
  assert.ok(srcs.includes('./ui-v2.js') && srcs.includes('./prop-board-v3.js') && srcs.includes('./model-lab.js'));
  assert.equal(new Set(srcs).size, srcs.length, 'requested once');
  assert.ok(h.appended.every(s => s.async === false), 'executed in order');
  assert.deepEqual(h.window.PBEPro.walls, [false]);
});

test('expired / canceled / signed out while the workspace is open tears it down', () => {
  for (const next of [{ access: 'no_entitlement', user }, { access: 'anonymous', user: null }, { access: 'unavailable', user }]) {
    const h = harness({ loading: false, access: 'granted', pro: true, user });
    h.set({ loading: false, pro: false, ...next });
    assert.equal(h.reloads, 1, next.access);
  }
});

test('index.html statically loads no paid workspace code', () => {
  const scripts = [...INDEX.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
  assert.deepEqual(scripts, ['./paywall.js', './paywall-funnel-v2.js', './nfl-access-gate-v1.js']);
  assert.match(INDEX, /<html lang="en" data-pbe-access="checking">/);
  for (const sel of ['#pbe-shell-slot', '#ticker', '.shell', '#mobile-bottom-nav']) {
    assert.ok(INDEX.includes(`html:not([data-pbe-access="granted"]) ${sel}`), `${sel} hidden until granted`);
  }
  const gateList = [...GATE.matchAll(/'(\.\/[^']+\.js)\?v=[^']+'/g)].map(m => m[1]);
  for (const f of ['./app-core-v3.js', './ui-v2.js', './prop-board-v3.js', './model-lab.js', './page-loader.js']) assert.ok(gateList.includes(f), f);
  assert.equal(/paywall-funnel-v2\.js/.test(LOADER.slice(0, LOADER.indexOf('TERMINAL_AUTHORITIES'))), false, 'the funnel is not double-loaded by page-loader');
});

test('paywall.js: access comes only from the server verdict and fails closed', () => {
  assert.match(PAYWALL, /const access = ACCESS_STATES\.has\(payload\?\.access\) \? payload\.access : 'unavailable';/);
  assert.match(PAYWALL, /state\.access = access === 'granted' && !\(payload\?\.valid && payload\?\.pro === true\) \? 'unavailable' : access;/);
  assert.match(PAYWALL, /state\.pro = state\.access === 'granted';/);
  const failure = PAYWALL.slice(PAYWALL.indexOf("state.error = error?.message || 'Session service unavailable.';"));
  assert.match(failure.slice(0, 400), /state\.access = 'unavailable';\s+state\.pro = false;/);
  assert.equal(/localStorage[^\n]*(pro|access|subscri)/i.test(PAYWALL), false, 'no client storage decides access');
  assert.match(PAYWALL, /function close\(\) \{\s+if \(state\.wall\) return;/, 'the wall cannot be dismissed');
});

test('paywall.js routes every gateway read through the same-origin protected route', () => {
  assert.match(PAYWALL, /inputUrl\.startsWith\(`\$\{GATEWAY_ORIGIN\}\/`\)/);
  assert.match(PAYWALL, /target = \[`\/api\/gw\$\{parsed\.pathname\}\$\{parsed\.search\}`, sameOriginInit\(init, input\)\];/);
  assert.match(PAYWALL, /credentials: 'same-origin'/);
  const vercel = JSON.parse(read('vercel.json'));
  assert.deepEqual(vercel.rewrites, [{ source: '/api/gw/:path*', destination: '/api/gw?__gw_path=:path*' }]);
});
