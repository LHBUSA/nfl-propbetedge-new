/* PBEcast selected-game weather: the real pbecast-v6.js, nfl-broadcast-v1.js and
 * nfl-game-context-v1.js, run together in a sandbox with a minimal DOM, a
 * counting fetch and inert timers. The schedule payload is the real
 * nfl-schedule Worker over captured ESPN weeks 1-3; the forecast is the
 * captured nfl-intel snapshot. Nothing here reaches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { observeCdnWeek, mergeObservations, emptySnapshot } from '../workers/nfl-schedule/broadcast-core.js';
import schedule, { resetSnapshotMemo } from '../workers/nfl-schedule/index.js';
import { gameWeatherView } from '../workers/nfl-intel/src/weather.js';

const FIX = JSON.parse(readFileSync(new URL('../tests/fixtures/espn-cdn-venues-2026.json', import.meta.url), 'utf8'));
const WX = JSON.parse(readFileSync(new URL('../tests/fixtures/nfl-intel-wx-snapshot-2026-09-14.json', import.meta.url), 'utf8'));
const AT = '2026-09-14T19:30:00.000Z';
const NOW = Date.parse(AT);
const src = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

async function schedulePayload() {
  const snap = emptySnapshot();
  for (const w of [1, 2, 3]) mergeObservations(snap, observeCdnWeek(FIX[`week${w}`], w).observations, AT);
  resetSnapshotMemo();
  return (await schedule.fetch(new Request('https://nfl-schedule.internal/api/schedule?season=2026'), { NFL_KV: { get: async () => snap } })).json();
}
const SCHEDULE = await schedulePayload();
const espnGame = id => {
  for (const w of [1, 2, 3]) {
    const e = FIX[`week${w}`].content.sbData.events.find(x => x.id === id);
    if (e) {
      const c = e.competitions[0];
      const team = side => { const t = c.competitors.find(x => x.homeAway === side).team; return { abbreviation: t.abbreviation, display_name: t.abbreviation }; };
      return { id, date: c.date, status: { semantics: 'SCHEDULE' }, teams: { away: team('away'), home: team('home') }, venue: { name: c.venue.fullName } };
    }
  }
  throw new Error(`no fixture event ${id}`);
};

function sandbox({ weather = gameWeatherView(WX, NOW), now = NOW } = {}) {
  const calls = [], listeners = {}, timers = new Map();
  let timerId = 0;
  const hosts = {};
  const root = { dataset: {}, querySelector: sel => (hosts[sel] ||= { dataset: {}, innerHTML: '', scrollTop: 0, textContent: '', classList: { toggle() {} }, querySelectorAll: () => [] }), addEventListener() {} };
  const vc = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; }, querySelector: sel => (sel === '.pbecast6' ? root : null) };
  const document = {
    visibilityState: 'visible', readyState: 'complete',
    querySelector: sel => (sel === '.pbecast6' ? root : sel.startsWith('.pbecast6 ') ? root.querySelector(sel.slice(10)) : null),
    querySelectorAll: () => [], getElementById: id => (id === 'view-container' ? vc : null), addEventListener() {}
  };
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const ctx = {
    console, URL, Intl, Math, JSON, Promise, Headers: class {}, AbortController,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
    document, localStorage: store(), sessionStorage: store(),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, ms); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, fn) => (listeners[name] ||= []).push(fn),
    dispatchEvent: e => (listeners[e.type] || []).forEach(fn => fn(e)),
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch: async url => {
      const u = String(url); calls.push(u);
      if (u.includes('/api/schedule')) return json(SCHEDULE);
      if (u.includes('/api/game-weather')) return json(weather);
      return json({ ok: false, error: 'not_in_sandbox' }, 503);
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['nfl-broadcast-v1.js', 'nfl-game-context-v1.js', 'pbecast-v6.js']) vm.runInContext(src(f), ctx);
  const cast = ctx.PBEcastV6;
  const hero = () => root.querySelector('[data-cast6-hero]').innerHTML;
  const select = async id => { cast.state.activeId = id; cast.state.detail = { game: espnGame(id), source: { semantics: 'SCHEDULE', provider: 'espn_site_summary' } }; };
  const ready = async () => { await ctx.PBEBroadcast.load(); await ctx.PBEGameContext.load(); };
  const env = html => {
    const m = /<div class="pbe-env ([^"]*)"([^>]*)>([\s\S]*?)<\/div>/.exec(html);
    if (!m) return null;
    const attr = k => (new RegExp(`${k}="([^"]*)"`).exec(m[2]) || [])[1] || null;
    return { cls: m[1], selected: attr('data-env-event'), kind: attr('data-wx-kind'), wx: attr('data-wx-event'), venue: attr('data-env-venue'), roof: attr('data-env-roof'), text: m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
  };
  return { ctx, cast, calls, listeners, timers, hero, select, ready, env };
}
const wxRow = id => WX.games.find(g => g.game_id === id).window;
const selectFinal = async (s, id) => { await s.select(id); s.cast.state.detail.source.semantics = 'FINAL'; s.cast.state.detail.game.status.semantics = 'FINAL'; };

test('DEN @ KC selected in PBEcast: the hero renders the Arrowhead kickoff forecast, joined by its own event id', async () => {
  const s = sandbox();
  await s.ready();
  await s.select('401872931');
  const e = s.env(s.cast.envHtml());
  const w = wxRow('401872931');
  assert.equal(e.kind, 'forecast');
  assert.equal(e.selected, '401872931');
  assert.equal(e.wx, '401872931', 'weather event id equals the selected ESPN event id');
  assert.equal(e.venue, 'Arrowhead Stadium');
  assert.equal(e.roof, 'OUTDOOR');
  assert.match(e.text, new RegExp(`OUTDOOR · ${Math.round(w.temp_f)}°F`));
  assert.match(e.text, new RegExp(`Wind ${Math.round(w.wind_mph)} mph · Gusts ${Math.round(w.gust_mph)} mph · Rain ${Math.round(w.precip_probability_pct)}%`));
  s.cast.patchFreshness();
  assert.match(s.hero(), /cast6-context-item is-weather/);
  assert.match(s.hero(), new RegExp(`OUTDOOR · ${Math.round(w.temp_f)}°F`));
});

test('PBEcast renders useful environment states and hides non-actionable weather diagnostics', async () => {
  const s = sandbox();
  await s.ready();
  const later = FIX.week3.content.sbData.events.find(e => !e.competitions[0].venue.indoor && !e.competitions[0].neutralSite);

  for (const [id, kind, text, venue] of [
    ['401872927', 'indoor', /DOME \/ INDOOR Local forecast unavailable/i, 'U.S. Bank Stadium'],
    ['401872933', 'forecast', /RETRACTABLE ROOF · 87°F · Overcast.*Outdoor conditions · roof status not confirmed/i, 'Mercedes-Benz Stadium']
  ]) {
    await s.select(id);
    const e = s.env(s.cast.envHtml());
    assert.equal(e.kind, kind, id);
    assert.match(e.text, text, id);
    assert.equal(e.venue, venue, id);
  }

  for (const id of ['401872960', later.id]) {
    await s.select(id);
    assert.equal(s.cast.envHtml(), '', `${id}: unavailable/pending weather must not become a hero error banner`);
  }
});

test('a stale weather snapshot is hidden from the PBEcast hero instead of rendered as an error banner', async () => {
  const stale = gameWeatherView(WX, NOW + 3 * 3600000);
  assert.equal(stale.stale, true);
  const s = sandbox({ weather: stale, now: NOW + 3 * 3600000 });
  await s.ready();
  await s.select('401872932');
  assert.equal(s.cast.envHtml(), '', 'legacy strip remains hidden');
  const html = s.cast.heroHtml();
  assert.match(html, /cast6-context-item is-weather is-stale/);
  assert.match(html, /Last verified forecast · refresh delayed/);
  assert.doesNotMatch(html, /Latest forecast is out of date/i);
});

test('PBEcast hero keeps stadium and verified TV channel in a dedicated game-context row', async () => {
  const s = sandbox();
  await s.ready();
  await s.select('401872927');

  // Live detail can omit venue; the canonical schedule still owns this fact.
  s.cast.state.detail.game.venue = null;
  const html = s.cast.heroHtml();

  assert.match(html, /cast6-contextbar/);
  assert.match(html, />VENUE</);
  assert.match(html, /U\.S\. Bank Stadium/);
  assert.match(html, />WATCH</);
  assert.match(html, /CBS/);
  assert.match(html, /LOCAL WEATHER/);
});

test('switching the selected game switches the weather; the previous game never lingers', async () => {
  const s = sandbox();
  await s.ready();
  await s.select('401872931');
  assert.equal(s.env(s.cast.envHtml()).wx, '401872931');
  await s.select('401872932');
  const e = s.env(s.cast.envHtml());
  assert.equal(e.selected, '401872932');
  assert.equal(e.wx, '401872932');
  assert.equal(e.venue, 'Highmark Stadium');
  assert.doesNotMatch(s.cast.envHtml(), /401872931|Arrowhead/);
  assert.match(e.text, new RegExp(`${Math.round(wxRow('401872932').temp_f)}°F`));
});

test('a forecast that does not match the selected game cannot render', async () => {
  const view = gameWeatherView(WX, NOW);
  const den = view.games.find(g => g.event_id === '401872931');
  den.venue = { ...den.venue, name: 'Some Other Stadium' };
  const s = sandbox({ weather: view });
  await s.ready();
  await s.select('401872931');
  const e = s.env(s.cast.envHtml());
  assert.equal(e.kind, 'unavailable');
  assert.equal(e.wx, null);
  assert.doesNotMatch(e.text, /°F/);
  /* and a schedule row for another event is refused outright */
  const C = s.ctx.PBEGameContext;
  const other = C.fromSchedule(s.ctx.PBEBroadcast.find({ event: '401872945' }), { state: 'SCHEDULE' });
  assert.equal(C.environmentModel(other, C.state, { selectedEventId: '401872931' }).rejected, true);
});

