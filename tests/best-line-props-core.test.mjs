/* Best Line -> Player Props selector: which games are offered, which opens by
 * default, and what a served board may be called. Pure core, run in a VM the
 * same way the browser loads it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
vm.runInNewContext(readFileSync(new URL('../best-line-props-core-v1.js', import.meta.url), 'utf8'), ctx);
const C = ctx.PBEBestLinePropsCore;

/* The 2026-09-13 production slate at 1:30 PM ET, in nfl-intel /api/best-line shape. */
const EVENTS = [
  { id: 'chi-car', kickoff: '2026-09-13T17:05:00.000Z', started: true, away: 'Chicago Bears', home: 'Carolina Panthers' },
  { id: 'buf-hou', kickoff: '2026-09-13T17:05:00.000Z', started: true, away: 'Buffalo Bills', home: 'Houston Texans' },
  { id: 'gb-min', kickoff: '2026-09-13T20:25:00.000Z', started: false, away: 'Green Bay Packers', home: 'Minnesota Vikings' },
  { id: 'dal-nyg', kickoff: '2026-09-14T00:20:00.000Z', started: false, away: 'Dallas Cowboys', home: 'New York Giants' },
  { id: 'cin-hou', kickoff: '2026-09-20T17:00:00.000Z', started: false, away: 'Cincinnati Bengals', home: 'Houston Texans' },
];
const CORE = ['player_pass_yds', 'player_reception_yds', 'player_receptions', 'player_rush_yds', 'player_anytime_td'];
const COVERAGE = {
  semantics: 'PLAYER_PROP_COVERAGE',
  events: [
    { id: 'chi-car', commence_time: '2026-09-13T17:05:00Z', current_markets: [], verified_markets: CORE },
    { id: 'buf-hou', commence_time: '2026-09-13T17:05:00Z', current_markets: [], verified_markets: [] },
    { id: 'gb-min', commence_time: '2026-09-13T20:25:00Z', current_markets: CORE, verified_markets: CORE },
    { id: 'dal-nyg', commence_time: '2026-09-14T00:20:00Z', current_markets: CORE, verified_markets: CORE },
    { id: 'cin-hou', commence_time: '2026-09-20T17:00:00Z', current_markets: [], verified_markets: [] },
  ],
};
const at = iso => Date.parse(iso);
const ids = list => Array.from(list, e => e.id);

test('the production failure: at 1:30 PM the selector no longer jumps to Bengals @ Texans on Sep 20', () => {
  const list = C.propEvents(EVENTS, COVERAGE, at('2026-09-13T17:30:00Z'));
  assert.ok(ids(list).includes('chi-car'), 'a started game with a verified board stays selectable');
  assert.equal(C.resolveSelection(list, null, 'player_reception_yds', at('2026-09-13T17:30:00Z')), 'chi-car');
  assert.notEqual(C.resolveSelection(list, null, 'player_reception_yds', at('2026-09-13T17:30:00Z')), 'cin-hou');
});

test('before kickoff the nearest covered game is the default', () => {
  const now = at('2026-09-13T16:00:00Z');
  const list = C.propEvents(EVENTS, COVERAGE, now);
  assert.equal(C.resolveSelection(list, null, 'player_pass_yds', now), 'chi-car');
});

test('a started game with NO verified player board is not offered; future games always are', () => {
  const list = C.propEvents(EVENTS, COVERAGE, at('2026-09-13T17:30:00Z'));
  assert.ok(!ids(list).includes('buf-hou'), 'no board, kicked off: nothing truthful to show');
  assert.ok(ids(list).includes('cin-hou'), 'a future game without props stays selectable so NOT_OFFERED stays visible');
  assert.equal(list.find(e => e.id === 'chi-car').started, true);
});

test('as the afternoon moves on the default follows the nearest covered game, not the first future one', () => {
  const four = at('2026-09-13T20:10:00Z');
  assert.equal(C.resolveSelection(C.propEvents(EVENTS, COVERAGE, four), null, 'player_pass_yds', four), 'gb-min');
  const late = at('2026-09-13T23:30:00Z');
  assert.equal(C.resolveSelection(C.propEvents(EVENTS, COVERAGE, late), null, 'player_pass_yds', late), 'dal-nyg');
});

test('ties go to a game whose prices can still be taken', () => {
  const now = at('2026-09-13T18:45:00Z');           // 1h40m after 1:05, 1h40m before 4:25
  const list = C.propEvents(EVENTS, COVERAGE, now);
  assert.equal(C.defaultEvent(list, 'player_pass_yds', now).id, 'gb-min');
});

