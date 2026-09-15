/* PBEcast Game Pulse: the real pbecast-pulse-v1.js run in a sandbox over real
 * /api/nfl-live payloads captured 2026-09-14 (NO @ DET final in overtime, and
 * DEN @ KC live in Q2), plus hand-built series for the edge cases. The module
 * is loaded with a counting fetch and counting timers: it must use neither.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FIX = JSON.parse(readFileSync(new URL('../tests/fixtures/nfl-live-winprob-2026-09-14.json', import.meta.url), 'utf8'));
const SRC = readFileSync(new URL('../pbecast-pulse-v1.js', import.meta.url), 'utf8');

function load() {
  const counts = { fetch: 0, setTimeout: 0, setInterval: 0, raf: 0, listeners: [] };
  const window = {};
  const document = { addEventListener: name => counts.listeners.push(name), querySelectorAll: () => [] };
  const ctx = {
    window, document, console, JSON, Math, Number, String, Array, Map, Set, Object,
    fetch: () => { counts.fetch++; throw new Error('no network'); },
    setTimeout: () => { counts.setTimeout++; }, setInterval: () => { counts.setInterval++; },
    requestAnimationFrame: () => { counts.raf++; }
  };
  vm.runInNewContext(SRC, ctx, { filename: 'pbecast-pulse-v1.js' });
  return { P: window.PBEcastPulse, counts };
}
const { P, counts } = load();

const teams = { away: { id: '1', abbreviation: 'DEN' }, home: { id: '2', abbreviation: 'KC' } };
const game = (sem = 'LIVE', id = '900') => ({ id, status: { semantics: sem, short_detail: 'Q4 6:41', period: 4, clock: '6:41' }, teams, situation: {} });
const detail = (rows, { sem = 'LIVE', plays = [], id = '900' } = {}) => ({ source: { semantics: sem }, game: game(sem, id), plays, win_probability: rows });
const wp = (play_id, home, tie = 0) => ({ play_id, home_win_percentage: home, tie_percentage: tie });

test('no network, no timer, no animation loop; only a pointer listener', () => {
  const d = { ...FIX.live, source: { ...FIX.live.source } };
  const m = P.derive(d, { activeId: FIX.live.game.id });
  P.html(m);
  assert.deepEqual([counts.fetch, counts.setTimeout, counts.setInterval, counts.raf], [0, 0, 0, 0]);
  assert.equal(counts.listeners.join(), 'pointermove');
});

test('meaningful-swing threshold is one fixed rule of 5 points', () => {
  assert.equal(P.SWING_PP, 5);
  const m = P.derive(detail([wp('a', 0.5), wp('b', 0.549), wp('c', 0.599), wp('d', 0.5)]));
  assert.deepEqual([...m.swings].map(s => s.meaningful).join(), 'false,true,true');
  assert.equal(m.last.play_id, 'd');
  assert.equal(m.last.team, 'DEN');
  assert.equal(m.last.pp, 9.9);
});

test('live game: current probability, last and biggest swing from the real DEN @ KC series', () => {
  const m = P.derive(FIX.live, { activeId: FIX.live.game.id });
  assert.ok(m);
  assert.equal(m.semantics, 'LIVE');
  assert.equal(m.observations.length, FIX.live.win_probability.length);
  const tail = FIX.live.win_probability.at(-1);
  assert.equal(m.current.home, tail.home_win_percentage);
  assert.ok(Math.abs(m.current.away - (1 - tail.home_win_percentage - tail.tie_percentage)) < 1e-9);
  assert.ok(m.biggest && m.biggest.magnitude >= Math.max(...m.swings.map(s => s.magnitude)) - 1e-12);
  for (const s of m.swings.filter(s => s.meaningful)) assert.ok(s.pp >= 5);
  const html = P.html(m);
  assert.match(html, /GAME PULSE · LIVE WIN PROBABILITY/);
  assert.match(html, /not a PropBetEdge model/);
  assert.doesNotMatch(html, /PBE model|PBE Algo|our prediction|betting edge/i);
});

test('final game: full timeline, largest swings, every swing button names a published play', () => {
  const f = FIX.final_ot;
  const m = P.derive(f, { activeId: f.game.id });
  assert.equal(m.semantics, 'FINAL');
  assert.equal(m.observations.length, f.win_probability.length);
  assert.ok(m.observations.length > 80, 'the whole series, not the last 80');
  assert.ok(m.top.length > 0 && m.top.length <= 5);
  for (let i = 1; i < m.top.length; i++) assert.ok(m.top[i - 1].magnitude >= m.top[i].magnitude);
  assert.equal(m.top[0].index, m.biggest.index);
  const ids = new Set(f.plays.map(p => String(p.id)));
  const html = P.html(m);
  assert.match(html, /PBE REPLAY · GAME PULSE/);
  assert.match(html, /LARGEST SWINGS · 5\+ PTS/);
  assert.doesNotMatch(html, /LAST SWING/, 'the ranked list is not repeated as cards on a final game');
  const buttons = [...html.matchAll(/data-pulse-play="([^"]+)"/g)].map(x => x[1]);
  assert.ok(buttons.length > 0);
  for (const id of buttons) assert.ok(ids.has(id), `swing button ${id} is a published play`);
  /* the overtime period is labelled OT, not Q5 */
  if (f.plays.some(p => p.period > 4)) assert.match(html, />OT</);
});

