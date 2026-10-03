/* PBEcast game deep link: https://nfl.propbetedge.ai/#pbecast?game=<ESPN id>
 *
 * The real app core, game handoff and PBEcast v6 run together in a vm against
 * a minimal browser (location/history/storage/fetch). Asserted:
 *   - the URL id becomes the explicit selection through takeFocus, exactly as
 *     PBEGameHandoff.open(id,{source:'deeplink'}) would make it;
 *   - ?game= in the query string is accepted too;
 *   - consumed once: a replayed mount never overrides a later user selection;
 *   - in-app selection writes #pbecast?game=<id>; default mode writes nothing;
 *   - a malformed id is ignored and dropped from the URL;
 *   - an id the source does not know (upstream 404) reverts to plain #pbecast
 *     with no unavailable state;
 *   - a hash query belongs to its own route: navigating to What Changed does
 *     not carry ?game= along.
 *
 *   node --test tests/pbecast-game-deeplink.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SRC = { core: read('app-core-v3.js'), handoff: read('pbe-game-handoff-v1.js'), v6: read('pbecast-v6.js') };

const KNOWN = { '401872965': '2026-10-04T13:30Z', '401872966': '2026-10-04T17:00Z', '401872970': '2026-10-04T20:25Z' };
const tick = () => new Promise(r => setImmediate(r));

function browser(startUrl) {
  let url = new URL(startUrl);
  const listeners = {};
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; };
  const location = {
    get href() { return url.href; }, get hash() { return url.hash; }, get search() { return url.search; },
    get origin() { return url.origin; }, get pathname() { return url.pathname; },
    set hash(v) { const next = new URL(url.href); next.hash = v; go(next.href); }
  };
  const fire = (name, ev = {}) => (listeners[name] || []).slice().forEach(fn => fn(ev));
  function go(href) { const before = url.hash; url = new URL(href, url.href); if (url.hash !== before) fire('hashchange'); }
  const root = { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, querySelector: () => null, querySelectorAll: () => [], contains: () => false, setAttribute() {}, getAttribute: () => null };
  const dom = { mounted: false };
  const document = {
    visibilityState: 'visible', activeElement: null,
    querySelector: sel => (dom.mounted && /pbecast6/.test(sel) ? root : null),
    querySelectorAll: () => [], getElementById: () => null,
    addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }
  };
  const fetched = [];
  async function fetch(u) {
    const req = new URL(String(u), 'https://nfl.propbetedge.ai');
    fetched.push(req.pathname + req.search);
    const ev = req.searchParams.get('event');
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    if (req.pathname === '/api/nfl-live' && ev) {
      if (!KNOWN[ev]) return res(503, { ok: false, error: 'nfl_live_unavailable', detail: `espn_site_summary:upstream_404:{"code":404} | espn_cdn_gamepackage:upstream_non_json`, semantics: 'UNAVAILABLE' });
      return res(200, { ok: true, source: { semantics: 'SCHEDULE' }, game: { id: ev, date: KNOWN[ev], status: { semantics: 'SCHEDULE' }, teams: { away: {}, home: {} } } });
    }
    if (req.pathname === '/api/nfl-live') return res(200, { games: Object.entries(KNOWN).map(([id, date]) => ({ id, date, status: { semantics: 'SCHEDULE' }, teams: { away: {}, home: {} } })) });
    return res(200, {});
  }
  const win = {
    location, document, fetch, console, URL, URLSearchParams, JSON, Date, Math, Promise, Map, Set, Proxy, Object, Array, String, Number, Error, RegExp, Symbol,
    sessionStorage: store(), localStorage: store(),
    history: { state: null, replaceState(state, _t, href) { this.state = state; url = new URL(href, url.href); } },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    queueMicrotask, scrollTo() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }, removeEventListener() {},
    dispatchEvent(ev) { fire(ev.type, ev); return true; },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    AbortController, navigator: { userAgent: 'node' }
  };
  win.window = win; win.self = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  vm.runInContext(SRC.core, ctx);
  vm.runInContext(SRC.handoff, ctx);
  vm.runInContext(SRC.v6, ctx);
  /* the real router path: App.nav renders the registered PBEcast view */
  const navTo = route => { win.App.nav(route); if (route === 'pbecast') dom.mounted = true; else dom.mounted = false; };
  /* a cold load / replayed mount of the route without rewriting the URL */
  const mount = async () => { dom.mounted = true; win.App.nav('pbecast', { history: false }); await tick(); await tick(); };
  const pasteHash = h => go(new URL(h, url.href).href);
  return { win, dom, fetched, mount, navTo, pasteHash, get href() { return url.href; }, get hash() { return url.hash; }, cast: () => win.PBEcastV6 };
}

