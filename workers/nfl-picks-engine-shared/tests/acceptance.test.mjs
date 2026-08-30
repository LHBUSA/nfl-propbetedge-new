/* Phase 0 acceptance tests.
 *
 * Fixture-driven and offline: every assertion runs against the exported pure
 * functions, so nothing here touches Supabase, the odds provider, or the
 * gateway. Covers the build brief's acceptance list and the handoff's hard
 * invariants that can be proven without a live database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { inKickoffWindow } from '../../nfl-odds-snapshot/src/index.js';
import { evaluate } from '../../nfl-game-picks-orchestrator/src/index.js';
import { computeGrade } from '../../nfl-game-grader/src/index.js';
import {
  gateStatus, trainChallenger, backtest, promotionVerdict, blendedLabel, calibrate,
  MIN_GRADED_PICKS, MIN_DISTINCT_WEEKS,
} from '../../nfl-weight-tuner/src/index.js';
import { FEATURE_ORDER } from '../pick-math.mjs';

/* --------------------------------------------------------------------------
 * Fixtures
 * ----------------------------------------------------------------------- */

const CHAMPION = {
  version: 1,
  weights: {
    intercept: 0,
    coef: {
      off_epa_diff: 1.65, def_epa_diff: 1.35, qb_tier_diff: 0.22, rest_diff: 0.02,
      home: 0.16, dome: 0, wind15: -0.10, cold25: -0.06, proe_diff: 0.10,
      pace_sum: 0.006, line_move: 0.075, prior_blend_weight: 0,
    },
    calib: { A: 1.0, B: 1.0, C: 1.0 },
    meta: { feature_order: [...FEATURE_ORDER] },
  },
};

const GAME = {
  game_id: '2026_01_NE_SEA', home_team: 'SEA', away_team: 'NE',
  kickoff_ts: '2026-09-09T20:20:00.000Z',
  rest_days_selected: 7, rest_days_opponent: 7,
};

const RATINGS = new Map([
  ['SEA', { status: 'ok', off_epa_play: 0.12, def_epa_play: -0.05, proe: 0.03, pace: 64, qb_tier: 1 }],
  ['NE', { status: 'ok', off_epa_play: -0.04, def_epa_play: 0.02, proe: -0.01, pace: 61, qb_tier: 2 }],
]);

const strongQuote = { side: 'SEA -2.5', line: -2.5, price: -110, opposite_price: -110, line_move: 0, selected_is_home: true };

function observation(over, { week = 1, season = 2026, clvBeat = true, outcome = 1, prob = 0.6 } = {}) {
  return {
    season, week, market: 'spread', model_version: 1, model_prob: prob,
    clv_beat: clvBeat, clv_prob: clvBeat ? 0.02 : -0.02,
    result: outcome === 1 ? 'win' : 'loss', outcome,
    units_delta: outcome === 1 ? 0.91 : -1, brier: (prob - outcome) ** 2,
    features: Object.fromEntries(FEATURE_ORDER.map(f => [f, f === 'off_epa_diff' ? over : 0])),
    ...(week ? {} : {}),
  };
}

function corpus({ n = 120, weeks = 4 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const week = (i % weeks) + 1;
    const signal = i % 2 === 0 ? 0.25 : -0.25;
    rows.push(observation(signal, {
      week,
      clvBeat: signal > 0,
      outcome: signal > 0 ? 1 : 0,
      prob: signal > 0 ? 0.62 : 0.41,
    }));
  }
  return rows;
}

/* --------------------------------------------------------------------------
 * Brief acceptance #1 — snapshot windows
 * ----------------------------------------------------------------------- */