test('scheduled or unavailable game renders nothing', () => {
  const rows = [wp('a', 0.5), wp('b', 0.6)];
  assert.equal(P.derive(detail(rows, { sem: 'SCHEDULE' })), null);
  assert.equal(P.derive(detail(rows, { sem: 'UNAVAILABLE' })), null);
  assert.equal(P.html(null), '');
});

test('missing or malformed probability fails closed: no curve, no 50/50', () => {
  assert.equal(P.derive(detail([])), null);
  assert.equal(P.derive(detail(undefined)), null);
  assert.equal(P.derive(detail('nope')), null);
  assert.equal(P.derive(detail([{ play_id: 'a' }, wp('b', null), wp('c', 'x'), wp('d', 1.4), wp('e', -0.1), wp('f', 0.7, 0.5), wp('g', true)])), null);
  /* malformed rows are dropped, valid ones survive */
  const m = P.derive(detail([wp('a', 0.5), wp('b', NaN), wp('c', 0.62)]));
  assert.equal(m.observations.length, 2);
  assert.equal(m.swings[0].play_id, 'c');
});

test('another game\'s data never renders', () => {
  const f = FIX.final_ot;
  assert.equal(P.derive(f, { activeId: '401872931' }), null, 'focused game differs from the payload');
  /* a series whose play ids match none of this game's plays is a previous game's */
  const foreign = { ...FIX.live, win_probability: f.win_probability };
  assert.equal(P.derive(foreign, { activeId: FIX.live.game.id }), null);
});

test('one observation: probability shown, no swing', () => {
  const m = P.derive(detail([wp('a', 0.61)]));
  assert.equal(m.observations.length, 1);
  assert.equal(m.swings.length, 0);
  assert.equal(m.last, null);
  assert.equal(m.biggest, null);
  const html = P.html(m);
  assert.match(html, /61\.0%/);
  assert.match(html, /Swings begin at the second observation/);
});

test('repeated identical observations are not moments', () => {
  const m = P.derive(detail([wp('a', 0.55), wp('b', 0.55), wp('c', 0.55), wp('c', 0.55)]));
  assert.equal(m.observations.length, 3, 'a republished observation for the same play collapses');
  assert.equal(m.meaningfulCount, 0);
  assert.equal(m.biggest, null);
  assert.match(P.html(m), /No move of 5 points or more yet/);
});