test('#pbecast?game=<id> opens that game as an explicit selection and keeps the link', async () => {
  const b = browser('https://nfl.propbetedge.ai/#pbecast?game=401872966');
  await b.mount();
  const s = b.cast().state;
  assert.equal(s.activeId, '401872966');
  assert.equal(s.explicit, true);
  assert.equal(b.hash, '#pbecast?game=401872966', 'the address bar stays a shareable link to the open game');
  assert.equal(JSON.parse(b.win.sessionStorage.getItem('pbe.pbecast.selected')).game_id, '401872966', 'same persistence as a handoff');
  assert.equal(s.unavailable, null);
  assert.equal(s.detail?.game?.id, '401872966');
});

test('?game= in the query string is accepted and folded into the hash link', async () => {
  const b = browser('https://nfl.propbetedge.ai/?game=401872970#pbecast');
  await b.mount();
  assert.equal(b.cast().state.activeId, '401872970');
  assert.equal(b.href, 'https://nfl.propbetedge.ai/#pbecast?game=401872970');
});

test('consumed once: a replayed mount does not override a later rail selection, and the URL follows it', async () => {
  const b = browser('https://nfl.propbetedge.ai/#pbecast?game=401872966');
  await b.mount();
  await b.cast().focus('401872970');
  assert.equal(b.hash, '#pbecast?game=401872970', 'an in-app selection is reflected in the URL');
  await b.mount();                                     // App.replayCurrent / loader replay
  assert.equal(b.cast().state.activeId, '401872970');
  /* leaving and coming back restores the session selection, and the URL carries it again */
  b.navTo('games');
  assert.equal(b.hash, '#games');
  b.navTo('pbecast'); await tick(); await tick();
  assert.equal(b.cast().state.activeId, '401872970');
  assert.equal(b.hash, '#pbecast?game=401872970');
});

test('the handoff still wins and goes through the same path', async () => {
  const b = browser('https://nfl.propbetedge.ai/#games');
  b.win.PBEGameHandoff.open('401872965', { source: 'games' });
  b.dom.mounted = true; await tick(); await tick();
  assert.equal(b.cast().state.activeId, '401872965');
  assert.equal(b.cast().state.explicit, true);
  assert.equal(b.hash, '#pbecast?game=401872965');
});

test('plain #pbecast is default mode: no URL rewrite, no explicit selection', async () => {
  const b = browser('https://nfl.propbetedge.ai/#pbecast');
  await b.mount();
  const s = b.cast().state;
  assert.equal(s.explicit, false);
  assert.ok(s.activeId, 'default mode still chooses a game');
  assert.equal(b.hash, '#pbecast');
});

test('a malformed id is ignored and dropped from the URL', async () => {
  for (const bad of ['abc', '12345', '4018729651234', '401872965x']) {
    const b = browser(`https://nfl.propbetedge.ai/#pbecast?game=${bad}`);
    await b.mount();
    assert.equal(b.cast().state.explicit, false, bad);
    assert.equal(b.hash, '#pbecast', bad);
  }
});

test('an unknown id falls back to plain #pbecast behaviour with no unavailable state', async () => {
  const b = browser('https://nfl.propbetedge.ai/#pbecast?game=401999999');
  await b.mount(); await tick(); await tick();
  const s = b.cast().state;
  assert.notEqual(s.activeId, '401999999');
  assert.equal(s.explicit, false);
  assert.equal(s.unavailable, null);
  assert.equal(b.hash, '#pbecast');
  assert.equal(b.win.sessionStorage.getItem('pbe.pbecast.selected'), null, 'nothing persisted for an unknown game');
  assert.equal(b.win.localStorage.getItem('pbe_nfl_cast_active_v6'), null);
  await b.mount();
  assert.notEqual(b.cast().state.activeId, '401999999', 'not retried on a replay');
});

test('an unknown id restores a selection the reader already had', async () => {
  const b = browser('https://nfl.propbetedge.ai/#pbecast');
  b.win.sessionStorage.setItem('pbe.pbecast.selected', JSON.stringify({ game_id: '401872965', kickoff: null }));
  b.pasteHash('#pbecast?game=401999999');
  await b.mount(); await tick(); await tick();
  assert.equal(b.cast().state.activeId, '401872965');
  assert.equal(b.cast().state.explicit, true);
  assert.equal(b.hash, '#pbecast?game=401872965');
});

test('a deep link pasted into a tab already on PBEcast opens it via PBEGameHandoff', async () => {
  const b = browser('https://nfl.propbetedge.ai/#pbecast?game=401872966');
  await b.mount();
  b.pasteHash('#pbecast?game=401872970'); await tick(); await tick();
  assert.equal(b.cast().state.activeId, '401872970');
  assert.equal(b.hash, '#pbecast?game=401872970');
});

test('a hash query belongs to its route: ?game= does not follow the reader to What Changed', () => {
  const b = browser('https://nfl.propbetedge.ai/#pbecast?game=401872966');
  assert.equal(b.win.App.params.game, '401872966', 'the opened route reads its own params');
  b.win.App.nav('changes');
  assert.equal(b.win.App.params.game, undefined);
  /* a query-string param is document-wide, as before */
  const c = browser('https://nfl.propbetedge.ai/?event=abc#pbecast');
  c.win.App.nav('bestline');
  assert.equal(c.win.App.params.event, 'abc');
});
