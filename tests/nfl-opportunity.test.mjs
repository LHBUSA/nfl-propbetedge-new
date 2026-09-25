/* Opportunity Radar data contract (workers/nfl-replay/src/opportunity.js +
 * the pipeline's rollup/read path). Synthetic plays, each built to prove one
 * rule: the play universe, missing-is-not-zero, ratio-of-sums, corrections,
 * trades, identity, seasons, byes, publication delay. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlay, aggregateGame, buildRollup, windowSummary, radarView, scriptView, gameState, LABEL_RULES, UNSUPPORTED } from '../workers/nfl-replay/src/opportunity.js';
import { fetchCrosswalk, rebuildOpportunity, opportunity, streamIngest, oppGameKey, rollupKey } from '../workers/nfl-replay/src/pipeline.js';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/* ---- builders ------------------------------------------------------------- */
let pid = 1;
const pass = (team, rec, extra = {}) => ({ play_id: pid++, posteam: team, play_type: 'pass', qb_dropback: true, pass_attempt: true, receiver_player_id: rec, receiver_player_name: rec && `N.${rec}`, qtr: 1, score_differential: 0, yardline_100: 60, ...extra });
const run = (team, rusher, extra = {}) => ({ play_id: pid++, posteam: team, play_type: 'run', rush_attempt: true, rusher_player_id: rusher, rusher_player_name: rusher && `N.${rusher}`, qtr: 1, score_differential: 0, yardline_100: 60, ...extra });
const endGame = () => ({ play_id: pid++, qtr: 4, game_seconds_remaining: 0 });
const keyed = list => Object.fromEntries(list.map(p => [p.play_id, p]));
/* A game where `team` throws `targets` (receiver id -> count) and runs `runs`. */
function game(id, week, team, opp, targets, runs = {}, { season = 2026, complete = true } = {}) {
  const plays = [];
  for (const [rec, n] of Object.entries(targets)) for (let i = 0; i < n; i++) plays.push(pass(team, rec));
  for (const [ru, n] of Object.entries(runs)) for (let i = 0; i < n; i++) plays.push(run(team, ru));
  plays.push(pass(opp, 'OPP1'));
  if (complete) plays.push(endGame());
  return aggregateGame(keyed(plays), { game_id: id, season: String(season), season_type: 'REG', week: String(week), home_team: team, away_team: opp });
}

/* ---- the play universe ------------------------------------------------------ */

test('play universe: targets, designed runs, and every exclusion are distinct', () => {
  assert.equal(classifyPlay(pass('KC', 'A')).kind, 'attempt');
  assert.equal(classifyPlay(pass('KC', null)).player, null, 'an attempt without an intended receiver is nobody\'s target');
  assert.equal(classifyPlay(pass('KC', null, { sack: true, pass_attempt: true })).kind, 'sack', 'sacks carry pass_attempt=1 in nflverse and are not attempts');
  assert.equal(classifyPlay(run('KC', 'QB', { qb_scramble: true, qb_dropback: undefined })).kind, 'scramble', 'a scramble without the dropback flag is still a scramble');
  assert.equal(classifyPlay(run('KC', 'RB')).universe, 'designed_run');
  assert.equal(classifyPlay({ ...run('KC', 'RB'), play_type: 'no_play' }).universe, 'no_play');
  assert.equal(classifyPlay(pass('KC', 'A', { two_point_attempt: true })).universe, 'two_point');
  assert.equal(classifyPlay({ play_id: 1, posteam: 'KC', play_type: 'qb_kneel', qb_kneel: true, rush_attempt: true }).universe, 'kneel');
  assert.equal(classifyPlay({ play_id: 1, posteam: 'KC', play_type: 'qb_spike', qb_spike: true, pass_attempt: true }).universe, 'spike');
  assert.equal(classifyPlay(run('KC', 'QB', { aborted_play: true })).universe, 'aborted');
  assert.equal(classifyPlay({ play_id: 1, posteam: 'KC', play_type: 'punt' }).universe, 'special');
  assert.equal(classifyPlay({ play_id: 1, qtr: 1 }).universe, 'admin');
});

