/* Option B: internal tracking vs official publication.
 *
 * The bootstrap path must let the loop earn its first 100 finalized grades
 * WITHOUT ever presenting untrained output to a customer, and without a
 * bypass. These tests pin every rule that makes that safe.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  issuanceScope, isCustomerFacing, championPublishable, isTrainedChampion,
  SCOPE_TRACKING, SCOPE_OFFICIAL, UNTRAINED_STATE,
} from '../champion.mjs';
import { gateStatus, MIN_GRADED_PICKS, MIN_DISTINCT_WEEKS } from '../../nfl-weight-tuner/src/index.js';
import { computeGrade } from '../../nfl-game-grader/src/index.js';
import { FEATURE_ORDER } from '../pick-math.mjs';

const UNTRAINED_V1 = {
  version: 1, promoted: true, notes: 'v1 priors, not trained',
  weights: { intercept: 0, coef: { home: 0.16 },
    meta: { source: 'hand_set_prior', trained: false, feature_order: ['home'] } },
};
const TRAINED_V2 = {
  version: 2, promoted: true,
  weights: { intercept: 0, coef: { home: 0.16 },
    meta: { source: 'trained_challenger', trained: true, feature_order: ['home'] } },
};

const migration = readFileSync(
  new URL('../../../migrations/nfl_picks_engine_v1.sql', import.meta.url), 'utf8');
const orchestrator = readFileSync(
  new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');
const grader = readFileSync(
  new URL('../../nfl-game-grader/src/index.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------------------
 * 1. Untrained may track; may never publish
 * --------------------------------------------------------------------- */

test('an untrained champion MAY issue tracking rows', () => {
  const issuance = issuanceScope(UNTRAINED_V1);
  assert.equal(issuance.canIssue, true);
  assert.equal(issuance.scope, SCOPE_TRACKING);
  assert.equal(issuance.mode, 'TRACKING_BOOTSTRAP');
});

test('an untrained champion creates ZERO official rows', () => {
  assert.notEqual(issuanceScope(UNTRAINED_V1).scope, SCOPE_OFFICIAL);
  assert.equal(championPublishable(UNTRAINED_V1).publishable, false);
});

test('official requires trained=true at issuance', () => {
  assert.equal(issuanceScope(TRAINED_V2).scope, SCOPE_OFFICIAL);
  for (const bad of [undefined, null, false, 0, 1, 'true', 'false', {}]) {
    const champion = { ...UNTRAINED_V1,
      weights: { ...UNTRAINED_V1.weights, meta: { trained: bad } } };
    assert.notEqual(issuanceScope(champion).scope, SCOPE_OFFICIAL,
      `trained=${JSON.stringify(bad)} must not issue official`);
  }
});

test('an unpromoted champion issues nothing at all', () => {
  const issuance = issuanceScope({ ...TRAINED_V2, promoted: false });
  assert.equal(issuance.canIssue, false);
  assert.equal(issuance.scope, null);
});

test('bootstrap mode reports validation-in-progress, not "no qualified picks"', () => {
  const state = issuanceScope(UNTRAINED_V1).state;
  assert.equal(state, UNTRAINED_STATE);
  assert.match(state, /MODEL VALIDATION IN PROGRESS/);
  assert.ok(!/no qualified/i.test(state));
});

/* ------------------------------------------------------------------------
 * 2. Tracking rows are graded and DO feed learning
 * --------------------------------------------------------------------- */

const trackingPick = {
  id: 'p-track', game_id: 'g1', season: 2026, week: 1, market: 'spread',
  side: 'SEA -2.5', market_line: -2.5, market_price: -110, market_prob: 0.5,
  model_prob: 0.58, stake_units: 1, status: 'open', model_version: 1,
  publication_scope: SCOPE_TRACKING,
  selection_team: 'SEA', side_is_home: true, selection_over_under: null,
  features: Object.fromEntries(FEATURE_ORDER.map(f => [f, 0])),
};

test('tracking rows grade exactly like official ones', () => {
  const g = computeGrade(trackingPick, { home_score: 27, away_score: 20 }, null);
  assert.equal(g.result, 'win');
  assert.ok(g.units_delta > 0);
  assert.ok(Number.isFinite(g.brier));
});

test('the grader carries publication_scope onto the learning observation', () => {
  assert.match(grader, /publication_scope:\s*pick\.publication_scope/);
});

test('tracking grades COUNT toward the tuner sample gate', () => {
  const rows = [];
  for (let i = 0; i < 100; i += 1) {
    rows.push({ season: 2026, week: (i % 4) + 1, publication_scope: SCOPE_TRACKING,
      clv_beat: true, outcome: 1, features: {}, model_prob: 0.6, units_delta: 1 });
  }
  const gate = gateStatus(rows);
  assert.equal(gate.open, true, 'bootstrap tracking sample must be able to open the gate');
  assert.equal(gate.graded, 100);
  assert.equal(gate.distinct_weeks, 4);
});

