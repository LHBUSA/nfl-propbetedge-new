/* PBEcast v6 lane ownership on focus: the real pbecast-v6.js in a sandbox
 * with a controllable fetch and inert timers.
 *
 * Observed on production 2026-09-15: focusing a final game right after mount,
 * while the live game's detail request was still in flight, left the detail
 * lane "busy"; the new game's detail sync re-armed on the 30s off-cadence
 * instead of fetching, and the game package (Game Pulse, PBE Replay) did not
 * arrive for up to 30s.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function sandbox() {
  const calls = [], pending = [], timers = new Map();
  let timerId = 0;
  const hosts = {};
  const root = { dataset: {}, querySelector: sel => (hosts[sel] ||= { dataset: {}, innerHTML: '', scrollTop: 0, textContent: '', classList: { toggle() {} } }), addEventListener() {} };
  const vc = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; }, querySelector: sel => (sel === '.pbecast6' ? root : null) };
  const document = {
    visibilityState: 'visible',
    querySelector: sel => (sel === '.pbecast6' ? root : sel.startsWith('.pbecast6 ') ? root.querySelector(sel.slice(10)) : null),
    querySelectorAll: () => [], getElementById: id => (id === 'view-container' ? vc : null), addEventListener() {}
  };
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const game = (id, sem) => ({ id, status: { semantics: sem, period: 4, clock: '0:00' }, teams: { away: { id: '1', abbreviation: 'AWY', score: 1 }, home: { id: '2', abbreviation: 'HME', score: 2 } }, situation: {} });
  /* every request is held until the test releases it; an abort rejects it */
  const fetch = (url, opts = {}) => new Promise((resolve, reject) => {
    const u = String(url); calls.push(u);
    const entry = { url: u, release: body => resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) }) };
    pending.push(entry);
    opts.signal?.addEventListener?.('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const ctx = {
    console, URL, Intl, Math, JSON, Promise, AbortController, Date, document,
    localStorage: store(), sessionStorage: store(),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, ms); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener() {}, fetch
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../pbecast-v6.js', import.meta.url), 'utf8'), ctx);
  const detailCalls = id => calls.filter(u => u.includes(`event=${id}`) && !u.includes('layer=')).length;
  return { cast: ctx.PBEcastV6, calls, pending, timers, game, detailCalls, root };
}
const flush = () => new Promise(r => setImmediate(r));

test('focusing a game while the previous game\'s detail request is in flight fetches the new game at once', async () => {
  const s = sandbox();
  s.cast.state.activeId = 'LIVE1';
  s.cast.focus('LIVE1'); /* no-op: already active */
  const first = s.cast.focus('OTHER');
  await flush();
  assert.equal(s.detailCalls('OTHER'), 1);
  /* OTHER's detail request is still in flight; the user taps FINAL1 */
  const second = s.cast.focus('FINAL1');
  await flush();
  assert.equal(s.detailCalls('FINAL1'), 1, 'the new game\'s detail request goes out immediately, not after a 30s cadence');
  assert.equal(s.cast.lanes.detail.busy, true, 'the new run owns the lane');
  /* release FINAL1's requests */
  for (const p of s.pending.filter(p => p.url.includes('event=FINAL1'))) {
    const layer = /layer=(\w+)/.exec(p.url)?.[1];
    p.release({ ok: true, layer, source: { semantics: 'FINAL', provider: 'espn_site_summary' }, game: s.game('FINAL1', 'FINAL'), plays: [], drives: [], win_probability: layer ? undefined : [{ play_id: 'x', home_win_percentage: 0.6, tie_percentage: 0 }] });
  }
  await flush(); await flush();
  assert.equal(String(s.cast.state.detail?.game?.id), 'FINAL1');
  assert.equal(s.cast.state.detail.win_probability.length, 1, 'the game package landed');
  void first; void second;
});

test('a retired run settling late cannot release the lane or arm a second timer', async () => {
  const s = sandbox();
  s.cast.focus('A');
  await flush();
  const aDetail = s.pending.find(p => p.url.includes('event=A') && !p.url.includes('layer='));
  s.cast.focus('B');
  await flush();
  const lane = s.cast.lanes.detail;
  const epochB = lane.epoch;
  assert.equal(lane.busy, true);
  /* A's detail response arrives after the abort was requested */
  aDetail.release({ ok: true, source: { semantics: 'LIVE' }, game: s.game('A', 'LIVE'), plays: [], drives: [], win_probability: [] });
  await flush(); await flush();
  assert.equal(lane.epoch, epochB);
  assert.equal(lane.busy, true, 'B\'s run still owns the lane');
  assert.equal(lane.timer, null, 'the retired run armed no timer');
  assert.notEqual(String(s.cast.state.detail?.game?.id || ''), 'A', 'A\'s response never painted');
});
