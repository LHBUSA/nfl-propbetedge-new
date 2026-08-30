/* Ratings tests.
 *
 * The central requirement: a missing rating must never be indistinguishable
 * from a genuine numeric 0. NFL EPA/play of exactly 0.000 is a real, average
 * offence — it is NOT "no data" — so the two must stay separable at every
 * layer: the rating builder, the guard, the DB row shape, and the orchestrator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitCsvLine, resolveColumns, createPlayCollector,
  opponentAdjust, buildSeasonRatings, blendSeasons, toRatingRows, ratingUsable,
  REQUIRED_COLUMNS, ROLLING_GAMES, MIN_PLAYS_FOR_RATING, PRIOR_SEASON_DECAY,
  RATINGS_SOURCE, RATINGS_ALGO_VERSION,
} from '../ratings.mjs';
import { evaluate } from '../../nfl-game-picks-orchestrator/src/index.js';

/* ------------------------------------------------------------------------
 * CSV plumbing
 * --------------------------------------------------------------------- */

test('CSV splitting handles quotes, embedded commas and escaped quotes', () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",d'), ['a', 'say "hi"', 'd']);
  assert.deepEqual(splitCsvLine('a,,c'), ['a', '', 'c']);
});

test('columns resolve BY NAME so an upstream insertion cannot shift epa', () => {
  const header = ['x', ...REQUIRED_COLUMNS].join(',');
  const { index } = resolveColumns(header);
  // Every required column shifted by one, and resolution follows.
  REQUIRED_COLUMNS.forEach((name, i) => assert.equal(index[name], i + 1));
});

test('a pbp file missing a required column fails loudly', () => {
  const header = REQUIRED_COLUMNS.filter(c => c !== 'epa').join(',');
  assert.throws(() => resolveColumns(header), /pbp_missing_column:epa/);
});

test('the collector keeps only regular-season scrimmage plays with real EPA', () => {
  const header = REQUIRED_COLUMNS.join(',');
  const { index } = resolveColumns(header);
  const c = createPlayCollector();
  const row = o => splitCsvLine([
    o.game_id ?? 'g1', o.home_team ?? 'SEA', o.away_team ?? 'NE',
    o.season_type ?? 'REG', o.week ?? '1', o.posteam ?? 'SEA',
    o.defteam ?? 'NE', o.epa ?? '0.1', o.play ?? '1', o.pass_oe ?? '2.0',
  ].join(','));

  assert.equal(c.add(row({}), index), true);
  assert.equal(c.add(row({ season_type: 'POST' }), index), false);
  assert.equal(c.add(row({ play: '0' }), index), false);
  assert.equal(c.add(row({ epa: 'NA' }), index), false);
  assert.equal(c.add(row({ posteam: '' }), index), false);
  assert.equal(c.result().plays.length, 1);
});

test('a missing pass_oe becomes null, not zero', () => {
  const { index } = resolveColumns(REQUIRED_COLUMNS.join(','));
  const c = createPlayCollector();
  c.add(splitCsvLine('g1,SEA,NE,REG,1,SEA,NE,0.1,1,NA'), index);
  c.add(splitCsvLine('g1,SEA,NE,REG,1,SEA,NE,0.1,1,'), index);
  for (const p of c.result().plays) assert.equal(p.pass_oe, null);
});

/* ------------------------------------------------------------------------
 * Opponent adjustment
 * --------------------------------------------------------------------- */

function play(off, def, epa, week = 1, game_id = `${off}${def}${week}`) {
  return { off, def, epa, week, game_id, pass_oe: 1 };
}

test('opponent adjustment is deterministic across runs', () => {
  const plays = [
    play('A', 'B', 0.3), play('B', 'A', -0.1),
    play('A', 'C', 0.2), play('C', 'A', 0.0),
    play('B', 'C', 0.1), play('C', 'B', -0.2),
  ];
  const first = opponentAdjust(plays);
  const second = opponentAdjust(plays);
  assert.deepEqual(first, second);
});

test('a team that only played strong defences is credited for it', () => {
  /* A and B post identical raw offensive EPA, but A did it against a defence
   * that suppresses everyone else. A should adjust higher than B. */
  const plays = [];
  for (let i = 0; i < 60; i += 1) {
    plays.push(play('A', 'STRONG', 0.10, 1, 'gA'));
    plays.push(play('B', 'WEAK', 0.10, 1, 'gB'));
    plays.push(play('C', 'STRONG', -0.30, 1, 'gC'));
    plays.push(play('C', 'WEAK', 0.30, 1, 'gD'));
  }
  const { off } = opponentAdjust(plays);
  assert.ok(off.A > off.B, `A ${off.A} should exceed B ${off.B}`);
});

