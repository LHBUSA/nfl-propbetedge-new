/* Frontend half of NFL access unlock: the site loads for every visitor at
 * once, and the page only mirrors the server's verdict for premium modules.
 * Nothing the page can be told locally grants premium data — the server
 * refuses it (tests/nfl-paywall-entitlement.test.mjs). */
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
  const walls = [];
  const window = {
    PBEPro: { state: initialState, setWall(on) { walls.push(on); } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent() { return true; },
  };
  const document = {
    documentElement: html,
    body: { appendChild(node) { appended.push(node); } },
    createElement() { return { dataset: {} }; },
  };
  vm.runInNewContext(GATE, { window, document, location: { reload() { reloads += 1; } }, CustomEvent: class { constructor(t) { this.type = t; } } });
  return {
    html, appended, walls,
    get reloads() { return reloads; },
    set(state) { window.PBEPro.state = state; (listeners['pbe:pro-state'] || []).forEach(fn => fn()); },
  };
}
const user = { email: 'x@propbetedge.test' };

test('the whole site loads immediately for every visitor, before the session check answers', () => {
  const h = harness({ loading: true });
  assert.equal(h.html.dataset.pbeAccess, 'checking');
  const srcs = h.appended.map(s => s.src.split('?')[0]);
  assert.equal(srcs[0], './app-core-v3.js');
  assert.equal(srcs.at(-1), './page-loader.js');
  assert.ok(h.appended.every(s => s.async === false), 'executed in order');
});

test('no verdict ever walls the site or reloads it', () => {
  const h = harness({ loading: true });
  for (const state of [
    { loading: false, access: 'anonymous', pro: false, user: null },
    { loading: false, access: 'no_entitlement', pro: false, user },
    { loading: false, access: 'unavailable', pro: false, user },
    { loading: false, access: 'granted', pro: true, user },
    { loading: false, access: 'anonymous', pro: false, user: null },
  ]) {
    h.set(state);
    assert.equal(h.html.dataset.pbeAccess, state.access);
  }
  assert.deepEqual(h.walls, [], 'setWall is never called');
  assert.equal(h.reloads, 0);
  assert.equal(h.appended.length, 13, 'workspace requested once');
});

test('an unknown or inconsistent verdict is published as unavailable, never granted', () => {
  for (const state of [
    { loading: false, access: 'pro', pro: true, user },
    { loading: false, access: 'granted', pro: false, user },
    { loading: false, access: 'granted', pro: true, user: null },
    { loading: false, pro: true, user, subscribed: true },
  ]) {
    const h = harness({ loading: true });
    h.set(state);
    assert.equal(h.html.dataset.pbeAccess, 'unavailable', JSON.stringify(state));
  }
});

test('index.html shows the site to everyone: no access CSS lock, no checking overlay', () => {
  const scripts = [...INDEX.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
  assert.deepEqual(scripts, ['./paywall.js', './paywall-funnel-v2.js', './nfl-access-gate-v1.js']);
  assert.equal(/html:not\(\[data-pbe-access="granted"\]\)/.test(INDEX), false, 'no chrome is hidden until granted');
  assert.equal(INDEX.includes('pbe-access-checking'), false);
  const gateList = [...GATE.matchAll(/'(\.\/[^']+\.js)\?v=[^']+'/g)].map(m => m[1]);
  for (const f of ['./app-core-v3.js', './ui-v2.js', './prop-board-v3.js', './model-lab.js', './page-loader.js']) assert.ok(gateList.includes(f), f);
  assert.equal(/paywall-funnel-v2\.js/.test(LOADER.slice(0, LOADER.indexOf('TERMINAL_AUTHORITIES'))), false, 'the funnel is not double-loaded by page-loader');
});

test('paywall.js: Pro comes only from the server verdict and fails closed', () => {
  assert.match(PAYWALL, /const access = ACCESS_STATES\.has\(payload\?\.access\) \? payload\.access : 'unavailable';/);
  assert.match(PAYWALL, /state\.access = access === 'granted' && !\(payload\?\.valid && payload\?\.pro === true\) \? 'unavailable' : access;/);
  assert.match(PAYWALL, /state\.pro = state\.access === 'granted';/);
  const failure = PAYWALL.slice(PAYWALL.indexOf("state.error = error?.message || 'Session service unavailable.';"));
  assert.match(failure.slice(0, 400), /state\.access = 'unavailable';\s+state\.pro = false;/);
  assert.equal(/localStorage[^\n]*(pro|access|subscri|owner|role)/i.test(PAYWALL), false, 'no client storage decides access');
});

test('paywall.js: checkout return shows a confirming state long enough for the webhook, and never asks to pay again', () => {
  const sync = PAYWALL.slice(PAYWALL.indexOf('async function syncCheckoutSuccess()'), PAYWALL.indexOf('async function init()'));
  assert.match(sync, /Confirming your NFL Pro access/);
  assert.match(sync, /Date\.now\(\) \+ 60000/);
  assert.match(sync, /you will not be charged again/);
  assert.match(sync, /access link we emailed to your checkout address/);
});

test('paywall.js routes every gateway read through the same-origin route', () => {
  assert.match(PAYWALL, /inputUrl\.startsWith\(`\$\{GATEWAY_ORIGIN\}\/`\)/);
  assert.match(PAYWALL, /target = \[`\/api\/gw\$\{parsed\.pathname\}\$\{parsed\.search\}`, sameOriginInit\(init, input\)\];/);
  const vercel = JSON.parse(read('vercel.json'));
  assert.deepEqual(vercel.rewrites, [{ source: '/api/gw/:path*', destination: '/api/gw?__gw_path=:path*' }]);
});