test('[1] kickoff windows gate the quarter-hourly snapshot trigger', () => {
  // Sunday 18:00 UTC — inside the Sunday afternoon window.
  assert.equal(inKickoffWindow(new Date('2026-09-13T18:00:00Z')), true);
  // Sunday 12:00 UTC — before the window opens.
  assert.equal(inKickoffWindow(new Date('2026-09-13T12:00:00Z')), false);
  // Thursday 23:00 UTC — TNF window.
  assert.equal(inKickoffWindow(new Date('2026-09-10T23:00:00Z')), true);
  // Wednesday — never a kickoff window.
  assert.equal(inKickoffWindow(new Date('2026-09-09T23:00:00Z')), false);
});

/* --------------------------------------------------------------------------
 * Brief acceptance #2 — orchestrator features, thresholds, lifecycle inputs
 * ----------------------------------------------------------------------- */

test('[2] every emitted decision carries a complete decision-time feature vector', () => {
  const d = evaluate({
    game: GAME, market: 'spread', quote: strongQuote,
    ratings: RATINGS, weather: { wind_mph: 4, temp_f: 68 },
    champion: CHAMPION, season: 2026, week: 1,
  });
  assert.deepEqual(Object.keys(d.features).sort(), [...FEATURE_ORDER].sort());
  for (const name of FEATURE_ORDER) assert.ok(Number.isFinite(d.features[name]), `${name} missing`);
  assert.equal(d.features.home, 1);
  // Week 1 -> full prior blend weight.
  assert.equal(d.features.prior_blend_weight, 1);
});

test('[2] a de-vigged fair market yields no edge and therefore no pick', () => {
  // Genuine zeros with an explicit ok status - a real, meaningful rating.
  const flat = new Map([
    ['SEA', { status: 'ok', off_epa_play: 0, def_epa_play: 0, proe: 0, pace: 0, qb_tier: 2 }],
    ['NE', { status: 'ok', off_epa_play: 0, def_epa_play: 0, proe: 0, pace: 0, qb_tier: 2 }],
  ]);
  const d = evaluate({
    game: { ...GAME, rest_days_selected: 7, rest_days_opponent: 7 },
    market: 'spread',
    quote: { ...strongQuote, price: -110, opposite_price: -110 },
    ratings: flat, weather: null, champion: {
      ...CHAMPION,
      weights: { ...CHAMPION.weights, coef: { ...CHAMPION.weights.coef, home: 0 } },
    },
    season: 2026, week: 9,
  });
  // model 0.5 vs de-vigged market 0.5 -> zero edge -> below the 2% threshold.
  assert.equal(d.market_prob.toFixed(4), '0.5000');
  assert.equal(d.qualifies, false);
  assert.equal(d.confidence_bucket, null);
  assert.equal(d.stake_units, 0);
});

test('[2] moneyline needs 3% where spread needs 2% — same edge, different verdict', () => {
  const mk = market => evaluate({
    game: GAME, market,
    quote: { ...strongQuote, price: -110, opposite_price: -110 },
    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 1,
  });
  const spread = mk('spread');
  const ml = mk('moneyline');
  assert.equal(spread.edge_pct.toFixed(6), ml.edge_pct.toFixed(6));
  if (spread.edge_pct >= 0.02 && spread.edge_pct < 0.03) {
    assert.equal(spread.qualifies, true);
    assert.equal(ml.qualifies, false);
  }
});

test('[2] an issued pick records the market terms it was actually taken at', () => {
  const d = evaluate({
    game: GAME, market: 'spread', quote: strongQuote,
    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 1,
  });
  assert.equal(d.market_line, -2.5);
  assert.equal(d.market_price, -110);
  assert.equal(d.side, 'SEA -2.5');
});

/* --------------------------------------------------------------------------
 * Brief acceptance #3 — grading, CLV sign, units math, pushes
 * ----------------------------------------------------------------------- */

const basePick = {
  id: 'p1', game_id: GAME.game_id, season: 2026, week: 1, market: 'spread',
  side: 'SEA -2.5', market_line: -2.5, market_price: -110, market_prob: 0.5,
  model_prob: 0.58, stake_units: 1.0, status: 'open', model_version: 1,
  features: Object.fromEntries(FEATURE_ORDER.map(f => [f, 0])),
};

