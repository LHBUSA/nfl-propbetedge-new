/* Week transition: which week the dashboard leads with.
 *
 * nfl-current keeps `current_week` as the provider's label (the picks engine
 * grades against it) and adds `primary_slate_week` / `primary_slate`, decided
 * from game state. The fixture is production's real 2026 Week 1 + Week 2
 * schedule; each case sets game states and a clock and asserts the decision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deriveSlate, weekKey } from '../workers/nfl-current/src/slate.js';
import worker from '../workers/nfl-current/src/index.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/nfl-slate-2026-week1-week2.json', import.meta.url), 'utf8'));
const T = s => Date.parse(s);
const H = 36e5;

/* states(g) -> 'FINAL' | 'LIVE' | 'SCHEDULE' for each fixture game. */
function games(states, extra = []) {
  return FIX.games.concat(extra).map(g => ({ ...g, semantics: states(g), detail: '' }));
}
const before = iso => g => (T(g.kickoff) < T(iso) ? 'FINAL' : 'SCHEDULE');
const REG = w => ({ season: 2026, season_type: 'REG', week: w });

test('fixture is the real transition: 16 Week 1 games, Week 2 opens Thursday DET @ BUF', () => {
  const w1 = FIX.games.filter(g => g.week === 1), w2 = FIX.games.filter(g => g.week === 2);
  assert.equal(w1.length, 16);
  assert.equal(w2.length, 16);
  assert.equal(w2.sort((a, b) => T(a.kickoff) - T(b.kickoff))[0].name, 'DET @ BUF');
});

test('TUESDAY after MNF final: all 16 Week 1 FINAL, provider still says Week 1 -> primary slate Week 2 UPCOMING', () => {
  const now = T('2026-09-15T11:00:00Z');
  const s = deriveSlate(games(g => (g.week === 1 ? 'FINAL' : 'SCHEDULE')), REG(1), now);
  assert.equal(s.provider_week, 1, 'provider week preserved');
  assert.equal(s.primary_slate_week, 2);
  assert.equal(s.primary_slate.key, '2026:REG:2');
  assert.equal(s.primary_slate.state, 'UPCOMING');
  assert.equal(s.primary_slate.label, 'WEEK 2');
  assert.equal(s.primary_slate.reason, 'advanced_to_earliest_scheduled_kickoff');
  assert.equal(s.primary_slate.counts_in_window.games, 16);
  assert.equal(s.primary_slate.counts_in_window.final, 0);
  assert.equal(s.previous_slate.key, '2026:REG:1');
  assert.equal(s.previous_slate.state, 'FINAL');
  assert.equal(s.latest_completed_week, 1);
  /* The dates must hold the whole week, Thursday through Monday night. */
  const [from, to] = s.primary_slate.dates.split('-');
  assert.ok(from <= '20260917' && to >= '20260922', s.primary_slate.dates);
  const [pf, pt] = s.previous_slate.dates.split('-');
  assert.ok(pf <= '20260909' && pt >= '20260915', s.previous_slate.dates);
});

test('SUNDAY afternoon, no game live, 4pm games still to play -> Week 1 stays primary (IN_PROGRESS)', () => {
  const now = T('2026-09-13T19:40:00Z');
  const s = deriveSlate(games(before('2026-09-13T19:00:00Z')), REG(1), now);
  assert.equal(s.primary_slate_week, 1);
  assert.equal(s.primary_slate.state, 'IN_PROGRESS');
  assert.equal(s.primary_slate.reason, 'provider_week_has_games_to_play');
  assert.equal(s.previous_slate, null, 'no earlier completed week in the window');
});

test('SUNDAY afternoon with 1pm games LIVE -> Week 1 LIVE', () => {
  const now = T('2026-09-13T18:30:00Z');
  const s = deriveSlate(games(g => (g.kickoff === '2026-09-13T17:00Z' ? 'LIVE' : before('2026-09-13T17:00:00Z')(g))), REG(1), now);
  assert.equal(s.primary_slate_week, 1);
  assert.equal(s.primary_slate.state, 'LIVE');
  assert.equal(s.primary_slate.reason, 'live_games');
});

test('SUNDAY night with SNF still upcoming -> Week 1', () => {
  const now = T('2026-09-13T23:30:00Z');
  const s = deriveSlate(games(before('2026-09-13T23:00:00Z')), REG(1), now);
  assert.equal(s.primary_slate_week, 1);
  assert.equal(s.primary_slate.counts_in_window.scheduled, 2, 'SNF + MNF');
});

