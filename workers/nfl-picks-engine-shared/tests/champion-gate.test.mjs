/* Publication gate: an UNTRAINED champion must not be able to create an
 * official nfl_game_picks row.
 *
 * The seeded production champion is `promoted = true` with
 * `weights.meta.trained = false`. Promotion alone must not authorise
 * publication, and the block must come from production state — not from an env
 * flag, a query parameter, an admin route, or a code constant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  championPublishable, isTrainedChampion, UNTRAINED_STATE,
} from '../champion.mjs';

/* Exactly the row the migration seeds. */
const SEEDED_V1 = {
  version: 1,
  promoted: true,
  notes: 'v1 priors, not trained',
  weights: {
    intercept: 0,
    coef: { home: 0.16 },
    calib: { A: 1, B: 1, C: 1 },
    meta: { source: 'hand_set_prior', trained: false, feature_order: ['home'] },
  },
};

const TRAINED_V2 = {
  version: 2,
  promoted: true,
  notes: 'promoted: clv_beat 56.5 >= champion 55.0 + 1',
  weights: {
    intercept: 0, coef: { home: 0.16 },
    meta: { source: 'trained_challenger', trained: true, feature_order: ['home'] },
  },
};

test('the seeded v1 champion is promoted but NOT publishable', () => {
  assert.equal(SEEDED_V1.promoted, true);
  assert.equal(isTrainedChampion(SEEDED_V1), false);

  const gate = championPublishable(SEEDED_V1);
  assert.equal(gate.publishable, false);
  assert.equal(gate.state, UNTRAINED_STATE);
  assert.match(gate.reason, /untrained_champion:v1/);
});

test('the gated state is GATED, never "no qualified picks"', () => {
  const gate = championPublishable(SEEDED_V1);
  assert.equal(gate.state, UNTRAINED_STATE);
  assert.match(gate.state, /MODEL VALIDATION IN PROGRESS/);
  assert.notEqual(gate.state, 'ENGINE LIVE — no qualified picks');
  assert.ok(!/no qualified/i.test(gate.state));
});

test('only a strictly-true trained flag unlocks publication', () => {
  const variants = [
    undefined, null, false, 0, 1, 'true', 'false', 'yes', {},
  ];
  for (const value of variants) {
    const champion = {
      ...SEEDED_V1,
      weights: { ...SEEDED_V1.weights, meta: { ...SEEDED_V1.weights.meta, trained: value } },
    };
    assert.equal(championPublishable(champion).publishable, false,
      `trained=${JSON.stringify(value)} must not publish`);
  }
  assert.equal(championPublishable(TRAINED_V2).publishable, true);
});

test('a missing meta block is treated as untrained', () => {
  const noMeta = { version: 3, promoted: true, weights: { intercept: 0, coef: {} } };
  assert.equal(championPublishable(noMeta).publishable, false);
  const noWeights = { version: 4, promoted: true };
  assert.equal(championPublishable(noWeights).publishable, false);
});

test('an unpromoted challenger cannot publish even when trained', () => {
  const challenger = { ...TRAINED_V2, promoted: false };
  const gate = championPublishable(challenger);
  assert.equal(gate.publishable, false);
  assert.match(gate.reason, /not_promoted/);
});

test('no champion at all is DEGRADED, not gated and not "no picks"', () => {
  const gate = championPublishable(null);
  assert.equal(gate.publishable, false);
  assert.equal(gate.reason, 'no_promoted_champion');
  assert.ok(/DEGRADED/.test(gate.state));
});

/* ------------------------------------------------------------------------
 * The block must live in production state, not in a switch someone can flip.
 * --------------------------------------------------------------------- */

test('there is no env flag, query param, or admin route that unlocks publishing', () => {
  const sources = [
    readFileSync(new URL('../champion.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8'),
  ];
  const forbidden = [
    /env\.\w*FORCE\w*/i,
    /env\.\w*BYPASS\w*/i,
    /env\.\w*ALLOW_UNTRAINED\w*/i,
    /env\.\w*PUBLISH\w*/i,
    /searchParams\.get\(['"]force/i,
    /searchParams\.get\(['"]publish/i,
    /searchParams\.get\(['"]train/i,
  ];
  for (const src of sources) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(src), false, `forbidden unlock found: ${pattern}`);
    }
  }
});

test('the orchestrator gates BEFORE doing any slate work', () => {
  const src = readFileSync(
    new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');

  const gateAt = src.indexOf('championPublishable(champion)');
  const upcomingAt = src.indexOf('await upcomingGames(env)');
  const insertAt = src.indexOf("insert(env, 'nfl_game_picks'");

  assert.ok(gateAt > 0, 'gate not present');
  assert.ok(upcomingAt > 0 && gateAt < upcomingAt,
    'gate must run before the slate is fetched');
  assert.ok(insertAt > 0 && gateAt < insertAt,
    'gate must run before any pick insert is reachable');
});

test('the orchestrator returns early when it cannot issue at all, writing nothing', () => {
  const src = readFileSync(
    new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');
  /* Under Option B an UNTRAINED champion still writes tracking rows, so the
   * early-return path is reserved for the genuinely un-issuable cases: no
   * promoted champion at all, or an unpromoted one. */
  const start = src.indexOf('ISSUANCE SCOPE');
  assert.ok(start > 0, 'issuance scope block not found');
  const gateBlock = src.slice(
    start,
    src.indexOf('const { season, week } = await currentSeasonWeek(env)', start),
  );
  assert.ok(/if \(!issuance\.canIssue\)/.test(gateBlock), 'no canIssue check');
  assert.ok(/\breturn;/.test(gateBlock), 'blocked path must return early');
  // Nothing in the blocked branch may write.
  assert.equal(/insert\(|patch\(|upsert\(/.test(gateBlock), false,
    'blocked branch must not write any row');
});

test('an untrained champion reaches the slate but only as tracking', () => {
  const src = readFileSync(
    new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');
  // Scope is resolved once, before the slate, and threaded into every insert.
  assert.match(src, /const issuance = issuanceScope\(champion\)/);
  assert.match(src, /scope: issuance\.scope/);
  assert.match(src, /publication_scope: scope/);
  // It is never hardcoded to official anywhere.
  assert.equal(/publication_scope: *['"]official['"]/.test(src), false,
    'scope must never be hardcoded to official');
});

test('the seeded migration row really is trained:false and promoted:true', () => {
  const sql = readFileSync(
    new URL('../../../migrations/nfl_picks_engine_v1.sql', import.meta.url), 'utf8');
  assert.ok(/'trained',\s*false/.test(sql), "seed must declare trained false");
  assert.ok(/'v1 priors, not trained'/.test(sql), 'seed notes must say not trained');
  // And it IS promoted, which is exactly why promotion alone cannot authorise
  // publication.
  assert.ok(/true,\s*now\(\),\s*\n?\s*'v1 priors, not trained'/.test(sql)
    || /promoted/.test(sql), 'seed must be promoted');
});