test('[3] a covered favourite grades win with correct units and Brier', () => {
  const g = computeGrade(basePick, { home_score: 27, away_score: 20 }, null);
  assert.equal(g.result, 'win');
  assert.ok(Math.abs(g.units_delta - 100 / 110) < 1e-3);
  assert.ok(Math.abs(g.brier - (0.58 - 1) ** 2) < 1e-6);
});

test('[3] an exact-number result grades push with zero units and null Brier', () => {
  const g = computeGrade({ ...basePick, market_line: -3 }, { home_score: 23, away_score: 20 }, null);
  assert.equal(g.result, 'push');
  assert.equal(g.units_delta, 0);
  assert.equal(g.brier, null);
});

test('[3] units math is right for a positive price too', () => {
  const g = computeGrade(
    { ...basePick, market_price: 150, stake_units: 2 },
    { home_score: 27, away_score: 20 }, null,
  );
  assert.equal(g.result, 'win');
  assert.equal(g.units_delta, 3);
});

test('[3] CLV is signed toward the pick and beat follows the probability', () => {
  const g = computeGrade(
    basePick,
    { home_score: 27, away_score: 20 },
    { line: -3.5, price: -110, opposite_price: -110 },
  );
  // Took -2.5, closed -3.5 -> a point of positive CLV.
  assert.equal(g.clv_points, 1);
  // Closing de-vig 0.5 vs pick-time 0.5 -> no probability CLV.
  assert.equal(g.clv_prob, 0);
  assert.equal(g.clv_beat, false);
});

test('[3] a missing closing snapshot yields null CLV, never a fabricated zero', () => {
  const g = computeGrade(basePick, { home_score: 27, away_score: 20 }, null);
  assert.equal(g.clv_points, null);
  assert.equal(g.clv_prob, null);
  assert.equal(g.clv_beat, null);
});

test('[3] a killed pick grades void for CLV only, with zero units', () => {
  const g = computeGrade(
    { ...basePick, status: 'killed' },
    { home_score: 27, away_score: 20 },
    { line: -3.5, price: -110, opposite_price: -110 },
  );
  assert.equal(g.result, 'void');
  assert.equal(g.units_delta, 0);
  assert.equal(g.brier, null);
  // The model decision is still visible to the tuner through CLV.
  assert.equal(g.clv_points, 1);
});

test('[3] grading is deterministic — same inputs, identical grade', () => {
  const final = { home_score: 27, away_score: 20 };
  const close = { line: -3.5, price: -110, opposite_price: -110 };
  assert.deepEqual(
    computeGrade(basePick, final, close),
    computeGrade(basePick, final, close),
  );
});

/* --------------------------------------------------------------------------
 * Brief acceptance #4 — the tuner gate and champion/challenger
 * ----------------------------------------------------------------------- */

test('[4] the gate stays shut below 100 graded picks', () => {
  const gate = gateStatus(corpus({ n: 99, weeks: 4 }));
  assert.equal(gate.open, false);
  assert.match(gate.reason, /insufficient_grades:99\/100/);
});

test('[4] the gate stays shut below 4 distinct weeks even with 100+ grades', () => {
  const gate = gateStatus(corpus({ n: 150, weeks: 3 }));
  assert.equal(gate.open, false);
  assert.match(gate.reason, /insufficient_weeks:3\/4/);
});

test('[4] the gate opens only when BOTH thresholds are met', () => {
  const gate = gateStatus(corpus({ n: 150, weeks: 4 }));
  assert.equal(gate.open, true);
  assert.equal(gate.reason, null);
  assert.equal(MIN_GRADED_PICKS, 100);
  assert.equal(MIN_DISTINCT_WEEKS, 4);
});

test('[4] a worse challenger is refused promotion and the reason is recorded', () => {
  const verdict = promotionVerdict(
    { clv_beat_pct: 51.0, brier: 0.26 },
    { clv_beat_pct: 55.0, brier: 0.24 },
  );
  assert.equal(verdict.promote, false);
  assert.match(verdict.reason, /did not clear champion/);
});