test('the loop can bootstrap from zero to the gate with no bypass', () => {
  // 99 tracking grades over 4 weeks: still shut.
  const near = [];
  for (let i = 0; i < 99; i += 1) {
    near.push({ season: 2026, week: (i % 4) + 1, publication_scope: SCOPE_TRACKING });
  }
  assert.equal(gateStatus(near).open, false);
  // The 100th opens it — by data alone.
  near.push({ season: 2026, week: 4, publication_scope: SCOPE_TRACKING });
  assert.equal(gateStatus(near).open, true);
  assert.equal(MIN_GRADED_PICKS, 100);
  assert.equal(MIN_DISTINCT_WEEKS, 4);
});

test('100 tracking grades inside a single week still cannot open the gate', () => {
  const rows = [];
  for (let i = 0; i < 150; i += 1) {
    rows.push({ season: 2026, week: 1, publication_scope: SCOPE_TRACKING });
  }
  assert.equal(gateStatus(rows).open, false);
  assert.match(gateStatus(rows).reason, /insufficient_weeks/);
});

/* ------------------------------------------------------------------------
 * 3. Tracking is never customer-facing
 * --------------------------------------------------------------------- */

test('isCustomerFacing accepts only official', () => {
  assert.equal(isCustomerFacing({ publication_scope: SCOPE_OFFICIAL }), true);
  assert.equal(isCustomerFacing({ publication_scope: SCOPE_TRACKING }), false);
  assert.equal(isCustomerFacing({}), false);
  assert.equal(isCustomerFacing(null), false);
  // A truthy-looking impostor must not slip through.
  assert.equal(isCustomerFacing({ publication_scope: 'OFFICIAL' }), false);
});

test('the current-picks query filters on publication_scope, not on trained', () => {
  assert.match(orchestrator, /publication_scope=eq\.\$\{SCOPE_OFFICIAL\}/,
    'read contract must filter scope in the query');
  // And it must not gate customer output on the champion's present flag.
  const readBlock = orchestrator.slice(
    orchestrator.indexOf('async function currentPicks'),
    orchestrator.indexOf('async function engineState'),
  );
  assert.match(readBlock, /filter\(isCustomerFacing\)/,
    'defence-in-depth filter missing');
});

test('the Verified Track Record is declared official-only', () => {
  assert.match(orchestrator, /verified_live_official_only/);
});

/* ------------------------------------------------------------------------
 * 4. Tracking can never become official
 * --------------------------------------------------------------------- */

test('the database freezes publication_scope on update', () => {
  assert.match(migration, /publication_scope is immutable after issuance/);
  assert.match(migration, /create trigger nfl_game_picks_freeze_issuance/);
  assert.match(migration, /before update on public\.nfl_game_picks/);
});

test('the database refuses an official insert without a trained champion', () => {
  assert.match(migration, /official picks require a promoted, trained champion/);
  assert.match(migration, /create trigger nfl_game_picks_official_requires_trained/);
  assert.match(migration, /before insert on public\.nfl_game_picks/);
  assert.match(migration, /weights -> 'meta' ->> 'trained'\) = 'true'/);
});

test('the database also freezes the economic terms of an issued pick', () => {
  assert.match(migration, /issued pick terms are immutable/);
  for (const field of ['market_line', 'market_price', 'model_version', 'features']) {
    assert.ok(migration.includes(field), `freeze trigger should cover ${field}`);
  }
});

test('no code path updates publication_scope after insert', () => {
  for (const src of [orchestrator, grader]) {
    const patches = src.match(/patch\(env, 'nfl_game_picks'[^;]*\}\)/gs) || [];
    for (const p of patches) {
      assert.equal(/publication_scope/.test(p), false,
        `a patch mutates publication_scope: ${p.slice(0, 120)}`);
    }
  }
});

/* ------------------------------------------------------------------------
 * 5. backtest != tracking != official
 * --------------------------------------------------------------------- */

test('the three concepts are distinct and never conflated', () => {
  assert.notEqual(SCOPE_TRACKING, SCOPE_OFFICIAL);
  // Only these two are storable classes; backtest is not one of them.
  assert.match(migration, /check \(publication_scope in \('tracking','official'\)\)/);
  assert.equal(/publication_scope in \([^)]*backtest/.test(migration), false,
    'backtest must never be a publication class');
});

test('the tuner never writes a pick row, so a backtest cannot become a record', () => {
  const tuner = readFileSync(
    new URL('../../nfl-weight-tuner/src/index.js', import.meta.url), 'utf8');
  assert.equal(/nfl_game_picks/.test(tuner), false,
    'the tuner must not write or classify picks');
});

test('no env, query or route can raise the issuance scope', () => {
  const src = readFileSync(new URL('../champion.mjs', import.meta.url), 'utf8');
  for (const pattern of [
    /env\./, /searchParams/, /process\.env/,
  ]) {
    assert.equal(pattern.test(src), false, `champion.mjs must not read ${pattern}`);
  }
  for (const pattern of [
    /env\.\w*FORCE\w*/i, /env\.\w*BYPASS\w*/i, /env\.\w*OFFICIAL\w*/i,
    /searchParams\.get\(['"]scope/i, /searchParams\.get\(['"]publish/i,
  ]) {
    assert.equal(pattern.test(orchestrator), false, `forbidden unlock: ${pattern}`);
  }
});