test('MONDAY with MNF still upcoming -> Week 1, never advanced by the calendar', () => {
  const now = T('2026-09-14T20:00:00Z');
  const s = deriveSlate(games(before('2026-09-14T12:00:00Z')), REG(1), now);
  assert.equal(s.primary_slate_week, 1);
  assert.equal(s.primary_slate.counts_in_window.scheduled, 1);
  assert.equal(s.primary_slate.state, 'IN_PROGRESS');
});

test('MONDAY night with MNF LIVE -> Week 1 LIVE even though Week 2 games exist', () => {
  const now = T('2026-09-15T01:30:00Z');
  const s = deriveSlate(games(g => (g.id === '401872931' ? 'LIVE' : g.week === 1 ? 'FINAL' : 'SCHEDULE')), REG(1), now);
  assert.equal(s.primary_slate_week, 1);
  assert.equal(s.primary_slate.state, 'LIVE');
});

test('THURSDAY game LIVE -> Week 2 LIVE, whether or not the provider label has rolled', () => {
  const now = T('2026-09-18T01:30:00Z');
  const st = g => (g.id === '401872932' ? 'LIVE' : g.week === 1 ? 'FINAL' : 'SCHEDULE');
  for (const provider of [REG(1), REG(2)]) {
    const s = deriveSlate(games(st), provider, now);
    assert.equal(s.primary_slate_week, 2);
    assert.equal(s.primary_slate.state, 'LIVE');
    assert.equal(s.previous_slate.key, '2026:REG:1');
  }
});

test('THURSDAY final, Sunday still to play, provider rolled to Week 2 -> Week 2 IN_PROGRESS', () => {
  const now = T('2026-09-18T06:00:00Z');
  const s = deriveSlate(games(g => (g.week === 1 || g.id === '401872932' ? 'FINAL' : 'SCHEDULE')), REG(2), now);
  assert.equal(s.primary_slate_week, 2);
  assert.equal(s.primary_slate.state, 'IN_PROGRESS');
  assert.equal(s.latest_completed_week, 1);
});

test('BYE weeks: a week with fewer games (teams on bye) is still the primary slate', () => {
  const now = T('2026-09-15T11:00:00Z');
  const byes = new Set(['401872933', '401872934']); // two Week 2 games removed
  const rows = games(g => (g.week === 1 ? 'FINAL' : 'SCHEDULE')).filter(g => !byes.has(g.id));
  const s = deriveSlate(rows, REG(1), now);
  assert.equal(s.primary_slate_week, 2);
  assert.equal(s.primary_slate.counts_in_window.games, rows.filter(g => g.week === 2).length);
});

test('a stale pregame (postponed, 6h+ past kickoff) does not hold the old week open', () => {
  const now = T('2026-09-15T11:00:00Z');
  const s = deriveSlate(games(g => (g.id === '401872931' ? 'SCHEDULE' : g.week === 1 ? 'FINAL' : 'SCHEDULE')), REG(1), now);
  assert.equal(s.primary_slate_week, 2);
});

/* Postseason restarts week numbers at 1, so identity is season:type:week. */
function postFixture() {
  const reg18 = [0, 1, 2].map(i => ({ id: `r${i}`, name: `A${i} @ B${i}`, kickoff: `2027-01-10T${18 + i}:00Z`, week: 18, season: 2026, season_type: 'REG', away: {}, home: {} }));
  const wc = [0, 1].map(i => ({ id: `p${i}`, name: `C${i} @ D${i}`, kickoff: `2027-01-16T${21 + i}:30Z`, week: 1, season: 2026, season_type: 'POST', away: {}, home: {} }));
  return [...reg18, ...wc];
}

test('POSTSEASON transition: REG Week 18 final, provider still REG 18 -> WILD CARD (POST 1), never REG week 1', () => {
  const now = T('2027-01-13T15:00:00Z');
  const rows = postFixture().map(g => ({ ...g, semantics: g.season_type === 'REG' ? 'FINAL' : 'SCHEDULE' }));
  const s = deriveSlate(rows, REG(18), now);
  assert.equal(s.primary_slate.key, '2026:POST:1');
  assert.equal(s.primary_slate.label, 'WILD CARD');
  assert.equal(s.primary_slate_week, 1);
  assert.equal(s.previous_slate.key, '2026:REG:18');
  assert.equal(weekKey({ season: 2026, season_type: 'REG', week: 1 }) === s.primary_slate.key, false);
});

