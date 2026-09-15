/* The gates' semantic invariants hold on real production state and FAIL on
 * each kind of corruption they exist to catch. Fixture: production
 * /api/season, /api/scores, /api/standings, /api/current-player captured
 * 2026-09-15 (Week 1 final, Week 2 scheduled). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weekStateInvariants, gameStateInvariants, teamScheduleInvariants, standingsInvariants, currentPlayerInvariants } from '../scripts/lib/nfl-state-invariants.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/nfl-state-2026-09-15.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-09-15T12:30:00Z');
const clone = v => JSON.parse(JSON.stringify(v));
const failures = rows => rows.filter(r => !r.ok).map(r => r.name);
const allPass = rows => assert.deepEqual(failures(rows), [], JSON.stringify(rows.filter(r => !r.ok), null, 1));

test('real production state satisfies every invariant', () => {
  allPass(weekStateInvariants(FIX.season, FIX.scores, NOW));
  allPass(gameStateInvariants(FIX.season, FIX.scores, NOW));
  allPass(teamScheduleInvariants(FIX.season, FIX.scores, NOW));
  allPass(standingsInvariants(FIX.season, FIX.scores, FIX.standings));
  allPass(currentPlayerInvariants(FIX.current_player.played));
  allPass(currentPlayerInvariants(FIX.current_player.unobserved));
});

test('week transition: a contract stuck on the finished week fails', () => {
  const s = clone(FIX.season);
  s.primary_slate = { ...s.previous_slate }; s.primary_slate_week = s.previous_slate.week;
  assert.ok(failures(weekStateInvariants(s, FIX.scores, NOW)).includes('primary slate is derived from game state (not the calendar)'));
});

test('week transition: advancing by the calendar while the old week still has a game fails', () => {
  const scores = clone(FIX.scores);
  const mnf = scores.games.find(g => g.game_id === '401872931');
  Object.assign(mnf, { semantics: 'SCHEDULE', status: 'scheduled', away_score: null, home_score: null, kickoff: '2026-09-15T23:00Z' });
  const rows = weekStateInvariants(FIX.season, scores, NOW);
  assert.ok(failures(rows).includes('primary slate is derived from game state (not the calendar)'), JSON.stringify(rows));
});

test('latest final / next game: a wrong id, a wrong score, or a final as next all fail', () => {
  const a = clone(FIX.season); a.latest_final.id = '401872656';
  assert.ok(failures(gameStateInvariants(a, FIX.scores, NOW)).includes('latest_final is the newest FINAL in the ledger'));
  const b = clone(FIX.season); b.latest_final.home.score = 30;
  assert.ok(failures(gameStateInvariants(b, FIX.scores, NOW)).includes('latest_final score equals the ledger score'));
  const c = clone(FIX.season); c.next_game = { ...c.latest_final };
  assert.ok(failures(gameStateInvariants(c, FIX.scores, NOW)).includes('next_game is live, else the earliest scheduled game; never a final'));
  const d = clone(FIX.scores); d.games[0].away_score = null;
  assert.ok(failures(gameStateInvariants(FIX.season, d, NOW)).includes('every FINAL in the ledger carries both scores'));
});

test('team schedule: BUF with no next game, or a stale last final, fails', () => {
  const a = clone(FIX.season); a.team_schedule.BUF.next = null;
  const ra = teamScheduleInvariants(a, FIX.scores, NOW);
  assert.ok(failures(ra).length === 1 && JSON.stringify(ra).includes('"team":"BUF"'));
  const b = clone(FIX.season); b.team_schedule.KC.last_final.away_score = 99;
  assert.ok(failures(teamScheduleInvariants(b, FIX.scores, NOW)).length === 1);
  const c = clone(FIX.season); delete c.team_schedule;
  assert.ok(failures(teamScheduleInvariants(c, FIX.scores, NOW)).includes('team_schedule published'));
});

test('standings: a record or completed-game count that disagrees with finals fails', () => {
  const a = clone(FIX.standings); a.divisions[0].teams[0].wins += 1;
  assert.ok(failures(standingsInvariants(FIX.season, FIX.scores, a)).includes('every team record equals its completed-game results'));
  const b = clone(FIX.standings); b.completed_games = 1;
  assert.ok(failures(standingsInvariants(FIX.season, FIX.scores, b)).includes('standings rest on exactly the completed regular-season games'));
});

test('current player: totals that disagree with game lines, or zeros for a missing sample, fail', () => {
  const a = clone(FIX.current_player.played); a.stats.passing.yards += 7;
  assert.ok(failures(currentPlayerInvariants(a)).includes('current-season totals equal the sum of completed-game lines'));
  const b = clone(FIX.current_player.unobserved); b.stats = { passing: { yards: 0 } };
  assert.equal(failures(currentPlayerInvariants(b)).length, 1);
  const c = clone(FIX.current_player.played); c.games_played = 5;
  assert.ok(failures(currentPlayerInvariants(c)).includes('games played never exceeds the team\'s completed games'));
});