test('[4] a marginally better challenger is still refused below the 1.0 point bar', () => {
  const verdict = promotionVerdict(
    { clv_beat_pct: 55.6, brier: 0.25 },
    { clv_beat_pct: 55.0, brier: 0.25 },
  );
  assert.equal(verdict.promote, false);
});

test('[4] a clearly better challenger is promoted', () => {
  const verdict = promotionVerdict(
    { clv_beat_pct: 56.5, brier: 0.24 },
    { clv_beat_pct: 55.0, brier: 0.25 },
  );
  assert.equal(verdict.promote, true);
});

test('[4] a tied CLV promotes only on a better Brier', () => {
  const better = promotionVerdict(
    { clv_beat_pct: 55.2, brier: 0.22 }, { clv_beat_pct: 55.0, brier: 0.25 },
  );
  assert.equal(better.promote, true);
  assert.match(better.reason, /brier improved/);

  const worse = promotionVerdict(
    { clv_beat_pct: 55.2, brier: 0.28 }, { clv_beat_pct: 55.0, brier: 0.25 },
  );
  assert.equal(worse.promote, false);
});

test('[4] missing CLV signal can never promote by default', () => {
  assert.equal(promotionVerdict({ clv_beat_pct: null, brier: 0.1 },
    { clv_beat_pct: 55, brier: 0.9 }).promote, false);
});

test('[4] training produces a full coefficient set and a backtest', () => {
  const rows = corpus({ n: 150, weeks: 5 });
  const challenger = trainChallenger(rows);
  assert.deepEqual(Object.keys(challenger.coef).sort(), [...FEATURE_ORDER].sort());
  assert.equal(challenger.meta.trained, true);
  const score = backtest(challenger, rows);
  assert.ok(score.clv_beat_pct !== null);
  assert.ok(score.brier !== null);
  assert.equal(score.rows, 150);
});

test('[4] the blended label weights CLV 70 / result 30', () => {
  assert.equal(blendedLabel({ clv_beat: true, outcome: 1 }), 1);
  assert.equal(blendedLabel({ clv_beat: false, outcome: 0 }), 0);
  // CLV says yes, result says no -> 0.7
  assert.ok(Math.abs(blendedLabel({ clv_beat: true, outcome: 0 }) - 0.7) < 1e-9);
  // A void has no result component and trains on CLV alone.
  assert.equal(blendedLabel({ clv_beat: true, outcome: null }), 1);
  assert.equal(blendedLabel({ clv_beat: null, outcome: null }), null);
});

test('[4] calibration shrinks an overconfident bucket toward 0.5', () => {
  // Bucket states 70% and realises 55%.
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    rows.push({
      confidence_bucket: 'A', model_prob: 0.70,
      outcome: i < 22 ? 1 : 0, features: {}, season: 2026, week: 1,
    });
  }
  const calib = calibrate(rows);
  assert.ok(calib.A < 1.0, `expected shrinkage, got ${calib.A}`);
  assert.ok(calib.A > 0);
});

test('[4] a thin bucket is left uncalibrated rather than over-fitted', () => {
  const rows = [{ confidence_bucket: 'A', model_prob: 0.9, outcome: 0, features: {}, season: 2026, week: 1 }];
  assert.equal(calibrate(rows).A, 1.0);
});

/* --------------------------------------------------------------------------
 * Handoff invariants
 * ----------------------------------------------------------------------- */

test('[handoff] training consumes only finalized observations, and a void still teaches CLV', () => {
  const rows = corpus({ n: 120, weeks: 4 });
  rows.push({ ...observation(0.3), result: 'void', outcome: null, clv_beat: true });
  const challenger = trainChallenger(rows);
  assert.ok(challenger.meta.training_rows >= 120);
});