test('Super Bowl gap week: conference championships final, SB 13 days out -> SUPER BOWL UPCOMING', () => {
  const now = T('2027-01-31T12:00:00Z');
  const rows = [
    { id: 'c1', kickoff: '2027-01-24T20:00Z', week: 3, season: 2026, season_type: 'POST', semantics: 'FINAL' },
    { id: 'c2', kickoff: '2027-01-24T23:30Z', week: 3, season: 2026, season_type: 'POST', semantics: 'FINAL' },
    { id: 'sb', kickoff: '2027-02-07T23:30Z', week: 5, season: 2026, season_type: 'POST', semantics: 'SCHEDULE' }
  ];
  const s = deriveSlate(rows, { season: 2026, season_type: 'POST', week: 3 }, now);
  assert.equal(s.primary_slate.label, 'SUPER BOWL');
  assert.equal(s.primary_slate.state, 'UPCOMING');
  assert.equal(s.previous_slate.label, 'CONFERENCE CHAMPIONSHIPS');
});

test('SEASON OVER: nothing scheduled -> most recent completed week, clearly FINAL', () => {
  const now = T('2027-02-09T12:00:00Z');
  const rows = [
    { id: 'c1', kickoff: '2027-01-24T20:00Z', week: 3, season: 2026, season_type: 'POST', semantics: 'FINAL' },
    { id: 'sb', kickoff: '2027-02-07T23:30Z', week: 5, season: 2026, season_type: 'POST', semantics: 'FINAL' }
  ];
  const s = deriveSlate(rows, { season: 2026, season_type: 'POST', week: 5 }, now);
  assert.equal(s.primary_slate.key, '2026:POST:5');
  assert.equal(s.primary_slate.state, 'FINAL');
  assert.equal(s.primary_slate.reason, 'no_scheduled_games_remaining');
  assert.equal(s.previous_slate.key, '2026:POST:3');
});

test('empty window -> no primary slate, nothing invented', () => {
  const s = deriveSlate([], REG(1), Date.now());
  assert.equal(s.primary_slate, null);
  assert.equal(s.primary_slate_week, null);
  assert.equal(s.provider_week, 1);
});

