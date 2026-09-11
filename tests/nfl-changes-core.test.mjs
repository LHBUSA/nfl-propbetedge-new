/* What Changed: every emitted change traces to a published field, nothing is
 * claimed that the source did not say, and an unavailable market tape can
 * never read as "no moves". Fixtures mirror the real ESPN / tape shapes
 * measured on 2026-09-11. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStatus, injurySeverity, parseScoreboard, teamGameIndex, gameStatusChanges,
  parseInjuryReport, recentInjuryChanges, availabilityByGame, marketMoves, tapeSeries, rankChanges
} from '../api/_changes/core.js';
import { nflverseGameId, nflverseCode } from '../workers/nfl-picks-engine-shared/current-slate.mjs';

const NOW = Date.parse('2026-09-11T13:00:00Z');

function competitor(side, abbr, name, id, score = '0') {
  return { homeAway: side, score, team: { id, abbreviation: abbr, displayName: name, logo: `https://a.espncdn.com/${abbr}.png` } };
}
function event(id, date, away, home, type = { name: 'STATUS_SCHEDULED', state: 'pre', shortDetail: '9/13 - 1:00 PM EDT' }) {
  return { id, date, season: { year: 2026, type: 2 }, week: { number: 1 },
    competitions: [{ competitors: [competitor('away', ...away), competitor('home', ...home)], status: { type } }] };
}
const SCOREBOARD = { events: [
  event('401872657', '2026-09-11T00:35Z', ['SF', 'San Francisco 49ers', '25', '27'], ['LAR', 'Los Angeles Rams', '14', '7'], { name: 'STATUS_FINAL', state: 'post', shortDetail: 'Final' }),
  event('401872925', '2026-09-13T17:00Z', ['TB', 'Tampa Bay Buccaneers', '27'], ['CIN', 'Cincinnati Bengals', '4']),
  event('401872999', '2026-09-13T17:00Z', ['NYJ', 'New York Jets', '20'], ['TEN', 'Tennessee Titans', '10'], { name: 'STATUS_POSTPONED', state: 'pre', shortDetail: 'Postponed' })
] };

function injury(id, status, date, name, pos, team, comment = 'Limited in practice Thursday.') {
  return { id, status, date, shortComment: comment,
    details: { type: 'Hamstring', location: 'Leg', detail: 'Strain', side: 'Not Specified', returnDate: '2026-09-13' },
    athlete: { displayName: name, position: { abbreviation: pos }, headshot: { href: `https://a.espncdn.com/i/headshots/nfl/players/full/${id}9.png` },
      links: [{ href: `https://www.espn.com/nfl/player/_/id/${id}9/x` }], team: { id: '1', abbreviation: team, displayName: team } } };
}
const REPORT = { timestamp: '2026-09-11T12:55:15Z', injuries: [
  { id: '27', displayName: 'Tampa Bay Buccaneers', injuries: [
    injury('1', 'Out', '2026-09-11T10:00Z', 'Mike Evans', 'WR', 'TB'),
    injury('2', 'Questionable', '2026-09-08T10:00Z', 'Old Note', 'RB', 'TB'),          // outside 48h
    injury('3', 'Active', '2026-09-11T09:00Z', 'Some Linebacker', 'LB', 'TB'),         // ACTIVE, not a prop position
    injury('4', 'Active', '2026-09-11T09:30Z', 'Some Receiver', 'WR', 'TB'),           // ACTIVE, prop position
    injury('5', 'Injured Reserve', '2026-09-11T08:00Z', 'Long Term', 'TE', 'TB')
  ] },
  { id: '14', displayName: 'Los Angeles Rams', injuries: [
    injury('6', 'Out', '2026-09-11T00:07Z', 'Played Thursday', 'WR', 'LAR')          // game already final
  ] },
  { id: '4', displayName: 'Cincinnati Bengals', injuries: [
    injury('7', 'Doubtful', '2026-09-11T11:00Z', 'Joe Burrow', 'QB', 'CIN'),
    injury('8', 'Questionable', '2026-09-11T11:30Z', 'A Guard', 'G', 'CIN')
  ] }
] };

test('status vocabulary and severity ranking', () => {
  assert.equal(normalizeStatus('Out'), 'OUT');
  assert.equal(normalizeStatus('Injured Reserve'), 'INJURED_RESERVE');
  assert.equal(normalizeStatus('Suspension'), 'SUSPENDED');
  assert.equal(normalizeStatus('Something New'), 'SOMETHING_NEW');   // unknown kept, not bucketed
  assert.equal(normalizeStatus(''), null);
  assert.equal(injurySeverity('OUT', 'WR'), 'HIGH');
  assert.equal(injurySeverity('OUT', 'LB'), 'MEDIUM');
  assert.equal(injurySeverity('QUESTIONABLE', 'QB'), 'HIGH');
  assert.equal(injurySeverity('QUESTIONABLE', 'G'), 'LOW');
  assert.equal(injurySeverity('ACTIVE', 'QB'), 'LOW');               // ACTIVE restricts nothing
});

test('scoreboard: identity, semantics and only real disruptions become changes', () => {
  const games = parseScoreboard(SCOREBOARD);
  assert.equal(games.length, 3);
  assert.equal(games[0].semantics, 'FINAL');
  assert.equal(games[1].matchup, 'TB @ CIN');
  const changes = gameStatusChanges(games, '2026-09-11T13:00:00.000Z');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'POSTPONED');
  assert.equal(changes[0].observed_basis, 'OBSERVED_BY_PBE');         // scoreboard has no status timestamp
});

test('injuries: window, ACTIVE noise, source timestamp and a final game demoted to history', () => {
  const games = parseScoreboard(SCOREBOARD);
  const rows = parseInjuryReport(REPORT);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].player.espn_id, '19');                         // from the athlete link, not a name
  const changes = recentInjuryChanges(rows, teamGameIndex(games), { now: NOW, windowHours: 48 });
  const names = changes.map(c => c.player.name);
  assert.ok(!names.includes('Old Note'), 'outside the window');
  assert.ok(!names.includes('Some Linebacker'), 'ACTIVE on a non-prop position is noise');
  assert.ok(names.includes('Some Receiver'), 'ACTIVE on a prop position is kept');
  const evans = changes.find(c => c.player.name === 'Mike Evans');
  assert.equal(evans.observed_at, '2026-09-11T10:00:00.000Z');
  assert.equal(evans.observed_basis, 'SOURCE_TIMESTAMP');
  assert.equal(evans.detail, 'Limited in practice Thursday.');       // the source's sentence, verbatim
  assert.equal(evans.game.matchup, 'TB @ CIN');
  const thursday = changes.find(c => c.player.name === 'Played Thursday');
  assert.equal(thursday.actionable, false);
  assert.equal(thursday.severity, 'LOW');
  const ranked = rankChanges(changes);
  assert.equal(ranked[0].severity, 'HIGH');
  assert.ok(!ranked.some(c => /from|→|->/.test(c.headline)), 'no transition is ever claimed');
});

test('availability: open games only, restrictive designations only', () => {
  const games = parseScoreboard(SCOREBOARD);
  const avail = availabilityByGame(parseInjuryReport(REPORT), games);
  assert.ok(!avail['401872657'], 'a final game carries no availability list');
  const tbCin = avail['401872925'].map(r => `${r.player.name}:${r.status}`);
  /* current designations regardless of note age: Old Note is still Questionable */
  assert.deepEqual(tbCin.sort(), ['A Guard:QUESTIONABLE', 'Joe Burrow:DOUBTFUL', 'Mike Evans:OUT', 'Old Note:QUESTIONABLE'].sort());
  assert.ok(!avail['401872925'].some(r => r.status === 'INJURED_RESERVE' || r.status === 'ACTIVE'));
  assert.equal(avail['401872925'][0].severity, 'HIGH');
});