test('an explicit choice is kept while offered; a withdrawn one falls back to the default', () => {
  const now = at('2026-09-13T17:30:00Z');
  const list = C.propEvents(EVENTS, COVERAGE, now);
  assert.equal(C.resolveSelection(list, 'cin-hou', 'player_pass_yds', now), 'cin-hou');
  assert.equal(C.resolveSelection(list, 'buf-hou', 'player_pass_yds', now), 'chi-car');
});

test('a market-specific default prefers a game covering that market', () => {
  const now = at('2026-09-13T17:30:00Z');
  const cov = { ...COVERAGE, events: COVERAGE.events.map(e => (e.id === 'chi-car' ? { ...e, verified_markets: ['player_pass_yds'] } : e)) };
  const list = C.propEvents(EVENTS, cov, now);
  assert.equal(C.resolveSelection(list, null, 'player_pass_yds', now), 'chi-car');
  assert.equal(C.resolveSelection(list, null, 'player_receptions', now), 'gb-min');
});

test('without usable coverage (older nfl-odds answers with its featured slate) started games stay listed', () => {
  const now = at('2026-09-13T17:30:00Z');
  const featuredShape = { events: [{ id: 'chi-car', bookmakers: [] }], semantics: 'LAST_VERIFIED_MARKET' };
  assert.equal(C.coverageUsable(featuredShape), false);
  const list = C.propEvents(EVENTS, featuredShape, now);
  assert.deepEqual(ids(list), ids(EVENTS), 'the board read decides, not a guess');
});

const boardFor = (availability, provenance, started) => ({
  event: { id: 'chi-car', commence_time: '2026-09-13T17:05:00Z', started },
  market_availability: { player_reception_yds: availability },
  market_provenance: provenance === undefined ? { player_reception_yds: { semantics: availability, captured_at: '2026-09-13T17:00:41Z', captured_at_et: 'Sep 13, 1:00 PM ET', batch_id: 'b13' } } : provenance,
  quotes: availability.startsWith('NOT') ? [] : [{ market: 'player_reception_yds', player: 'DJ Moore', direction: 'OVER', point: 58.5, price: -112, book: 'DraftKings', captured_at: '2026-09-13T17:00:41Z' }],
});

test('a kicked-off board is labelled KICKED OFF — PRE-GAME MARKET SNAPSHOT with its own capture time', () => {
  const m = C.marketState(boardFor('LAST_VERIFIED_PREGAME_SNAPSHOT', undefined, true), 'player_reception_yds', at('2026-09-13T17:30:00Z'));
  assert.equal(m.headline, 'KICKED OFF — PRE-GAME MARKET SNAPSHOT');
  assert.equal(m.started, true);
  assert.equal(m.live, false);
  assert.equal(m.captured_at, '2026-09-13T17:00:41Z');
  assert.equal(m.batch_id, 'b13');
});

test('a pre-kickoff board is a MARKET SNAPSHOT; a retained market says LAST VERIFIED PRE-GAME SNAPSHOT', () => {
  const now = at('2026-09-13T16:00:00Z');
  assert.equal(C.marketState(boardFor('IN_SNAPSHOT', undefined, false), 'player_reception_yds', now).headline, 'MARKET SNAPSHOT');
  assert.equal(C.marketState(boardFor('LAST_VERIFIED_PREGAME_SNAPSHOT', undefined, false), 'player_reception_yds', now).headline, 'LAST VERIFIED PRE-GAME SNAPSHOT');
});

test('even a pre-v3.1 board that says IN_SNAPSHOT after kickoff is never shown as current', () => {
  const m = C.marketState(boardFor('IN_SNAPSHOT', null, undefined), 'player_reception_yds', at('2026-09-13T17:30:00Z'));
  assert.equal(m.started, true, 'kickoff is read from commence_time when the board has no started flag');
  assert.equal(m.headline, 'KICKED OFF — PRE-GAME MARKET SNAPSHOT');
  assert.equal(m.provenance_missing, true);
  assert.equal(m.captured_at, null, 'no per-market capture time recorded: none is claimed');
});

test('NOT_OFFERED_AT_INGEST serves nothing and claims no capture time', () => {
  const m = C.marketState(boardFor('NOT_OFFERED_AT_INGEST', { player_reception_yds: { captured_at: null } }, false), 'player_reception_yds', at('2026-09-13T16:00:00Z'));
  assert.equal(m.served, false);
  assert.equal(m.headline, null);
  assert.equal(m.captured_at, null);
  assert.equal(m.quotes.length, 0);
});