test('pbe:game-weather repaints the hero from loading to the forecast without touching lanes or selection', async () => {
  const s = sandbox();
  await s.ctx.PBEBroadcast.load();
  await s.select('401872931');
  const C = s.ctx.PBEGameContext;
  C.state.status = 'loading';
  s.cast.patchFreshness();
  assert.equal(s.env(s.hero()).kind, 'loading');
  const timersBefore = s.timers.size, callsBefore = s.calls.length;
  await C.load(true);          // lands and dispatches pbe:game-weather
  const e = s.env(s.hero());
  assert.equal(e.kind, 'forecast');
  assert.equal(e.wx, '401872931');
  assert.equal(s.cast.state.activeId, '401872931', 'selection kept');
  assert.equal(s.timers.size, timersBefore, 'the repaint scheduled no lane');
  assert.equal(s.calls.slice(callsBefore).filter(u => u.includes('/api/nfl-live')).length, 0, 'the repaint made no live request');
});

test('mounting PBEcast twice: one schedule read, one weather read, one listener each, no duplicate lanes', async () => {
  const s = sandbox();
  await s.cast.load();
  await s.cast.load();
  await new Promise(r => setImmediate(r));
  assert.equal(s.calls.filter(u => u.includes('/api/game-weather')).length, 1, 'one weather request per memo window');
  assert.equal(s.calls.filter(u => u.includes('/api/schedule')).length, 1, 'one schedule request per memo window');
  assert.equal((s.listeners['pbe:game-weather'] || []).length, 1, 'PBEcast listens once, however often it mounts');
  const live = Object.values(s.cast.lanes).filter(l => l.timer !== null && s.timers.has(l.timer)).length;
  assert.ok(live <= 4, `at most one armed timer per lane (${live})`);
  const pending = [...s.timers.keys()].length;
  assert.ok(pending <= 4, `no timers beyond the four lanes (${pending})`);
});

test('a completed game keeps its roof fact and never shows a forecast', async () => {
  const s = sandbox();
  await s.ready();
  const outdoorFinal = FIX.week1.content.sbData.events.find(e => !e.competitions[0].venue.indoor && !e.competitions[0].neutralSite && e.id !== '401872931');
  const cases = [
    ['401872927', 'indoor', /Indoor Weather neutralized/i],
    ['401872657', 'unavailable', /Neutral-site venue not resolved for a forecast/i],
    [outdoorFinal.id, 'final', /Game final Kickoff forecast not retained/i]
  ];
  for (const [id, kind, text] of cases) {
    await selectFinal(s, id);
    const e = s.env(s.cast.envHtml());
    assert.equal(e.kind, kind, id);
    assert.match(e.text, text, id);
    assert.doesNotMatch(e.text, /°F/, id);
  }
  await selectFinal(s, '401872931');
  assert.equal(s.env(s.cast.envHtml()).kind, 'final', 'DEN @ KC once final no longer carries its kickoff forecast');
});
