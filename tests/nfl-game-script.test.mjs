/* Game Script Lab calculation core (game-script-core-v1.js), fed by the
 * real opportunity contract path: aggregateGame -> buildRollup -> scriptView. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateGame, buildRollup, scriptView } from '../workers/nfl-replay/src/opportunity.js';
await import('../game-script-core-v1.js');
const G = globalThis.PBEGameScriptCore;

let pid = 1;
const P = (team, diff, extra) => ({ play_id: pid++, posteam: team, qtr: 1, score_differential: diff, yardline_100: 50, ...extra });
const pass = (team, diff, rec) => P(team, diff, { play_type: 'pass', qb_dropback: true, pass_attempt: true, receiver_player_id: rec, receiver_player_name: rec });
const run = (team, diff, rusher) => P(team, diff, { play_type: 'run', rush_attempt: true, rusher_player_id: rusher, rusher_player_name: rusher });
const scramble = (team, diff) => P(team, diff, { play_type: 'run', rush_attempt: true, qb_scramble: true, qb_dropback: true, rusher_player_id: 'QB', rusher_player_name: 'QB' });
const sack = (team, diff) => P(team, diff, { play_type: 'pass', qb_dropback: true, pass_attempt: true, sack: true });

/* KC: trailing -> pass heavy, leading -> run heavy, balanced in between. */
function kcGame(id, week) {
  const plays = [];
  const add = (n, f) => { for (let i = 0; i < n; i++) plays.push(f()); };
  add(10, () => pass('KC', -10, 'WR1')); add(5, () => pass('KC', -10, 'TE1')); add(2, () => pass('KC', -10, null));
  add(2, () => sack('KC', -10)); add(2, () => scramble('KC', -10)); add(4, () => run('KC', -10, 'RB1'));
  add(3, () => pass('KC', 10, 'WR1')); add(1, () => pass('KC', 10, 'TE1')); add(10, () => run('KC', 10, 'RB1')); add(4, () => run('KC', 10, 'RB2'));
  add(6, () => pass('KC', 0, 'WR1')); add(3, () => pass('KC', 0, 'RB1')); add(1, () => sack('KC', 0)); add(6, () => run('KC', 0, 'RB1')); add(2, () => run('KC', 0, 'QB'));
  plays.push({ play_id: pid++, qtr: 4, game_seconds_remaining: 0 });
  return aggregateGame(Object.fromEntries(plays.map(p => [p.play_id, p])), { game_id: id, season: '2026', season_type: 'REG', week: String(week), home_team: 'KC', away_team: 'LV' });
}
const rollup = buildRollup([kcGame('G1', 1), kcGame('G2', 2), kcGame('G3', 3), kcGame('G4', 4)], { season: 2026 });
const script = scriptView(rollup, 'KC').script;

test('baseline reproduces the team\'s observed per-game volume and pass rate', () => {
  const r = G.compute(script, G.baselineInputs(script));
  assert.equal(r.available, true);
  assert.equal(r.team.plays, script.totals.plays / script.games);
  assert.ok(Math.abs(r.team.pass_rate - script.totals.dropbacks / script.totals.plays) < 1e-12);
  assert.equal(r.label, 'Scenario estimate — not an official PBE prediction.');
  assert.deepEqual(G.validate(r), []);
});

test('identical inputs always give identical results', () => {
  const inputs = { state: 'trailing', volume: 66, pass_rate: 0.7 };
  assert.deepEqual(G.compute(script, inputs), G.compute(script, { ...inputs }));
});

test('invariants hold across the whole input grid: nonnegative, bounded, conserved', () => {
  let n = 0;
  for (const state of G.STATES) for (let volume = 40; volume <= 90; volume += 5) for (const pass_rate of [null, 0.25, 0.4, 0.55, 0.7, 0.85]) {
    const r = G.compute(script, { state, volume, pass_rate });
    if (!r.available) continue;
    assert.deepEqual(G.validate(r), [], `${state} ${volume} ${pass_rate}`);
    n++;
  }
  assert.ok(n > 200, `grid covered ${n} scenarios`);
});

test('sensitivity: volume scales every opportunity; pass rate trades runs for targets', () => {
  const a = G.compute(script, { state: 'baseline', volume: 60, pass_rate: 0.5 });
  const b = G.compute(script, { state: 'baseline', volume: 70, pass_rate: 0.5 });
  assert.ok(b.team.targets > a.team.targets && b.team.designed_runs > a.team.designed_runs);
  assert.ok(Math.abs(b.team.targets / a.team.targets - 70 / 60) < 1e-9, 'proportional in volume');
  const c = G.compute(script, { state: 'baseline', volume: 60, pass_rate: 0.7 });
  assert.ok(c.team.targets > a.team.targets && c.team.designed_runs < a.team.designed_runs);
});

