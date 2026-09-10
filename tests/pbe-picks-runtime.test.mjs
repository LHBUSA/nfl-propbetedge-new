/* The PBE Picks read contracts: runtime health never reads as healthy by
 * default, publication stays separate from health, and nothing a tracking
 * decision decided is exposed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeEngineState, matchupFromGameId, engineRuntime } from '../api/_pbe-engine-runtime.js';

const GATED = 'ENGINE GATED — MODEL VALIDATION IN PROGRESS';

test('health dominates publication: a dead engine is DEGRADED even when gated', () => {
  assert.equal(composeEngineState({ health: 'HEALTHY', trained: false, hasPicks: false, gatedState: GATED }), GATED);
  for (const health of ['STALE', 'UNKNOWN', 'DEGRADED']) {
    assert.equal(composeEngineState({ health, trained: false, hasPicks: false, gatedState: GATED }), 'ENGINE DEGRADED — source unavailable');
    assert.equal(composeEngineState({ health, trained: true, hasPicks: true, gatedState: GATED }), 'ENGINE DEGRADED — source unavailable');
  }
  assert.equal(composeEngineState({ health: 'HEALTHY', trained: true, hasPicks: false, gatedState: GATED }), 'ENGINE LIVE — NO QUALIFIED PBE PICKS');
  assert.equal(composeEngineState({ health: 'HEALTHY', trained: true, hasPicks: true, gatedState: GATED }), 'ENGINE LIVE — PICKS AVAILABLE');
});

test('an unreachable run ledger is UNKNOWN, never healthy', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const runtime = await engineRuntime(['nfl-game-picks-orchestrator']);
    assert.equal(runtime.health, 'UNKNOWN');
    assert.match(runtime.unavailable_reason, /run_ledger_unreachable/);
  } finally { globalThis.fetch = saved; }
});

test('a lane with no recorded run makes the engine STALE', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    lanes: [
      { lane: 'nfl-game-picks-orchestrator', critical: true, state: 'HEALTHY' },
      { lane: 'nfl-game-grader', critical: true, state: 'UNKNOWN' },
    ],
  }), { status: 200 });
  try {
    const runtime = await engineRuntime(['nfl-game-picks-orchestrator', 'nfl-game-grader']);
    assert.equal(runtime.health, 'STALE');
  } finally { globalThis.fetch = saved; }
});

test('matchup comes from the nflverse id, not a schedule lookup', () => {
  assert.deepEqual(matchupFromGameId('2026_01_SF_LA'), { game_id: '2026_01_SF_LA', season: 2026, week: 1, away_team: 'SF', home_team: 'LA' });
  assert.equal(matchupFromGameId('401872657'), null);
});

test('the state views expose decision COUNTS only, never tracking decision content', () => {
  const src = readFileSync(new URL('../api/pbe-picks.js', import.meta.url), 'utf8');
  const q = src.match(/sb\('nfl_game_picks', 'select=([^&']+)/)[1];
  assert.deepEqual(q.split(',').sort(), ['created_at', 'publication_scope', 'season', 'status']);
  const prop = readFileSync(new URL('../api/pbe-prop-picks.js', import.meta.url), 'utf8');
  assert.match(prop, /select=season,status,publication_scope&limit=5000/);
  // Season and week come from nfl-current, not a schedule file.
  assert.equal(/api\/schedule/.test(src), false);
});