/* ---- the deployed handler: current_week is untouched, the slate is additive -- */
function adapterGame(g, semantics) {
  const side = t => ({ id: t.id, abbreviation: t.abbreviation, display_name: t.display_name, score: semantics === 'SCHEDULE' ? null : t.score, winner: t.winner });
  return { id: g.id, short_name: g.name, date: g.kickoff, week: g.week, season: { year: g.season, type: 2 }, status: { semantics, detail: '' }, teams: { away: side(g.away), home: side(g.home) } };
}
function kv() { const m = new Map(); return { get: async (k, o) => (m.has(k) ? (o?.type === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } }; }

test('HANDLER /api/season + /api/current-games at the real transition: current_week 1 kept, primary_slate_week 2, next game DET @ BUF', async () => {
  const realFetch = globalThis.fetch, realNow = Date.now;
  Date.now = () => T('2026-09-15T11:00:00Z');
  globalThis.fetch = async url => {
    assert.match(String(url), /api\/nfl-live\?range=/);
    const board = { ok: true, season: 2026, season_type: 2, week: 1, games: FIX.games.map(g => adapterGame(g, g.week === 1 ? 'FINAL' : 'SCHEDULE')) };
    return new Response(JSON.stringify(board), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const env = { NFL_KV: kv() };
    const season = await (await worker.fetch(new Request('https://x/api/season?force=1'), env)).json();
    assert.equal(season.current_week, 1, 'provider week label unchanged for picks/grading');
    assert.equal(season.provider_week, 1);
    assert.equal(season.primary_slate_week, 2);
    assert.equal(season.latest_completed_week, 1);
    assert.equal(season.next_game.name, 'DET @ BUF');
    assert.equal(season.next_game.week, 2);
    assert.equal(season.default_event_hint.id, '401872932', 'a completed Week 1 game is never the default event');
    assert.equal(season.primary_slate.state, 'UPCOMING');
    assert.equal(season.previous_slate.key, '2026:REG:1');

    const slate = await (await worker.fetch(new Request('https://x/api/current-games?force=1'), env)).json();
    assert.equal(slate.current_week, 1, 'picks engine slate keeps the provider week');
    assert.equal(slate.primary_slate_week, 2);
    assert.equal(slate.games.length, FIX.games.length);
    assert.deepEqual(Object.keys(slate.games[0]).sort(), ['away', 'detail', 'home', 'id', 'kickoff', 'name', 'season', 'season_type', 'semantics', 'week'], 'game rows the picks engine reads are unchanged');
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow;
  }
});

/* ---- dashboard slate core (browser module) ---------------------------------- */
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../nfl-slate-core-v1.js', import.meta.url), 'utf8'), sandbox);
const core = sandbox.window.PBESlateCore;
/* vm realm arrays are not this realm's Array. */
const plain = v => JSON.parse(JSON.stringify(v));

function boardGame(g, semantics) {
  return { id: g.id, date: g.kickoff, week: g.week, season: { year: g.season, type: g.season_type === 'POST' ? 3 : 2 }, status: { semantics, short_detail: semantics === 'FINAL' ? 'Final' : '' }, teams: { away: g.away, home: g.home } };
}

test('DASHBOARD at the transition: primary cards are Week 2 scheduled games, Thursday first, Week 1 only in RECENT FINALS', () => {
  const now = T('2026-09-15T11:00:00Z');
  const contract = deriveSlate(games(g => (g.week === 1 ? 'FINAL' : 'SCHEDULE')), REG(1), now);
  /* What ESPN's undated board actually holds on Tuesday: Week 1 only. */
  const board = FIX.games.filter(g => g.week === 1).map(g => boardGame(g, 'FINAL'));
  const onBoard = core.pick(contract, board);
  assert.equal(onBoard.games.length, 0);
  assert.equal(onBoard.complete, false, 'board lacks the primary week -> dashboard reads it by dates');

  const week = FIX.games.filter(g => g.week >= 2).map(g => boardGame(g, 'SCHEDULE'));
  const picked = core.pick(contract, week);
  assert.equal(picked.complete, true);
  assert.equal(picked.games.length, 16, 'Week 3 TNF in the padded range is filtered out');

  const groups = core.groups({ slate: contract.primary_slate, games: picked.games, previous: contract.previous_slate, previousGames: board });
  const labels = groups.map(g => g.label);
  assert.match(labels[0], /^NEXT · THURSDAY · SEP 17$/);
  assert.equal(groups[0].games[0].id, '401872932', 'DET @ BUF first');
  assert.match(labels[1], /SUNDAY · SEP 20/);
  assert.match(labels[2], /MONDAY · SEP 21/);
  const sunday = groups[1].games.map(g => T(g.date));
  assert.deepEqual(sunday, sunday.slice().sort((a, b) => a - b), 'Sunday chronological');
  const open = groups.filter(g => !g.folded);
  assert.ok(open.every(g => g.games.every(x => x.status.semantics === 'SCHEDULE')), 'every open card is an upcoming Week 2 game');
  assert.equal(open.reduce((n, g) => n + g.games.length, 0), 16);
  const recent = groups.find(g => g.key === 'previous');
  assert.equal(recent.label, 'RECENT FINALS · WEEK 1');
  assert.equal(recent.folded, true, 'Week 1 is secondary and collapsed');
  assert.equal(recent.games.length, 16);

  const head = core.heading(contract.primary_slate, picked.games);
  assert.match(head.eyebrow, /^WEEK 2 · UPCOMING · 16 GAMES$/);
  const featured = core.featured(picked.games);
  assert.equal(featured.id, '401872932', 'no completed Week 1 game becomes the featured event');
});

test('DASHBOARD with a live game: LIVE leads, next kickoffs open, later folded, finals folded', () => {
  const now = T('2026-09-13T18:30:00Z');
  const st = g => (g.kickoff === '2026-09-13T17:00Z' ? 'LIVE' : before('2026-09-13T17:00:00Z')(g));
  const contract = deriveSlate(games(st), REG(1), now);
  const board = FIX.games.filter(g => g.week === 1).map(g => boardGame(g, st(g)));
  const picked = core.pick(contract, board);
  assert.equal(picked.complete, true, 'live week is on the board: no extra read');
  const groups = core.groups({ slate: contract.primary_slate, games: picked.games, previous: contract.previous_slate, previousGames: [] });
  assert.deepEqual(plain(groups.map(g => [g.key, g.folded])), [['live', false], ['next', false], ['later', true], ['final', true]]);
  assert.equal(core.heading(contract.primary_slate, picked.games).title, '8 live now');
});

test('DASHBOARD season over: the final slate leads and says FINAL', () => {
  const slate = { key: '2026:POST:5', label: 'SUPER BOWL', state: 'FINAL' };
  const g = boardGame({ id: 'sb', kickoff: '2027-02-07T23:30Z', week: 5, season: 2026, season_type: 'POST', away: {}, home: {} }, 'FINAL');
  const groups = core.groups({ slate, games: [g], previous: null });
  assert.deepEqual(plain(groups.map(x => [x.label, x.folded])), [['SUPER BOWL · FINAL', false]]);
  assert.equal(core.heading(slate, [g]).title, 'Super Bowl is final');
});
