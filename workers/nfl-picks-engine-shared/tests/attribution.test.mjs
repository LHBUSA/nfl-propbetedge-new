/* Pre-C review regressions: canonical attribution, grading, CLV matching,
 * side-flip safety, scope transition, and ratings bootstrap.
 *
 * The defect class these pin down: inferring the selected side from a display
 * string, or defaulting a missing attribution to HOME. Either silently grades
 * an away pick against the wrong team.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeGrade } from '../../nfl-game-grader/src/index.js';
import { evaluate } from '../../nfl-game-picks-orchestrator/src/index.js';
import { blendSeasons, toRatingRows, ratingUsable } from '../ratings.mjs';
import { FEATURE_ORDER } from '../pick-math.mjs';

const migrationV2 = readFileSync(
  new URL('../../../migrations/nfl_picks_engine_v2_attribution.sql', import.meta.url), 'utf8');
const orchestrator = readFileSync(
  new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');
const grader = readFileSync(
  new URL('../../nfl-game-grader/src/index.js', import.meta.url), 'utf8');

const FEATURES = Object.fromEntries(FEATURE_ORDER.map(f => [f, 0]));

/* SEA (home) beat NE (away) 27-20 -> home margin +7. */
const FINAL = { home_score: 27, away_score: 20 };

function pick(over) {
  return {
    id: 'p', game_id: '2026_01_NE_SEA', season: 2026, week: 1,
    market_price: -110, market_prob: 0.5, model_prob: 0.58,
    stake_units: 1, status: 'open', model_version: 1,
    publication_scope: 'tracking', features: FEATURES, ...over,
  };
}

/* ------------------------------------------------------------------------
 * Grading: home vs away, both markets
 * --------------------------------------------------------------------- */

test('HOME spread grades against the home margin', () => {
  // SEA -3.5 at home, won by 7 -> covered.
  const g = computeGrade(pick({
    market: 'spread', side: 'SEA -3.5', market_line: -3.5,
    selection_team: 'SEA', side_is_home: true, selection_over_under: null,
  }), FINAL, null);
  assert.equal(g.result, 'win');
});

test('AWAY spread grades against the away margin, not the home one', () => {
  // NE +3.5 on the road, lost by 7 -> did NOT cover.
  const g = computeGrade(pick({
    market: 'spread', side: 'NE +3.5', market_line: 3.5,
    selection_team: 'NE', side_is_home: false, selection_over_under: null,
  }), FINAL, null);
  assert.equal(g.result, 'loss');
});

test('an away underdog that covers is graded a win', () => {
  // NE +10.5, lost by 7 -> covered.
  const g = computeGrade(pick({
    market: 'spread', side: 'NE +10.5', market_line: 10.5,
    selection_team: 'NE', side_is_home: false, selection_over_under: null,
  }), FINAL, null);
  assert.equal(g.result, 'win');
});

test('HOME moneyline wins, AWAY moneyline loses, on the same final', () => {
  const home = computeGrade(pick({
    market: 'moneyline', side: 'SEA ML', market_line: null,
    selection_team: 'SEA', side_is_home: true, selection_over_under: null,
  }), FINAL, null);
  const away = computeGrade(pick({
    market: 'moneyline', side: 'NE ML', market_line: null,
    selection_team: 'NE', side_is_home: false, selection_over_under: null,
  }), FINAL, null);
  assert.equal(home.result, 'win');
  assert.equal(away.result, 'loss');
  // The two must never agree — that was the old defect's signature.
  assert.notEqual(home.result, away.result);
});

test('totals grade from the stored OVER/UNDER, not the display string', () => {
  const over = computeGrade(pick({
    market: 'total', side: 'OVER 44.5', market_line: 44.5,
    selection_team: null, side_is_home: null, selection_over_under: 'OVER',
  }), FINAL, null);           // 47 points
  const under = computeGrade(pick({
    market: 'total', side: 'UNDER 44.5', market_line: 44.5,
    selection_team: null, side_is_home: null, selection_over_under: 'UNDER',
  }), FINAL, null);
  assert.equal(over.result, 'win');
  assert.equal(under.result, 'loss');
});

/* ------------------------------------------------------------------------
 * Fail closed
 * --------------------------------------------------------------------- */