test('no-play exclusions never reach a denominator; scrambles are never carries', () => {
  const plays = keyed([
    pass('KC', 'A'), pass('KC', 'A', { yardline_100: 8 }), pass('KC', null),
    pass('KC', null, { sack: true }),
    run('KC', 'QB', { qb_scramble: true }),
    run('KC', 'RB'), run('KC', 'RB', { yardline_100: 3 }),
    { ...pass('KC', 'A'), play_type: 'no_play' },
    run('KC', 'RB', { two_point_attempt: true }),
    { play_id: pid++, posteam: 'KC', play_type: 'qb_kneel', qb_kneel: true, rush_attempt: true, rusher_player_id: 'QB' },
    run('KC', 'QB', { aborted_play: true }),
    endGame()
  ]);
  const g = aggregateGame(plays, { game_id: 'G', season: '2026', season_type: 'REG', week: '1', home_team: 'KC', away_team: 'LV' });
  const T = g.teams.KC.totals;
  assert.deepEqual({ dropbacks: T.dropbacks, attempts: T.attempts, targets: T.targets, untargeted: T.untargeted_attempts, sacks: T.sacks, scrambles: T.scrambles, runs: T.designed_runs },
    { dropbacks: 5, attempts: 3, targets: 2, untargeted: 1, sacks: 1, scrambles: 1, runs: 2 });
  assert.equal(g.teams.KC.players.QB.c, 0, 'scramble volume is not a carry');
  assert.equal(g.teams.KC.players.QB.sc, 1);
  assert.equal(g.teams.KC.players.RB.c, 2);
  assert.deepEqual(g.teams.KC.excluded, { no_play: 1, two_point: 1, kneel: 1, spike: 0, aborted: 1, special: 0, other: 0 });
  assert.equal(T.rz_targets, 1); assert.equal(T.i10_targets, 1); assert.equal(T.i5_targets, 0);
  assert.equal(T.rz_carries, 1); assert.equal(T.i5_carries, 1);
  assert.equal(T.plays, T.dropbacks + T.designed_runs, 'plays = dropbacks + designed runs, nothing else');
});

test('game state comes from the pre-play margin with a documented 7-point line', () => {
  assert.equal(gameState(7), 'leading'); assert.equal(gameState(6), 'balanced');
  assert.equal(gameState(-7), 'trailing'); assert.equal(gameState(-6), 'balanced');
  assert.equal(gameState(undefined), 'unknown', 'a missing margin is unknown, never balanced');
  assert.equal(gameState(null), 'unknown');
});

test('duplicated play rows cannot double count: plays are keyed by play_id', () => {
  const p = pass('KC', 'A');
  const dup = { [p.play_id]: p };
  dup[p.play_id] = { ...p }; // same key delivered twice
  const g = aggregateGame({ ...dup, x: endGame() }, { game_id: 'G', season: '2026', week: '1', home_team: 'KC', away_team: 'LV' });
  assert.equal(g.teams.KC.totals.targets, 1);
});

/* ---- windows and aggregation --------------------------------------------------- */

test('ratio of sums: shares divide summed numerators by summed denominators', () => {
  const apps = [
    { p: { t: 1, c: 0, sc: 0, rzt: 0, rzc: 0, i10t: 0, i10c: 0, i5t: 0, i5c: 0 }, tt: { targets: 10, designed_runs: 20, rz_targets: 0, rz_carries: 0, i10_targets: 0, i10_carries: 0, i5_targets: 0, i5_carries: 0, dropbacks: 12, attempts: 10, plays: 32 }, week: 1 },
    { p: { t: 9, c: 0, sc: 0, rzt: 0, rzc: 0, i10t: 0, i10c: 0, i5t: 0, i5c: 0 }, tt: { targets: 30, designed_runs: 20, rz_targets: 0, rz_carries: 0, i10_targets: 0, i10_carries: 0, i5_targets: 0, i5_carries: 0, dropbacks: 32, attempts: 30, plays: 52 }, week: 2 }
  ];
  const w = windowSummary(apps);
  assert.equal(w.target_share, 10 / 40, '25% — not the 20% average of 10% and 30%');
  assert.equal(w.target_share_pct, 25);
  assert.equal(w.rz_share, null, 'no red-zone opportunities is not 0%');
});