/* ---- market tape --------------------------------------------------------- */
const GID = nflverseGameId({ season: 2026, seasonType: 'REG', week: 1, away: nflverseCode('TB'), home: nflverseCode('CIN') });
function tape(capturedAt, { spread, total, awayMl, homeMl, books = 7 }) {
  return [
    { game_id: GID, market: 'spread', team: 'CIN', is_home: true, line: spread, price: -110, book: `consensus:${books}`, captured_at: capturedAt },
    { game_id: GID, market: 'spread', team: 'TB', is_home: false, line: -spread, price: -110, book: `consensus:${books}`, captured_at: capturedAt },
    { game_id: GID, market: 'total', over_under: 'OVER', line: total, price: -110, book: `consensus:${books}`, captured_at: capturedAt },
    { game_id: GID, market: 'total', over_under: 'UNDER', line: total, price: -110, book: `consensus:${books}`, captured_at: capturedAt },
    { game_id: GID, market: 'moneyline', team: 'TB', is_home: false, line: null, price: awayMl, book: `consensus:${books}`, captured_at: capturedAt },
    { game_id: GID, market: 'moneyline', team: 'CIN', is_home: true, line: null, price: homeMl, book: `consensus:${books}`, captured_at: capturedAt }
  ];
}
const byTape = new Map([[GID, { id: '401872925', matchup: 'TB @ CIN', kickoff: '2026-09-13T17:00:00.000Z', semantics: 'SCHEDULE', detail: null }]]);