test('state rates matter: trailing passes more than leading at the same volume', () => {
  const trail = G.compute(script, { state: 'trailing', volume: 62, pass_rate: null });
  const lead = G.compute(script, { state: 'leading', volume: 62, pass_rate: null });
  assert.ok(trail.team.pass_rate > lead.team.pass_rate);
  assert.ok(trail.team.targets > lead.team.targets);
  assert.ok(lead.team.designed_runs > trail.team.designed_runs);
  assert.ok(trail.players.targets.rows.find(r => r.gsis === 'WR1').value > 0);
  assert.equal(lead.players.targets.available, false, '16 leading targets is below the player floor: no allocation, stated reason');
  assert.match(lead.players.targets.reason, /Only 16 targets/);
});

test('scrambles are the quarterback\'s: never allocated as carries to anyone', () => {
  const r = G.compute(script, { state: 'trailing', volume: 62, pass_rate: null });
  assert.ok(r.team.scrambles > 0);
  assert.ok(!r.players.carries.available || !r.players.carries.rows.some(x => x.gsis === 'QB' && x.value > 0 && script.players.find(p => p.gsis_id === 'QB').st.trailing.c === 0));
  const qbDesigned = G.compute(script, { state: 'balanced', volume: 62, pass_rate: null });
  const qb = qbDesigned.players.carries.rows.find(x => x.gsis === 'QB');
  const expectedShare = script.players.find(p => p.gsis_id === 'QB').st.balanced.c / qbDesigned.players.carries.sample;
  assert.ok(qb && Math.abs(qb.share - expectedShare) < 1e-12, 'only his designed runs count');
});

test('not every dropback becomes a target: sacks, scrambles and untargeted attempts stay visible', () => {
  const r = G.compute(script, { state: 'trailing', volume: 62, pass_rate: null });
  assert.ok(r.team.targets < r.team.dropbacks);
  assert.ok(r.team.untargeted_attempts > 0 && r.team.sacks > 0 && r.team.scrambles > 0);
  assert.ok(Math.abs(r.team.targets + r.team.untargeted_attempts + r.team.sacks + r.team.scrambles + r.team.other_dropbacks - r.team.dropbacks) < 1e-9);
});

test('too few plays in a state: the scenario is unavailable, never extrapolated', () => {
  const thin = scriptView(buildRollup([kcGame('G1', 1)], { season: 2026 }), 'KC').script;
  thin.states.leading = { ...thin.states.leading, plays: 20 };
  const r = G.compute(thin, { state: 'leading', volume: 60 });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'STATE_SAMPLE_TOO_SMALL');
  assert.match(r.detail, /at least 60/);
});

test('thin player sample: team scenario stays usable, player allocation says why not', () => {
  const s = JSON.parse(JSON.stringify(script));
  for (const p of s.players) { p.st.leading.t = Math.min(p.st.leading.t, 1); }
  s.states.leading.targets = s.players.reduce((t, p) => t + p.st.leading.t, 0);
  const r = G.compute(s, { state: 'leading', volume: 60 });
  assert.equal(r.available, true);
  assert.equal(r.players.targets.available, false);
  assert.match(r.players.targets.reason, /team numbers above still apply/);
  assert.ok(r.team.targets > 0);
});

test('inputs are clamped to the documented bounds', () => {
  const r = G.compute(script, { state: 'bogus', volume: 500, pass_rate: 2 });
  assert.deepEqual(r.inputs, { state: 'baseline', volume: 90, pass_rate: 0.85 });
  assert.equal(G.compute(script, { volume: -3 }).inputs.volume, 40);
});

test('the validator catches a broken result', () => {
  const r = G.compute(script, G.baselineInputs(script));
  const broken = JSON.parse(JSON.stringify(r));
  broken.players.targets.rows[0].value += 1;
  assert.ok(G.validate(broken).includes('targets_not_conserved'));
  broken.team.sacks = -1;
  assert.ok(G.validate(broken).includes('negative_or_nan:sacks'));
});

test('the core carries no forbidden claims', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../game-script-core-v1.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/win_prob|touchdown|confidence|simulat|Math\.random/i.test(src));
});