test('team denominators include teammates who never reach a leaderboard', () => {
  const r = buildRollup([game('G1', 1, 'KC', 'LV', { A: 5, B: 1, C: 1, D: 1, E: 1, F: 1 })], { season: 2026 });
  const a = r.players.find(p => p.gsis_id === 'A');
  assert.equal(a.latest.team.targets, 10);
  assert.equal(a.latest.target_share, 0.5);
  const dist = r.teams.KC.players.reduce((s, p) => s + p.t, 0);
  assert.equal(dist, r.teams.KC.totals.targets, 'the distribution adds back to the team total');
});

test('missing is not zero: no recorded opportunity is its own state, never a 0% game', () => {
  const r = buildRollup([
    game('G1', 1, 'KC', 'LV', { A: 8, B: 12 }),
    game('G2', 2, 'KC', 'DEN', { A: 6, B: 14 }),
    game('G3', 3, 'KC', 'LAC', { B: 20 })   // A has nothing recorded
  ], { season: 2026 });
  const a = r.players.find(p => p.gsis_id === 'A');
  assert.equal(a.label, 'INSUFFICIENT_SAMPLE');
  assert.equal(a.notes[0].code, 'NO_RECORDED_OPPORTUNITY_LATEST');
  assert.deepEqual(a.no_recorded_games.map(g => g.week), [3]);
  assert.equal(a.latest_game.week, 2, 'latest appearance stays his last recorded game');
  assert.equal(a.season.games, 2, 'the unrecorded game is not in any window');
  assert.ok(!r.highlights.includes('A'));
});

test('bye weeks are not games: a team without a week-2 game records no gap', () => {
  const r = buildRollup([game('G1', 1, 'KC', 'LV', { A: 10 }), game('G3', 3, 'KC', 'LAC', { A: 10 })], { season: 2026 });
  const a = r.players.find(p => p.gsis_id === 'A');
  assert.deepEqual(a.no_recorded_games, []);
  assert.deepEqual(a.season.weeks, [1, 3]);
});

test('labels: expanding / declining / stable / insufficient follow the versioned rules', () => {
  const r = buildRollup([
    game('G1', 1, 'KC', 'LV', { UP: 3, DOWN: 12, FLAT: 8, TINY: 1, X: 16 }),
    game('G2', 2, 'KC', 'DEN', { UP: 12, DOWN: 3, FLAT: 8, TINY: 1, X: 16 })
  ], { season: 2026 });
  const L = id => r.players.find(p => p.gsis_id === id);
  assert.equal(L('UP').label, 'EXPANDING');
  assert.equal(L('UP').judged.target.delta_pp, 22.5);
  assert.equal(L('DOWN').label, 'DECLINING');
  assert.equal(L('FLAT').label, 'STABLE');
  assert.equal(L('TINY').label, 'STABLE', 'a tiny role moving nowhere is stable, not a signal');
  assert.equal(r.rules.version, 'opportunity-labels/1.0');
  assert.equal(r.rules.target.delta_pp, LABEL_RULES.target.delta_pp);
  const one = buildRollup([game('G1', 1, 'KC', 'LV', { A: 30 })], { season: 2026 });
  assert.equal(one.players[0].label, 'INSUFFICIENT_SAMPLE', 'no prior appearance -> insufficient sample');
  assert.match(one.players[0].judged.target.reasons.join(' '), /no prior appearance/);
});