/* ------------------------------------------------------------------------
 * The core guarantee: unknown != zero
 * --------------------------------------------------------------------- */

test('a team with too little data is unavailable and carries NO metrics', () => {
  const plays = [play('A', 'B', 0.1), play('B', 'A', 0.1)];
  const ratings = buildSeasonRatings(plays, 1);
  const a = ratings.get('A');
  assert.equal(a.status, 'unavailable');
  assert.match(a.reason, /insufficient_plays/);
  // Critically: no numeric fields at all, not zeros.
  assert.equal(a.off_epa_play, undefined);
  assert.equal(a.def_epa_play, undefined);
});

test('a genuine 0.0 EPA rating is valid and stays distinguishable from unknown', () => {
  const plays = [];
  for (let i = 0; i < 200; i += 1) {
    plays.push(play('A', 'B', 0, 1, 'g1'));
    plays.push(play('B', 'A', 0, 1, 'g1'));
  }
  const ratings = buildSeasonRatings(plays, 1);
  const a = ratings.get('A');
  assert.equal(a.status, 'ok');
  assert.equal(a.off_epa_play, 0);
  // A real zero is usable...
  assert.equal(ratingUsable(a).usable, true);
  // ...while an unavailable rating is not, even though both "look like" 0.
  assert.equal(ratingUsable({ status: 'unavailable', reason: 'x' }).usable, false);
});

test('the guard rejects every shape of missing rating with a reason', () => {
  assert.deepEqual(ratingUsable(null), { usable: false, reason: 'no_rating_row' });
  assert.deepEqual(ratingUsable(undefined), { usable: false, reason: 'no_rating_row' });
  assert.equal(ratingUsable({ status: 'stale' }).usable, false);
  assert.equal(ratingUsable({ status: 'unavailable', status_reason: 'r' }).reason, 'r');
  // "ok" but with a null metric is still not usable.
  assert.equal(ratingUsable({ status: 'ok', off_epa_play: null, def_epa_play: 0 }).usable, false);
  assert.match(ratingUsable({ status: 'ok', off_epa_play: null, def_epa_play: 0 }).reason,
    /missing_metric:off_epa_play/);
  // An empty object is not a neutral rating.
  assert.equal(ratingUsable({}).usable, false);
});

test('ORCHESTRATOR: a missing rating blocks the decision instead of scoring zeros', () => {
  const quote = { side: 'SEA -2.5', line: -2.5, price: -110, opposite_price: -110,
    line_move: 0, selected_is_home: true, team: 'SEA' };
  const game = { game_id: 'g', home_team: 'SEA', away_team: 'NE',
    kickoff_ts: '2026-09-13T17:00:00Z', rest_home: 7, rest_away: 7 };
  const champion = { version: 1, weights: { intercept: 0, coef: { home: 0.16 },
    meta: { feature_order: ['home'] } } };

  // Home known, away entirely missing.
  const partial = new Map([['SEA', { status: 'ok', off_epa_play: 0.1, def_epa_play: 0 }]]);
  const d = evaluate({ game, market: 'spread', quote, ratings: partial,
    weather: null, champion, season: 2026, week: 2 });

  assert.equal(d.ratings_available, false);
  assert.equal(d.qualifies, false);
  assert.equal(d.stake_units, 0);
  // No feature vector is fabricated.
  assert.equal(d.features, null);
  assert.match(d.unavailable_reason, /^NE:no_rating_row$/);
});

test('ORCHESTRATOR: an unavailable-status rating blocks just like an absent one', () => {
  const quote = { side: 'SEA -2.5', line: -2.5, price: -110, opposite_price: -110,
    line_move: 0, selected_is_home: true, team: 'SEA' };
  const game = { game_id: 'g', home_team: 'SEA', away_team: 'NE',
    kickoff_ts: '2026-09-13T17:00:00Z', rest_home: 7, rest_away: 7 };
  const champion = { version: 1, weights: { intercept: 0, coef: { home: 0.16 },
    meta: { feature_order: ['home'] } } };

  const ratings = new Map([
    ['SEA', { status: 'ok', off_epa_play: 0.1, def_epa_play: 0 }],
    ['NE', { status: 'unavailable', status_reason: 'insufficient_plays:12/100' }],
  ]);
  const d = evaluate({ game, market: 'spread', quote, ratings, weather: null,
    champion, season: 2026, week: 2 });

  assert.equal(d.ratings_available, false);
  assert.equal(d.features, null);
  assert.match(d.unavailable_reason, /insufficient_plays/);
});