test('live: when the last swing is also the biggest it is one card, not two', () => {
  const m = P.derive(detail([wp('a', 0.5), wp('b', 0.52), wp('c', 0.65)]));
  assert.equal(m.last, m.biggest);
  const html = P.html(m);
  assert.match(html, /LAST SWING · BIGGEST SO FAR/);
  assert.doesNotMatch(html, /BIGGEST SWING/);
});

test('play-id match: swing carries the published play type and clock, and a Show play button', () => {
  const plays = [{ id: 'p1', type: 'Rush', period: 4, clock: '7:10' }, { id: 'p2', type: 'Turnover on Downs', period: 4, clock: '6:41' }];
  const m = P.derive(detail([wp('p1', 0.40), wp('p2', 0.252)], { plays }));
  assert.equal(m.last.team, 'DEN');
  assert.equal(m.last.pp, 14.8);
  assert.equal(P.swingContext(m.last), 'Turnover on Downs · Q4 6:41');
  const html = P.html(m);
  assert.match(html, /\+14\.8 DEN/);
  assert.match(html, /data-pulse-play="p2"/);
});

test('missing play-id match: only what is known, no invented reason, no button', () => {
  const plays = [{ id: 'p1', type: 'Rush', period: 4, clock: '7:10' }];
  const m = P.derive(detail([wp('p1', 0.40), wp('401547999', 0.548)], { plays }));
  assert.equal(m.last.play, null);
  assert.equal(P.swingContext(m.last), 'after play 401547999');
  const html = P.html(m);
  assert.match(html, /\+14\.8 KC/);
  assert.match(html, /after play 401547999/);
  assert.doesNotMatch(html, /data-pulse-play="401547999"/);
});

test('large swing is attributed to the team whose probability rose', () => {
  const m = P.derive(detail([wp('a', 0.9), wp('b', 0.12)]));
  assert.equal(m.biggest.team, 'DEN');
  assert.equal(m.biggest.side, 'away');
  assert.equal(m.biggest.pp, 78);
  assert.equal(m.top[0], m.biggest);
});

test('no meaningful swing yet: biggest is shown as under the threshold, last is empty', () => {
  const m = P.derive(detail([wp('a', 0.5), wp('b', 0.512), wp('c', 0.53), wp('d', 0.521)]));
  assert.equal(m.last, null);
  assert.ok(m.biggest && !m.biggest.meaningful);
  assert.equal(m.biggest.play_id, 'c');
  const html = P.html(m);
  assert.match(html, /BIGGEST SWING · UNDER 5 PTS/);
  assert.match(html, /No move of 5 points or more yet/);
});

test('tie probability is carried, not folded into the away team', () => {
  const m = P.derive(detail([wp('a', 0.40, 0.02), wp('b', 0.47, 0.03)]));
  assert.ok(Math.abs(m.current.away - 0.50) < 1e-9);
  assert.match(P.html(m), /TIE 3\.0%/);
});

test('v6 keeps the longer series when an older detail response lands late', async () => {
  const src = readFileSync(new URL('../pbecast-v6.js', import.meta.url), 'utf8');
  const noop = () => {};
  const window = { App: null, addEventListener: noop };
  const ctx = { window, document: { addEventListener: noop, querySelector: () => null, visibilityState: 'visible' }, localStorage: { getItem: () => null, setItem: noop }, sessionStorage: { getItem: () => null, removeItem: noop }, setTimeout: noop, clearTimeout: noop, console, AbortController, Date, JSON, Math, Number, String, Array, Map, Set, Object, Promise };
  vm.runInNewContext(src, ctx);
  const { winSeries } = window.PBEcastV6;
  const full = FIX.final_ot.win_probability;
  assert.equal(winSeries(full, full.slice(0, 50)), full, 'older, shorter series is ignored');
  assert.equal(winSeries(full.slice(0, 50), full), full, 'newer, longer series replaces');
  assert.equal(winSeries(full, undefined), full);
  const corrected = [wp('x', 0.3)];
  assert.equal(winSeries(full, corrected), corrected, 'a series that is not a continuation replaces');
});