test('insights quote only measured inputs, and the headline matches the numbers', () => {
  const r = buildRollup([
    game('G1', 1, 'KC', 'LV', { UP: 3, X: 37 }),
    game('G2', 2, 'KC', 'DEN', { UP: 12, X: 28 })
  ], { season: 2026 });
  const up = r.players.find(p => p.gsis_id === 'UP');
  const ins = up.insights.find(i => i.code === 'TARGET_EXPANDING');
  assert.ok(ins);
  assert.equal(ins.text, 'Target share rose from 7.5% to 30.0% (+22.5 pts): 12 of 40 KC targets in Week 2, vs 3 of 40 over the prior 1 game.');
  assert.equal(ins.inputs.latest, up.latest.target_share_pct);
  assert.equal(ins.inputs.prior, up.prior.target_share_pct);
  assert.ok(!up.insights.some(i => /red-zone/.test(i.text)), 'no red-zone line without red-zone plays');
  assert.ok(!up.insights.some(i => /injur|because|due to/i.test(i.text)), 'no causal or injury language');
});

test('"carry share increased, but target share remained flat" needs both measured', () => {
  const r = buildRollup([
    game('G1', 1, 'KC', 'LV', { RB: 4, X: 36 }, { RB: 8, Y: 12 }),
    game('G2', 2, 'KC', 'DEN', { RB: 4, X: 36 }, { RB: 16, Y: 4 })
  ], { season: 2026 });
  const rb = r.players.find(p => p.gsis_id === 'RB');
  assert.equal(rb.primary_metric, 'carry');
  assert.equal(rb.label, 'EXPANDING');
  assert.ok(rb.insights.some(i => i.text === 'Carry share increased, but target share remained flat (0.0 pts).'));
});

test('traded players: windows use only the current team; the old team is listed apart', () => {
  const r = buildRollup([
    game('G1', 1, 'NYJ', 'MIA', { T: 10, X: 20 }),
    game('G2', 2, 'NYJ', 'BUF', { T: 10, X: 20 }),
    game('G3', 3, 'KC', 'LV', { T: 4, Y: 30 }),
    game('G4', 4, 'KC', 'DEN', { T: 8, Y: 26 })
  ], { season: 2026 });
  const t = r.players.find(p => p.gsis_id === 'T');
  assert.equal(t.team, 'KC');
  assert.equal(t.season.games, 2);
  assert.equal(t.prior.team.targets, 34, 'prior window denominators are KC\'s only');
  assert.deepEqual(t.other_teams.map(o => [o.abbr, o.window.games, o.window.player.t, o.window.team.targets]), [['NYJ', 2, 20, 60]]);
  assert.deepEqual(radarView(r).players.find(p => p.gsis === 'T').other_teams, [{ team: 'NYJ', games: 2, t: 20, tt: 60, c: 0, tc: 0 }]);
  assert.ok(t.insights.some(i => i.code === 'TEAM_CHANGE'));
  assert.ok(!r.teams.KC.players.some(p => p.t === 20), 'NYJ targets never enter KC\'s distribution');
});

test('identity: players are keyed by gsis id, never by display name', () => {
  const plays = keyed([pass('KC', '00-0001', { receiver_player_name: 'J.Williams' }), pass('KC', '00-0002', { receiver_player_name: 'J.Williams' }), endGame()]);
  const g = aggregateGame(plays, { game_id: 'G', season: '2026', week: '1', home_team: 'KC', away_team: 'LV' });
  assert.equal(Object.keys(g.teams.KC.players).length, 2);
  const r = buildRollup([g], { season: 2026, crosswalk: { '00-0001': '111' } });
  assert.equal(r.players.find(p => p.gsis_id === '00-0001').espn_id, '111');
  assert.equal(r.players.find(p => p.gsis_id === '00-0002').identity, 'UNRESOLVED');
  assert.deepEqual(r.coverage.identity, { resolved: 1, unresolved: 1 });
});