test('missing side_is_home FAILS CLOSED instead of defaulting to home', () => {
  for (const bad of [undefined, null, 'true', 1, 0]) {
    assert.throws(() => computeGrade(pick({
      market: 'spread', side: 'NE +3.5', market_line: 3.5,
      selection_team: 'NE', side_is_home: bad, selection_over_under: null,
    }), FINAL, null), /missing_attribution:side_is_home/,
      `side_is_home=${JSON.stringify(bad)} must fail closed`);
  }
});

test('missing selection_team fails closed on a team market', () => {
  assert.throws(() => computeGrade(pick({
    market: 'spread', side: 'NE +3.5', market_line: 3.5,
    selection_team: null, side_is_home: false, selection_over_under: null,
  }), FINAL, null), /missing_attribution:selection_team/);
});

test('missing OVER/UNDER fails closed on a total', () => {
  assert.throws(() => computeGrade(pick({
    market: 'total', side: 'OVER 44.5', market_line: 44.5,
    selection_team: null, side_is_home: null, selection_over_under: null,
  }), FINAL, null), /missing_attribution:selection_over_under/);
});

test('the grader contains no !== false attribution default', () => {
  assert.equal(/side_is_home\s*!==\s*false/.test(grader), false,
    'the unsafe default is back');
});

/* ------------------------------------------------------------------------
 * CLV matches canonically, even when the line moved
 * --------------------------------------------------------------------- */

test('a moved line still attaches to the correct team side', () => {
  // Took SEA -2.5; market closed SEA -3.5. Display strings differ.
  const g = computeGrade(pick({
    market: 'spread', side: 'SEA -2.5', market_line: -2.5,
    selection_team: 'SEA', side_is_home: true, selection_over_under: null,
  }), FINAL, { line: -3.5, price: -110, opposite_price: -110 });
  // Positive CLV: we beat the close by a point.
  assert.equal(g.clv_points, 1);
});

test('closingFor matches on team / over_under, never on the side string', () => {
  const block = grader.slice(grader.indexOf('async function closingFor'),
    grader.indexOf('function errorClass'));
  assert.match(block, /r\.team === team/);
  assert.match(block, /over_under/);
  // The old string match and the rows[0] fallback must both be gone.
  assert.equal(/r\.side === pick\.side/.test(block), false, 'string matching returned');
  assert.equal(/\|\| rows\[0\]/.test(block), false, 'rows[0] fallback returned');
  assert.match(block, /if \(!mine\) return null;/);
});

test('a missing closing selection yields null CLV, never a fallback', () => {
  const g = computeGrade(pick({
    market: 'spread', side: 'SEA -2.5', market_line: -2.5,
    selection_team: 'SEA', side_is_home: true, selection_over_under: null,
  }), FINAL, null);
  assert.equal(g.clv_points, null);
  assert.equal(g.clv_prob, null);
  assert.equal(g.clv_beat, null);
});

/* ------------------------------------------------------------------------
 * Orchestrator propagates attribution from the quote
 * --------------------------------------------------------------------- */

const RATINGS = new Map([
  ['SEA', { status: 'ok', off_epa_play: 0.12, def_epa_play: -0.05, proe: 0.03, pace: 64, qb_tier: 1 }],
  ['NE', { status: 'ok', off_epa_play: -0.04, def_epa_play: 0.02, proe: -0.01, pace: 61, qb_tier: 2 }],
]);
const GAME = { game_id: '2026_01_NE_SEA', home_team: 'SEA', away_team: 'NE',
  kickoff_ts: '2026-09-09T20:20:00Z', rest_home: 7, rest_away: 7 };
const CHAMPION = { version: 1, weights: { intercept: 0, coef: { home: 0.16 },
  meta: { feature_order: ['home'] } } };

test('evaluate carries canonical attribution from the quote', () => {
  const away = evaluate({
    game: GAME, market: 'spread',
    quote: { side: 'NE +3.5', line: 3.5, price: -110, opposite_price: -110,
      line_move: 0, selected_is_home: false, team: 'NE', over_under: null },
    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 1,
  });
  assert.equal(away.selection_team, 'NE');
  assert.equal(away.side_is_home, false);
  assert.equal(away.selection_over_under, null);

  const total = evaluate({
    game: GAME, market: 'total',
    quote: { side: 'OVER 44.5', line: 44.5, price: -110, opposite_price: -110,
      line_move: 0, selected_is_home: false, team: null, over_under: 'OVER' },
    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 1,
  });
  assert.equal(total.selection_team, null);
  assert.equal(total.side_is_home, null);
  assert.equal(total.selection_over_under, 'OVER');
});