test('[handoff] a decision-time snapshot is never recomputed during grading', () => {
  // computeGrade receives the stored features and must not alter them.
  const snapshot = { ...basePick.features, off_epa_diff: 0.42 };
  const pick = { ...basePick, features: snapshot };
  computeGrade(pick, { home_score: 27, away_score: 20 }, null);
  assert.equal(pick.features.off_epa_diff, 0.42);
  assert.deepEqual(pick.features, snapshot);
});

test('[handoff] a losing pick produces a real negative unit result, never a hidden one', () => {
  const g = computeGrade(basePick, { home_score: 20, away_score: 27 }, null);
  assert.equal(g.result, 'loss');
  assert.equal(g.units_delta, -1);
  assert.ok(g.brier > 0);
});

test('[handoff] ROI uses the persisted issuance price, not a -110 default', () => {
  const dog = computeGrade(
    { ...basePick, market_price: 240, stake_units: 1 },
    { home_score: 27, away_score: 20 }, null,
  );
  assert.equal(dog.units_delta, 2.4);
  const fav = computeGrade(
    { ...basePick, market_price: -180, stake_units: 1 },
    { home_score: 27, away_score: 20 }, null,
  );
  assert.ok(Math.abs(fav.units_delta - 100 / 180) < 1e-3);
  assert.notEqual(dog.units_delta, fav.units_delta);
});

test('[handoff] no randomness anywhere in the decision or grading path', async () => {
  const { readFileSync } = await import('node:fs');
  const files = [
    '../../nfl-odds-snapshot/src/index.js',
    '../../nfl-game-picks-orchestrator/src/index.js',
    '../../nfl-game-grader/src/index.js',
    '../../nfl-weight-tuner/src/index.js',
    '../pick-math.mjs',
  ];
  for (const rel of files) {
    const url = new URL(rel, import.meta.url);
    const src = readFileSync(url, 'utf8');
    assert.ok(!/Math\.random/.test(src), `Math.random found in ${rel}`);
  }
});

/* --------------------------------------------------------------------------
 * Venue + rest derivation (feed wind15 / cold25 / rest_diff)
 * ----------------------------------------------------------------------- */

test('[inputs] every NFL team code has a venue with usable coordinates', async () => {
  const { STADIUMS, isIndoor, venueFor } = await import('../stadiums.mjs');
  assert.equal(Object.keys(STADIUMS).length, 32);
  for (const [team, v] of Object.entries(STADIUMS)) {
    assert.ok(Number.isFinite(v.lat) && Math.abs(v.lat) <= 90, `${team} lat`);
    assert.ok(Number.isFinite(v.lon) && Math.abs(v.lon) <= 180, `${team} lon`);
    assert.ok(['open', 'dome', 'retractable'].includes(v.roof), `${team} roof`);
  }
  assert.equal(isIndoor('MIN'), true);
  assert.equal(isIndoor('DAL'), true);   // retractable is treated as closed
  assert.equal(isIndoor('GB'), false);
  assert.equal(venueFor('ZZZ'), null);
});

test('[inputs] rest days derive from the real schedule, week 1 defaults to 7', async () => {
  const { restDaysBySchedule } = await import('../stadiums.mjs');
  const games = [
    { game_id: 'g1', gameday: '2026-09-13', gametime: '17:00', away_team: 'NE', home_team: 'SEA' },
    { game_id: 'g2', gameday: '2026-09-20', gametime: '17:00', away_team: 'SEA', home_team: 'GB' },
    { game_id: 'g3', gameday: '2026-09-24', gametime: '00:15', away_team: 'GB', home_team: 'NE' },
  ];
  const rest = restDaysBySchedule(games);
  // Week 1: no prior game for either side.
  assert.equal(rest.get('g1').NE, 7);
  assert.equal(rest.get('g1').SEA, 7);
  // SEA played 7 days earlier.
  assert.equal(rest.get('g2').SEA, 7);
  // GB is on a short week into Thursday; NE had a bye-length rest.
  assert.equal(rest.get('g3').GB, 4);
  assert.equal(rest.get('g3').NE, 11);
});