test('crosswalk: two gsis ids claiming one ESPN id both stay unresolved', async () => {
  const csv = 'gsis_id,display_name,espn_id\n00-1,A,555\n00-2,B,555\n00-3,C,777\n00-4,D,NA\n';
  const fetchImpl = async () => new Response(csv);
  const xw = await fetchCrosswalk(['00-1', '00-2', '00-3', '00-4'], fetchImpl);
  assert.deepEqual(xw.map, { '00-3': '777' });
});

test('seasons never mix: another season\'s aggregate is ignored, not merged', () => {
  const r = buildRollup([game('G25', 18, 'KC', 'LV', { A: 30 }, {}, { season: 2025 }), game('G1', 1, 'KC', 'LV', { A: 5, B: 5 })], { season: 2026 });
  assert.equal(r.coverage.games_complete, 1);
  assert.equal(r.players.find(p => p.gsis_id === 'A').season.player.t, 5);
});

test('delayed publication: an incomplete game is excluded and listed', () => {
  const r = buildRollup([game('G1', 1, 'KC', 'LV', { A: 10 }), game('G2', 2, 'KC', 'DEN', { A: 20 }, {}, { complete: false })], { season: 2026 });
  assert.deepEqual(r.coverage.games_incomplete, ['G2']);
  assert.equal(r.data_through.week, 1);
  assert.equal(r.players[0].season.player.t, 10);
});

test('corrections: a re-delivered game replaces the earlier aggregate, idempotently', () => {
  const first = game('G1', 1, 'KC', 'LV', { A: 10, B: 10 });
  const corrected = game('G1', 1, 'KC', 'LV', { A: 9, B: 11 });
  const r1 = buildRollup([first, corrected], { season: 2026, generatedAt: 'T' });
  assert.equal(r1.players.find(p => p.gsis_id === 'A').season.player.t, 9);
  const r2 = buildRollup([first, corrected], { season: 2026, generatedAt: 'T' });
  assert.deepEqual(r1, r2, 'the same inputs always rebuild the same contract');
});

test('highlights: at most three, latest week only, resolved identities only — never padded', () => {
  const r = buildRollup([
    game('G1', 1, 'KC', 'LV', { A: 2, B: 2, C: 2, D: 2, X: 32 }),
    game('G2', 2, 'KC', 'DEN', { A: 12, B: 11, C: 10, D: 9, X: 0 })
  ], { season: 2026, crosswalk: { A: '1', B: '2', C: '3', D: '4', X: '5' } });
  assert.ok(r.highlights.length <= 3);
  const quiet = buildRollup([game('G1', 1, 'KC', 'LV', { A: 10 }), game('G2', 2, 'KC', 'DEN', { A: 10 })], { season: 2026, crosswalk: { A: '1' } });
  assert.deepEqual(quiet.highlights, [], 'fewer qualify -> fewer shown, down to none');
});

test('the contract declares unsupported metrics instead of approximating them', () => {
  const r = buildRollup([game('G1', 1, 'KC', 'LV', { A: 10 })], { season: 2026 });
  assert.ok(r.unsupported.snap_share && r.unsupported.route_participation);
  assert.equal(r.unsupported, UNSUPPORTED);
  const row = radarView(r).players[0];
  assert.ok(!('snap_share' in row) && !('snaps' in row.latest));
});

/* ---- pipeline: ingest -> rollup -> read ------------------------------------------ */

function r2() {
  const m = new Map();
  return { map: m, async put(k, v) { m.set(k, typeof v === 'string' ? v : String(v)); }, async get(k) { if (!m.has(k)) return null; const v = m.get(k); return { json: async () => JSON.parse(v) }; } };
}

test('streaming ingest writes an opportunity aggregate beside every Replay object', async () => {
  const csv = readFileSync(new URL('./fixtures/nflverse-pbp-2026-sample.csv', import.meta.url));
  const env = { REPLAY_R2: r2() };
  await streamIngest(env, 2026, { url: 'x', last_modified: 'L', etag: 'E' }, async () => new Response(gzipSync(csv)));
  const agg = JSON.parse(env.REPLAY_R2.map.get(oppGameKey(2026, '2026_01_SF_LA')));
  assert.equal(agg.game_id, '2026_01_SF_LA');
  assert.equal(agg.week, 1);
  assert.equal(agg.season_type, 'REG');
  assert.equal(agg.source.license, 'CC-BY-4.0');
});