test('the orchestrator persists all three attribution fields', () => {
  assert.match(orchestrator, /selection_team: decision\.selection_team/);
  assert.match(orchestrator, /selection_over_under: decision\.selection_over_under/);
  assert.match(orchestrator, /side_is_home: decision\.side_is_home/);
});

/* ------------------------------------------------------------------------
 * Side flip must be atomic against one_open_pick_per_market
 * --------------------------------------------------------------------- */

test('the flip supersedes and inserts inside one transaction', () => {
  assert.match(migrationV2, /create or replace function public\.nfl_replace_open_pick/);
  const fn = migrationV2.slice(migrationV2.indexOf('nfl_replace_open_pick'),
    migrationV2.indexOf('-- 4. Tracking-scoped audit events'));
  // Supersede must precede the insert inside the function body.
  const supersedeAt = fn.indexOf("set status = 'superseded'");
  const insertAt = fn.indexOf('insert into public.nfl_game_picks');
  assert.ok(supersedeAt > 0 && insertAt > 0 && supersedeAt < insertAt,
    'must supersede before inserting');
  assert.match(fn, /for update/, 'incumbent must be locked');
  assert.match(fn, /cannot replace a % pick with a % pick/,
    'a replacement must not change publication class');
});

test('the orchestrator no longer inserts before superseding', () => {
  const block = orchestrator.slice(orchestrator.indexOf('const sideFlipped'),
    orchestrator.indexOf('if (!decision.qualifies && decision.edge_pct < KILL_THRESHOLD)'));
  assert.match(block, /rpc\(env, 'nfl_replace_open_pick'/);
  assert.equal(/insert\(env, 'nfl_game_picks'/.test(block), false,
    'direct insert on the flip path would violate the unique index');
});

/* ------------------------------------------------------------------------
 * tracking -> official transition
 * --------------------------------------------------------------------- */

test('an open tracking pick is drained, not kept and not reclassified', () => {
  const block = orchestrator.slice(orchestrator.indexOf('SCOPE TRANSITION'),
    orchestrator.indexOf('const sideFlipped'));
  assert.match(block, /open\.publication_scope !== scope/);
  assert.match(block, /tally\.scope_drain = 1/);
  assert.match(block, /return tally;/);
  // The drain branch must not write anything at all.
  assert.equal(/insert\(|patch\(|rpc\(|upsert\(/.test(block), false,
    'the drain branch must not write');
});

test('a scope mismatch never counts as "kept"', () => {
  const block = orchestrator.slice(orchestrator.indexOf('SCOPE TRANSITION'),
    orchestrator.indexOf('const sideFlipped'));
  assert.equal(/tally\.kept/.test(block), false);
});

/* ------------------------------------------------------------------------
 * Ratings bootstrap
 * --------------------------------------------------------------------- */

test('a prior-only baseline is written at as_of_week = 0', () => {
  const current = new Map();
  const prior = new Map([['SEA', { team: 'SEA', status: 'ok', off_epa_play: 0.1, def_epa_play: -0.02 }]]);
  const blended = blendSeasons({ current, prior, week: 1 });
  assert.equal(blended.get('SEA').status, 'prior_only');

  const rows = toRatingRows(blended, { season: 2026, asOfWeek: 0, sourceTimestamp: 'T' });
  assert.equal(rows[0].as_of_week, 0);
  assert.equal(rows[0].status, 'prior_only');
  assert.equal(rows[0].source_timestamp, 'T');
  // Usable, but honestly labelled as last season's data.
  assert.equal(ratingUsable(rows[0]).usable, true);
  // And no current-season metric is invented.
  assert.equal(rows[0].off_epa_play, 0.1);
});

test('a real regular week outranks the week-0 baseline', () => {
  const baseline = toRatingRows(
    new Map([['SEA', { team: 'SEA', status: 'prior_only', off_epa_play: 0.1, def_epa_play: 0 }]]),
    { season: 2026, asOfWeek: 0, sourceTimestamp: 'T' })[0];
  const week1 = toRatingRows(
    new Map([['SEA', { team: 'SEA', status: 'ok', off_epa_play: 0.3, def_epa_play: 0 }]]),
    { season: 2026, asOfWeek: 1, sourceTimestamp: 'T' })[0];
  // The orchestrator orders by as_of_week desc, so week 1 wins.
  assert.ok(week1.as_of_week > baseline.as_of_week);
});

test('preseason finals cannot advance the regular-season week', () => {
  const block = grader.slice(grader.indexOf('async function completedSeasonWeek'),
    grader.indexOf('async function qbTierMap'));
  assert.match(block, /game_type/);
  assert.match(block, /=== 'REG'/);
  assert.match(block, /scores_missing_game_type/, 'must fail closed without game_type');
});

test('the baseline pass uses no current-season plays', () => {
  const block = grader.slice(grader.indexOf('async function refreshRatings'),
    grader.indexOf('async function completedSeasonWeek'));
  assert.match(block, /const isBaseline = week === 0/);
  assert.match(block, /!isBaseline && current/);
});

/* ------------------------------------------------------------------------
 * Audit semantics
 * --------------------------------------------------------------------- */

test('a finalized tracking pick cannot be labelled official_final_result', () => {
  const block = grader.slice(grader.indexOf('const scope = pick.publication_scope'),
    grader.indexOf('if (pick.status !== \'graded\')'));
  assert.match(block, /scope === 'official' \? 'official_final_result' : 'tracking_final_result'/);
});

test('the database accepts the tracking_final_result event type', () => {
  assert.match(migrationV2, /'tracking_final_result'/);
  assert.match(migrationV2, /nfl_pick_audit_events_event_type_check/);
});

/* ------------------------------------------------------------------------
 * Migration shape
 * --------------------------------------------------------------------- */

test('v2 is additive and freezes the new attribution fields', () => {
  assert.match(migrationV2, /add column if not exists selection_team/);
  assert.match(migrationV2, /add column if not exists selection_over_under/);
  assert.match(migrationV2, /add column if not exists side_is_home/);
  const freeze = migrationV2.slice(migrationV2.indexOf('freeze_issuance()'),
    migrationV2.indexOf('-- 3. Atomic side-flip'));
  for (const f of ['selection_team', 'selection_over_under', 'side_is_home']) {
    assert.ok(freeze.includes(f), `freeze trigger must cover ${f}`);
  }
});

test('attribution is required per market by a database constraint', () => {
  assert.match(migrationV2, /nfl_game_picks_selection_attribution/);
  const c = migrationV2.slice(migrationV2.indexOf('nfl_game_picks_selection_attribution check'),
    migrationV2.indexOf('-- 2. Extend the issuance freeze'));
  assert.match(c, /market in \('spread','moneyline'\)/);
  assert.match(c, /selection_team is not null/);
  assert.match(c, /side_is_home is not null/);
  assert.match(c, /market = 'total'/);
  assert.match(c, /selection_over_under in \('OVER','UNDER'\)/);
});

/* ------------------------------------------------------------------------
 * Observability: ratings failure vs grading failure must be distinguishable
 * --------------------------------------------------------------------- */

test('health exposes last_ratings_error_class separately from last_error_class', () => {
  assert.match(grader, /last_ratings_error_class:\s*null/, 'must be initialized');
  assert.match(grader, /last_ratings_error_class:\s*health\.last_ratings_error_class \|\| null/,
    'must be exposed on /health');
});

test('a successful ratings refresh clears any previous ratings error', () => {
  const block = grader.slice(grader.indexOf("let ratings = 'skipped'"),
    grader.indexOf('health.last_result = `graded='));
  assert.match(block, /health\.last_ratings_error_class = null/, 'must clear on success');
  assert.match(block, /health\.last_ratings_error_class = errorClass\(error\)/,
    'must record the class on failure');
  // The two error channels stay independent.
  assert.equal(/health\.last_error_class = errorClass\(error\)/.test(block), false,
    'a ratings failure must not overwrite the grading error class');
});

test('the grader still exposes no manual grading trigger', () => {
  const routes = grader.match(/url\.pathname === '[^']+'/g) || [];
  assert.deepEqual(routes, ["url.pathname === '/health'"],
    'only /health may be routed; a grading trigger would be a bypass');
  assert.equal(/runGrading\(env\)/.test(grader.slice(grader.indexOf('async fetch'),
    grader.indexOf('async scheduled'))), false,
    'fetch() must never invoke grading');
});