/* ------------------------------------------------------------------------
 * Rows + blending
 * --------------------------------------------------------------------- */

test('unavailable rows persist their status and never carry invented numbers', () => {
  const ratings = new Map([
    ['A', { team: 'A', status: 'ok', off_epa_play: 0.05, def_epa_play: -0.02, proe: 1, pace: 63,
      plays_sample: 400, games_sample: 6 }],
    ['B', { team: 'B', status: 'unavailable', reason: 'insufficient_plays:10/100' }],
  ]);
  const rows = toRatingRows(ratings, { season: 2026, asOfWeek: 3, sourceTimestamp: 'T' });

  const b = rows.find(r => r.team === 'B');
  assert.equal(b.status, 'unavailable');
  assert.equal(b.off_epa_play, null);
  assert.equal(b.def_epa_play, null);
  assert.equal(b.proe, null);
  assert.equal(b.pace, null);
  assert.equal(b.status_reason, 'insufficient_plays:10/100');

  const a = rows.find(r => r.team === 'A');
  assert.equal(a.status, 'ok');
  assert.equal(a.source, RATINGS_SOURCE);
  assert.equal(a.source_version, RATINGS_ALGO_VERSION);
  assert.equal(a.source_timestamp, 'T');
  assert.equal(a.plays_sample, 400);
});

test('rows are stable and sorted, so the upsert is idempotent', () => {
  const ratings = new Map([
    ['Z', { team: 'Z', status: 'ok', off_epa_play: 0, def_epa_play: 0 }],
    ['A', { team: 'A', status: 'ok', off_epa_play: 0, def_epa_play: 0 }],
  ]);
  const opts = { season: 2026, asOfWeek: 1, sourceTimestamp: 'T' };
  const first = toRatingRows(ratings, opts);
  const second = toRatingRows(ratings, opts);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(r => r.team), ['A', 'Z']);
});

test('prior-season blending decays and disappears by week 8', () => {
  const current = new Map([['A', { team: 'A', status: 'ok', off_epa_play: 0.2, def_epa_play: 0,
    plays_sample: 300, games_sample: 5 }]]);
  const prior = new Map([['A', { team: 'A', status: 'ok', off_epa_play: 0.0, def_epa_play: 0 }]]);

  const w1 = blendSeasons({ current, prior, week: 1 });
  const w8 = blendSeasons({ current, prior, week: 8 });

  assert.ok(w1.get('A').blend_prior_weight > 0);
  assert.ok(w1.get('A').off_epa_play < 0.2, 'week 1 should be pulled toward the prior');
  assert.equal(w8.get('A').blend_prior_weight, 0);
  assert.equal(w8.get('A').off_epa_play, 0.2);
  assert.equal(PRIOR_SEASON_DECAY, 0.5);
});

test('a team unavailable in both seasons stays unavailable after blending', () => {
  const current = new Map([['A', { team: 'A', status: 'unavailable', reason: 'x' }]]);
  const prior = new Map([['A', { team: 'A', status: 'unavailable', reason: 'y' }]]);
  const blended = blendSeasons({ current, prior, week: 2 });
  assert.equal(blended.get('A').status, 'unavailable');
  assert.equal(ratingUsable(blended.get('A')).usable, false);
});

test('a team present only in the prior season is labelled prior_only, not ok', () => {
  const current = new Map([['A', { team: 'A', status: 'unavailable', reason: 'x' }]]);
  const prior = new Map([['A', { team: 'A', status: 'ok', off_epa_play: 0.1, def_epa_play: 0 }]]);
  const blended = blendSeasons({ current, prior, week: 1 });
  assert.equal(blended.get('A').status, 'prior_only');
  // Usable, but honestly labelled as coming from last season.
  assert.equal(ratingUsable(blended.get('A')).usable, true);
});

test('the rolling window is capped at the configured game count', () => {
  const plays = [];
  for (let g = 1; g <= 15; g += 1) {
    for (let i = 0; i < 60; i += 1) {
      plays.push(play('A', 'B', 0.1, g, `g${g}`));
      plays.push(play('B', 'A', 0.1, g, `g${g}`));
    }
  }
  const ratings = buildSeasonRatings(plays, 15);
  assert.equal(ratings.get('A').games_sample, ROLLING_GAMES);
  assert.equal(MIN_PLAYS_FOR_RATING, 100);
});