test('read path: not yet published is a 200 state; ready serves radar and script views', async () => {
  const env = { REPLAY_R2: r2() };
  const nyp = await (await opportunity(env, new URL('https://x/api/replay/opportunity?season=2026'))).json();
  assert.equal(nyp.state, 'NOT_YET_PUBLISHED');
  const bad = await opportunity(env, new URL('https://x/api/replay/opportunity'));
  assert.equal(bad.status, 400, 'a season is never guessed');

  const g1 = game('2026_01_LV_KC', 1, 'KC', 'LV', { A: 10, B: 10 }, { R: 20 });
  const g2 = game('2026_02_DEN_KC', 2, 'KC', 'DEN', { A: 14, B: 6 }, { R: 18 });
  env.REPLAY_R2.map.set('replay/2026/index.json', JSON.stringify({ asset: { last_modified: 'L', etag: 'E' }, processed_at: 'P', games: { [g1.game_id]: {}, [g2.game_id]: {} } }));
  env.REPLAY_R2.map.set(oppGameKey(2026, g1.game_id), JSON.stringify(g1));
  env.REPLAY_R2.map.set(oppGameKey(2026, g2.game_id), JSON.stringify(g2));
  const built = await rebuildOpportunity(env, 2026, async () => new Response('gsis_id,espn_id\nA,100\nB,200\nR,300\n'));
  assert.equal(built.games, 2);
  assert.deepEqual(built.identity, { resolved: 3, unresolved: 1 }, 'the opponent receiver has no crosswalk row and stays unresolved');
  const radar = await opportunity(env, new URL('https://x/api/replay/opportunity?season=2026&team=kc'));
  assert.match(radar.headers.get('cache-control'), /max-age=300/);
  const body = await radar.json();
  assert.equal(body.state, 'READY');
  assert.equal(body.source.revision, 'E');
  assert.ok(body.players.every(p => p.team === 'KC'));
  const a = body.players.find(p => p.gsis === 'A');
  assert.equal(a.latest.ts, 70); assert.equal(a.prior.ts, 50); assert.equal(a.delta.ts, 20);
  const script = await (await opportunity(env, new URL('https://x/api/replay/opportunity?season=2026&view=script&team=KC'))).json();
  assert.equal(script.available, true);
  assert.equal(script.script.totals.targets, 40);
  const none = await (await opportunity(env, new URL('https://x/api/replay/opportunity?season=2026&view=script&team=NYJ'))).json();
  assert.equal(none.available, false);
});

test('rebuild refuses when an aggregate is missing rather than publishing a partial season', async () => {
  const env = { REPLAY_R2: r2() };
  env.REPLAY_R2.map.set('replay/2026/index.json', JSON.stringify({ games: { G1: {}, G2: {} } }));
  env.REPLAY_R2.map.set(oppGameKey(2026, 'G1'), JSON.stringify(game('G1', 1, 'KC', 'LV', { A: 1 })));
  await assert.rejects(rebuildOpportunity(env, 2026, async () => new Response('gsis_id,espn_id\n')), /opportunity_aggregates_missing:1/);
  assert.equal(env.REPLAY_R2.map.has(rollupKey(2026)), false);
});

test('script view carries state splits that add back to the season totals', () => {
  const r = buildRollup([game('G1', 1, 'KC', 'LV', { A: 10 }, { R: 10 })], { season: 2026 });
  const s = scriptView(r, 'KC').script;
  const sum = k => ['leading', 'trailing', 'balanced', 'unknown'].reduce((t, st) => t + s.states[st][k], 0);
  for (const k of ['plays', 'dropbacks', 'attempts', 'designed_runs', 'targets']) assert.equal(sum(k), s.totals[k], k);
});