test('tape: one observation is never a move', () => {
  assert.equal(marketMoves(tape('2026-09-10T12:00:00Z', { spread: -3.5, total: 50.5, awayMl: 150, homeMl: -175 }), byTape).length, 0);
});

test('tape: key number, material total, sub-threshold noise and one row per spread', () => {
  const rows = [
    ...tape('2026-09-10T12:00:00Z', { spread: -2.5, total: 50.5, awayMl: 130, homeMl: -150, books: 6 }),
    ...tape('2026-09-11T12:00:00Z', { spread: -3.5, total: 51.0, awayMl: 170, homeMl: -200, books: 7 })
  ];
  const moves = marketMoves(rows, byTape);
  const spread = moves.filter(m => m.market.market === 'spread');
  assert.equal(spread.length, 1, 'the two sides of one spread are one fact');
  assert.equal(spread[0].market.key_number, 3);
  assert.equal(spread[0].status, 'KEY_NUMBER');
  assert.equal(spread[0].market.from.line, -2.5);
  assert.equal(spread[0].market.to.line, -3.5);
  assert.equal(spread[0].market.from.books, 6);
  assert.equal(spread[0].market.basis, 'PREVIOUS_BATCH');
  assert.equal(spread[0].observed_at, '2026-09-11T12:00:00.000Z');   // the tape's capture time
  assert.equal(moves.filter(m => m.market.market === 'total').length, 0, '0.5 on a total is noise');
  const ml = moves.filter(m => m.market.market === 'moneyline');
  assert.equal(ml.length, 1, 'one moneyline fact, home side');
  assert.equal(ml[0].market.selection, 'CIN');
  assert.equal(ml[0].market.unit, 'pp');
  assert.equal(ml[0].market.delta, 6.7);
});

test('tape: drift since the first capture is reported when the last step was quiet', () => {
  const rows = [
    ...tape('2026-09-09T12:00:00Z', { spread: -1.5, total: 48, awayMl: 110, homeMl: -130 }),
    ...tape('2026-09-10T12:00:00Z', { spread: -2.0, total: 49, awayMl: 112, homeMl: -132 }),
    ...tape('2026-09-11T12:00:00Z', { spread: -2.0, total: 49.5, awayMl: 112, homeMl: -132 })
  ];
  const spread = marketMoves(rows, byTape).find(m => m.market.market === 'spread');
  assert.equal(spread, undefined, '-1.5 to -2.0 crosses no key number and is under a point');
  const total = marketMoves(rows, byTape).find(m => m.market.market === 'total');
  assert.equal(total.market.basis, 'FIRST_OBSERVATION');
  assert.equal(total.market.delta, 1.5);
});

test('tapeSeries ignores rows without identity instead of guessing one', () => {
  const s = tapeSeries([{ game_id: GID, market: 'spread', team: null, line: -3, price: -110, captured_at: '2026-09-11T12:00:00Z' }]);
  assert.equal(s.length, 0);
});
