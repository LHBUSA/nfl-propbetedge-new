/* PBE Card client store: a failed read must not be retried by its own repaint.
 *
 * Measured on a Vercel preview without the Supabase secret: /api/pbe-picks
 * answered 503 picks_backend_unavailable and the dashboard issued ~87 requests
 * in seven seconds, because every render calls ensure() and every failed read
 * emitted pbe:card-ready, which re-rendered. The real pbe-card-v3.js runs here
 * in a VM with a minimal window/document and a counting fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../pbe-card-v3.js', import.meta.url), 'utf8');
const UNAVAILABLE = { status: 503, body: { error: 'picks_backend_unavailable', stage: 'service_secret_missing' } };
const PREVIEW = { status: 200, body: { contract: 'pbe-card-v3', display_mode: 'VALIDATION', previews: [], summary: {} } };

function harness({ responses, pro = false }) {
  let now = Date.parse('2026-09-13T18:00:00Z');
  const calls = [];
  const listeners = new Map();
  const doc = { visibilityState: 'visible', addEventListener() {}, querySelectorAll: () => [], querySelector: () => null };
  const win = {
    PBEPro: { state: { pro } },
    addEventListener: (type, fn) => { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
    dispatchEvent: ev => { for (const fn of listeners.get(ev.type) || []) fn(ev); return true; }
  };
  const fetch = async url => {
    calls.push(String(url));
    const r = typeof responses === 'function' ? responses(String(url), calls.length) : responses;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  const ctx = { window: win, document: doc, fetch, Response, CustomEvent, Date: class extends Date { static now() { return now; } }, console, setTimeout, clearTimeout, Promise, JSON, Math, Number, String, Array, Object, Set, Map, URL, Intl };
  vm.runInNewContext(SRC, ctx);
  const card = win.PBECard;
  /* A surface that renders from the store and re-renders on every card-ready,
     exactly the pattern that made the loop. */
  let renders = 0;
  win.addEventListener('pbe:card-ready', () => { renders++; if (renders < 500) card.ensure(); });
  return { card, calls, doc, win, advance: ms => { now += ms; }, renders: () => renders };
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('backend unavailable: repaints and concurrent callers produce one request, not a storm', async () => {
  const h = harness({ responses: UNAVAILABLE });
  await Promise.all(Array.from({ length: 25 }, () => h.card.ensure()));
  for (let i = 0; i < 40; i++) { h.card.ensure(); h.card.ensure(true); }
  await settle();
  assert.equal(h.calls.length, 1, `requests: ${h.calls.length}`);
  assert.equal(h.card.store.failure.status, 503);
  assert.equal(h.card.store.failure.error, 'picks_backend_unavailable');
  assert.equal(h.card.store.failure.retryAt - h.card.store.failure.at, 300000, 'a known backend-unavailable answer waits the longest');
  assert.equal(h.card.store.error, 'picks_backend_unavailable', 'the failure is shown, not hidden');
});

test('after the back-off one retry is allowed, and recovery clears the failure', async () => {
  let up = false;
  const h = harness({ responses: () => (up ? PREVIEW : UNAVAILABLE) });
  await h.card.ensure(); await settle();
  assert.equal(h.calls.length, 1);
  h.advance(299000); h.card.ensure(); await settle();
  assert.equal(h.calls.length, 1, 'still inside the back-off');
  up = true;
  h.advance(2000); await h.card.ensure(); await settle();
  assert.equal(h.calls.length, 2, 'exactly one retry once the back-off expires');
  assert.equal(h.card.store.failure, null);
  assert.equal(h.card.store.error, null);
  assert.equal(h.card.store.data.contract, 'pbe-card-v3');
  for (let i = 0; i < 20; i++) h.card.ensure();
  await settle();
  assert.equal(h.calls.length, 2, 'a healthy store serves from its TTL');
});

test('transient failures back off exponentially up to five minutes', async () => {
  const h = harness({ responses: { status: 502, body: { error: 'upstream' } } });
  const gaps = [];
  for (let i = 0; i < 6; i++) {
    await h.card.ensure(); await settle();
    const f = h.card.store.failure; gaps.push(f.retryAt - f.at);
    h.advance(f.retryAt - f.at + 1);
  }
  assert.deepEqual(gaps, [15000, 30000, 60000, 120000, 240000, 300000]);
  assert.equal(h.calls.length, 6, 'one request per back-off window');
});

test('a hidden tab never retries a failed read; becoming visible allows it again', async () => {
  const h = harness({ responses: UNAVAILABLE });
  await h.card.ensure(); await settle();
  h.doc.visibilityState = 'hidden';
  h.advance(3600000);
  for (let i = 0; i < 10; i++) h.card.ensure(true);
  await settle();
  assert.equal(h.calls.length, 1, 'hidden: no retry even long after the back-off');
  h.doc.visibilityState = 'visible';
  await h.card.ensure(); await settle();
  assert.equal(h.calls.length, 2);
});

test('an explicit user retry and an entitlement change skip the wait; nothing else does', async () => {
  const h = harness({ responses: UNAVAILABLE });
  await h.card.ensure(); await settle();
  h.card.ensure(true); await settle();
  assert.equal(h.calls.length, 1, 'force alone is not a user retry');
  await h.card.ensure(true, { userRetry: true }); await settle();
  assert.equal(h.calls.length, 2, 'Retry button');
  h.win.PBEPro.state.pro = true;
  h.win.dispatchEvent({ type: 'pbe:pro-state', detail: { pro: true } });
  await settle();
  assert.ok(h.calls.some(u => u.includes('view=current')), 'entitlement change reads the Pro view at once');
});

test('Pro refused by the server: the preview is shown and the Pro view is not re-asked every repaint', async () => {
  const h = harness({ pro: true, responses: url => (url.includes('view=current') ? { status: 403, body: { error: 'nfl_pro_required' } } : PREVIEW) });
  await h.card.ensure(); await settle();
  for (let i = 0; i < 30; i++) h.card.ensure();
  await settle();
  assert.equal(h.calls.filter(u => u.includes('view=current')).length, 1);
  assert.equal(h.card.store.mode, 'public');
  assert.ok(h.card.store.data);
});

test('the healthy production path is unchanged: one read, served from TTL, no failure state', async () => {
  const h = harness({ responses: PREVIEW });
  await Promise.all([h.card.ensure(), h.card.ensure(), h.card.ensure()]);
  for (let i = 0; i < 20; i++) h.card.ensure();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.card.store.failure, null);
  h.advance(61000); await h.card.ensure(); await settle();
  assert.equal(h.calls.length, 2, 'TTL refresh still happens');
});
