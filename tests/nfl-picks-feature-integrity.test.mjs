/* Picks engine: a feature that cannot be measured must not look measured.
 *
 * Two defects this pins:
 *   qb_tier   the grader read `body.injuries`, but /api/injuries answers
 *             { teams: [{ abbreviation, injuries: [...] }] }, so the tier map
 *             was always empty, qb_tier was null on every ratings row, and
 *             qb_tier_diff was 0 on every pick. The feed also speaks ESPN team
 *             codes (LAR/WSH) while ratings rows are keyed by nflverse codes
 *             (LA/WAS).
 *   line_move was hardcoded to 0 in the feature vector, which is the value a
 *             genuinely flat line would produce.
 *
 * The stored feature vector keeps exactly its declared keys and stays numeric,
 * because the tuner replays it and the receipt hashes it. Availability is
 * therefore recorded beside it, in the append-only audit detail.
 *
 *   node --test tests/nfl-picks-feature-integrity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const repo = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, repo), 'utf8');

const { qbTierMap } = await import('../workers/nfl-game-grader/src/index.js');
const { buildFeatureVector, FEATURE_ORDER, unavailableFeatures } = await import('../workers/nfl-picks-engine-shared/pick-math.mjs');

/* The shape /api/injuries actually returns (nfl-intel), not the one the grader
   used to expect. Abbreviations are ESPN's. */
const INJURY_RESPONSE = {
  ok: true,
  semantics: 'CURRENT_REPORTED',
  counts: { teams: 3, injuries: 4 },
  teams: [
    { abbreviation: 'LAR', injuries: [
      { athlete: { displayName: 'Starting QB' }, position: 'QB', status: 'Out' },
      { athlete: { displayName: 'A Receiver' }, position: 'WR', status: 'Questionable' },
    ] },
    { abbreviation: 'WSH', injuries: [{ athlete: { displayName: 'Backup QB' }, position: 'QB', status: 'Questionable' }] },
    { abbreviation: 'KC', injuries: [{ athlete: { displayName: 'A Guard' }, position: 'G', status: 'Out' }] },
  ],
};

function envWithInjuries(body) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('/api/injuries')) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { env: { NFL_GATEWAY: 'https://nfl-api.test' }, restore: () => { globalThis.fetch = real; } };
}

test('qb_tier: the grader reads the shape the injuries endpoint actually returns', async () => {
  const { env, restore } = envWithInjuries(INJURY_RESPONSE);
  try {
    const tiers = await qbTierMap(env);
    assert.notDeepEqual(tiers, {}, 'an empty map is the defect this test exists for');
    /* keyed by nflverse codes, because that is how ratings rows are keyed */
    assert.equal(tiers.LA, 4, 'an out QB is the highest availability tier');
    assert.equal(tiers.WAS, 3, 'a questionable QB');
    assert.equal(tiers.KC, undefined, 'a guard is not a quarterback');
  } finally { restore(); }
});

test('qb_tier: a feed that cannot be read leaves the tier unknown, never a middle value', async () => {
  for (const body of [{ ok: true, teams: [] }, { ok: false }, { teams: [{ abbreviation: 'LAR', injuries: [] }] }]) {
    const { env, restore } = envWithInjuries(body);
    try { assert.deepEqual(await qbTierMap(env), {}); } finally { restore(); }
  }
});

test('qb_tier_diff becomes non-zero when the supplied injury state warrants it', () => {
  const both = buildFeatureVector({ qb_tier_diff: 4 - 2, week: 3 });
  assert.equal(both.qb_tier_diff, 2);
  const none = buildFeatureVector({ qb_tier_diff: null, week: 3 });
  assert.equal(none.qb_tier_diff, 0, 'the stored vector stays numeric and replayable');
});

test('the stored vector keeps exactly its declared keys, all finite', () => {
  const v = buildFeatureVector({ week: 2 });
  assert.deepEqual(Object.keys(v).sort(), [...FEATURE_ORDER].sort());
  for (const key of FEATURE_ORDER) assert.ok(Number.isFinite(v[key]), key);
});

test('unavailable features are named, so a zero is never mistaken for a measurement', () => {
  const missing = unavailableFeatures({ off_epa_diff: 0.1, def_epa_diff: -0.2, qb_tier_diff: null, line_move: null, wind15: null, cold25: null, proe_diff: 0, pace_sum: 120 });
  assert.deepEqual(missing.sort(), ['cold25', 'line_move', 'qb_tier_diff', 'wind15']);

  const measured = unavailableFeatures({ off_epa_diff: 0.1, def_epa_diff: -0.2, qb_tier_diff: 0, line_move: 0, wind15: false, cold25: false, proe_diff: 0, pace_sum: 120 });
  assert.deepEqual(measured, [], 'a measured zero is not an unavailable feature');
});

test('the orchestrator records which features were unavailable on every issued pick', () => {
  const src = read('workers/nfl-game-picks-orchestrator/src/index.js');
  assert.match(src, /unavailableFeatures/, 'availability is computed');
  assert.match(src, /features_unavailable/, 'and recorded');
  /* it must not land in the hashed feature vector, which the receipt freezes */
  const start = src.indexOf('const features = buildFeatureVector({');
  const vectorArgs = src.slice(start, src.indexOf('});', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(vectorArgs.includes('features_unavailable'), false, 'availability must not enter the hashed vector');
  for (const key of ['qb_tier_diff', 'line_move', 'wind15', 'cold25']) {
    assert.ok(vectorArgs.includes(key), `${key} is still supplied to the vector`);
  }
});

test('weather that was never fetched is not recorded as calm', () => {
  const src = read('workers/nfl-game-picks-orchestrator/src/index.js');
  assert.match(src, /weather_observed/, 'the pick records whether a forecast was actually read');
  assert.equal(/wind15: !dome && weather\?\.wind_mph >= 15,/.test(src), false,
    'an absent forecast must not evaluate to false the way a calm day does');
});

test('line_move is no longer hardcoded to zero in the feature vector', () => {
  const src = read('workers/nfl-game-picks-orchestrator/src/index.js');
  assert.equal(/line_move: 0,/.test(src), false);
});

test('the new inputs are off until the owner turns them on, so live picks do not shift under a champion trained on zeros', () => {
  const src = read('workers/nfl-game-picks-orchestrator/src/index.js');
  assert.match(src, /PICKS_FEATURES_V2/, 'an explicit switch gates the repaired inputs');
  assert.match(read('workers/nfl-weight-tuner/src/index.js'), /INTEGRITY_TUNER_HOLD = true/, 'the tuner stays on hold');
});