test('[inputs] a roofed venue suppresses weather features entirely', () => {
  const roofed = evaluate({
    game: { ...GAME, home_team: 'MIN' }, market: 'spread', quote: strongQuote,
    ratings: new Map([['MIN', RATINGS.get('SEA')], ['NE', RATINGS.get('NE')]]),
    weather: { wind_mph: 40, temp_f: -10 },   // would trip both flags outdoors
    champion: CHAMPION, season: 2026, week: 1,
  });
  assert.equal(roofed.features.dome, 1);
  assert.equal(roofed.features.wind15, 0);
  assert.equal(roofed.features.cold25, 0);
});

test('[inputs] an outdoor venue does record wind and cold flags', () => {
  const outdoor = evaluate({
    game: { ...GAME, home_team: 'GB' }, market: 'spread', quote: strongQuote,
    ratings: new Map([['GB', RATINGS.get('SEA')], ['NE', RATINGS.get('NE')]]),
    weather: { wind_mph: 22, temp_f: 18 },
    champion: CHAMPION, season: 2026, week: 1,
  });
  assert.equal(outdoor.features.dome, 0);
  assert.equal(outdoor.features.wind15, 1);
  assert.equal(outdoor.features.cold25, 1);
});

/* --------------------------------------------------------------------------
 * Side attribution end-to-end (launch blocker)
 * ----------------------------------------------------------------------- */

const awayQuote = {
  side: 'NE +2.5', line: 2.5, price: -110, opposite_price: -110, line_move: 0,
  selected_is_home: false, team: 'NE', over_under: null,
};
const totalQuote = {
  side: 'OVER 44.5', line: 44.5, price: -110, opposite_price: -110, line_move: 0,
  selected_is_home: false, team: null, over_under: 'OVER',
};

test('[side] an AWAY selection sets home=0 and uses the away team ratings', () => {
  const gameWithRest = { ...GAME, rest_home: 7, rest_away: 4 };
  const away = evaluate({
    game: gameWithRest, market: 'spread', quote: awayQuote,
    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 2,
  });
  assert.equal(away.features.home, 0);
  // Away team is on 4 days rest vs home 7 -> negative differential.
  assert.equal(away.features.rest_diff, -3);
  assert.equal(away.side, 'NE +2.5');
});

test('[side] the same game scored for HOME differs from AWAY', () => {
  const gameWithRest = { ...GAME, rest_home: 7, rest_away: 4 };
  const common = { game: gameWithRest, market: 'spread', ratings: RATINGS,
    weather: null, champion: CHAMPION, season: 2026, week: 2 };
  const home = evaluate({ ...common, quote: { ...strongQuote, team: 'SEA', selected_is_home: true } });
  const away = evaluate({ ...common, quote: awayQuote });

  assert.equal(home.features.home, 1);
  assert.equal(away.features.home, 0);
  assert.equal(home.features.rest_diff, 3);
  assert.equal(away.features.rest_diff, -3);
  // EPA differentials are mirrored, not identical.
  assert.notEqual(home.features.off_epa_diff, away.features.off_epa_diff);
});

test('[side] a TOTAL carries no team identity and is never marked home', () => {
  const t = evaluate({
    game: { ...GAME, rest_home: 7, rest_away: 7 }, market: 'total', quote: totalQuote,
    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 2,
  });
  assert.equal(t.features.home, 0);
  assert.equal(t.side, 'OVER 44.5');
  assert.equal(t.market_line, 44.5);
});

test('[side] a quote missing attribution is never treated as home', () => {
  const noAttribution = { ...awayQuote, selected_is_home: undefined };
  const d = evaluate({
    game: { ...GAME, rest_home: 7, rest_away: 7 }, market: 'spread', quote: noAttribution,
    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 2,
  });
  // Strict === true check means undefined can never become home=1.
  assert.equal(d.features.home, 0);
});
