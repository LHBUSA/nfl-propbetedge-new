/**
 * Matchup intelligence — the composition rules.
 *
 *   node --test tests/matchup-intel.test.mjs
 *
 * The assertions that matter are the ones about orientation and about absence:
 * a defensive metric must not be read as though lower were worse, and nothing
 * that is unknown may arrive as a zero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT, STATE, LIMITED_SAMPLE_PLAYS, STRENGTH_PERCENTILE, WEAKNESS_PERCENTILE,
  ratingUsable, ratingLabel, priorWeight, metric, percentileOf, classify,
  collisions, orderAvailability, whatMattersMost, toFreePayload,
} from '../api/_matchup/intel-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const rating = over => ({
  team: 'ATL', season: 2026, as_of_week: 2, status: 'ok',
  off_epa_play: 0.05, def_epa_play: -0.02, proe: 1.5, pace: 63,
  plays_sample: 130, games_sample: 2, ...over,
});

/* ------------------------------------------------------------ availability */

test('a rating is usable only when it is ok/prior_only AND carries real numbers', () => {
  assert.equal(ratingUsable(rating()).usable, true);
  assert.equal(ratingUsable(null).usable, false);
  assert.equal(ratingUsable(null).reason, 'no_rating_row');
  assert.equal(ratingUsable(rating({ status: 'unavailable' })).usable, false);
  assert.equal(ratingUsable(rating({ status: 'stale' })).usable, false);
  /* The case the whole rule exists for: a present row with a null metric. */
  assert.equal(ratingUsable(rating({ off_epa_play: null })).usable, false);
  assert.match(ratingUsable(rating({ off_epa_play: null })).reason, /missing_metric/);
  assert.equal(ratingUsable(rating({ def_epa_play: '' })).usable, false);
  /* A genuine 0.0 is a real value and must stay usable. */
  assert.equal(ratingUsable(rating({ off_epa_play: 0 })).usable, true);
});

test('prior_only is labelled a prior-season baseline, never as current', () => {
  const label = ratingLabel(rating({ status: 'prior_only' }), 2);
  assert.equal(label.state, STATE.PRIOR_BASELINE);
  assert.match(label.label, /PRIOR-SEASON BASELINE/);
  assert.equal(label.prior_weight, 1);
  assert.match(label.note, /not 2026 form/);
});

test('an early-season blend says how much prior weight it still carries', () => {
  const label = ratingLabel(rating(), 2);
  assert.equal(label.state, STATE.OK);
  assert.match(label.label, /PRIOR BASELINE/);
  assert.ok(label.prior_weight > 0);
  assert.match(label.note, /prior season still carries/);
});

test('from week 8 the rating is fully current', () => {
  const label = ratingLabel(rating({ as_of_week: 9 }), 9);
  assert.equal(label.prior_weight, 0);
  assert.match(label.label, /CURRENT/);
  assert.equal(label.note, undefined);
});

test('an unusable rating is labelled unavailable, not league average', () => {
  const label = ratingLabel(null, 3);
  assert.equal(label.state, STATE.UNAVAILABLE);
  assert.match(label.label, /UNAVAILABLE/);
  assert.equal(label.prior_weight, null);
});

test('the prior-season weight follows the engine formula and fades at week 8', () => {
  assert.equal(priorWeight(1), 0.5);
  assert.ok(priorWeight(2) > priorWeight(4));
  assert.equal(priorWeight(8), 0);
  assert.equal(priorWeight(12), 0);
  assert.equal(priorWeight(null), null, 'an unknown week is unknown, not zero');
});

/* ----------------------------------------------------------------- metrics */

test('a metric with no value is UNAVAILABLE and never zero', () => {
  for (const v of [null, undefined, '']) {
    const m = metric(v, { plays: 200 });
    assert.equal(m.value, null);
    assert.equal(m.state, STATE.UNAVAILABLE);
  }
  const real = metric(0, { plays: 200 });
  assert.equal(real.value, 0, 'a genuine zero survives');
  assert.equal(real.state, STATE.OK);
});

test('a split under the play floor is LIMITED SAMPLE, and says so', () => {
  const small = metric(0.14, { plays: 37 });
  assert.equal(small.state, STATE.LIMITED_SAMPLE);
  assert.equal(small.limited, true);
  assert.equal(small.plays, 37);
  const big = metric(0.14, { plays: LIMITED_SAMPLE_PLAYS });
  assert.equal(big.state, STATE.OK);
  assert.equal(big.limited, false);
});

test('percentile orientation: low EPA allowed is the BEST defence', () => {
  const allowed = [-0.20, -0.10, 0.00, 0.10, 0.20];
  /* The stingiest defence in the pool must come out near the top. */
  assert.ok(percentileOf(-0.20, allowed, 'low') >= 80, 'best defence is a high percentile');
  assert.ok(percentileOf(0.20, allowed, 'low') <= 20, 'worst defence is a low percentile');
  /* Offence runs the other way. */
  assert.ok(percentileOf(0.20, allowed, 'high') >= 80);
  assert.ok(percentileOf(-0.20, allowed, 'high') <= 20);
});

test('a percentile needs a real value and a real pool', () => {
  assert.equal(percentileOf(null, [1, 2, 3, 4]), null);
  assert.equal(percentileOf(0.1, [1, 2]), null, 'too small a pool is no answer');
  assert.equal(percentileOf(0.1, []), null);
});

test('classification thresholds are the documented constants', () => {
  assert.equal(classify(STRENGTH_PERCENTILE).band, 'STRENGTH');
  assert.equal(classify(95).band, 'STRENGTH');
  assert.equal(classify(WEAKNESS_PERCENTILE).band, 'WEAKNESS');
  assert.equal(classify(5).band, 'WEAKNESS');
  assert.equal(classify(50).band, 'NEUTRAL');
  assert.equal(classify(null).band, STATE.UNAVAILABLE);
});

/* -------------------------------------------------------------- collisions */

const dim = (percentile, plays = 90, state = STATE.OK) => ({ percentile, plays, state, limited: plays < LIMITED_SAMPLE_PLAYS });

test('a collision fires only when a strength meets a weakness in the same dimension', () => {
  const out = collisions({
    offense: { pass: dim(82), rush: dim(50), explosive: dim(60) },
    defense: { pass: dim(18), rush: dim(55), explosive: dim(70) },
    offenseTeam: 'CAR', defenseTeam: 'ATL',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].dimension, 'pass');
  assert.equal(out[0].offense_team, 'CAR');
  assert.equal(out[0].defense_team, 'ATL');
  assert.match(out[0].statement, /CAR pass offence ranks 82nd/);
  assert.match(out[0].statement, /ATL pass defence allows at the 18th/);
  /* Descriptive only — never a claim about the result. */
  assert.equal(/will |dominat|lock|guarantee/i.test(out[0].statement), false);
});

test('an unavailable side produces no collision at all', () => {
  const out = collisions({
    offense: { pass: dim(90) },
    defense: { pass: { percentile: null, state: STATE.UNAVAILABLE } },
    offenseTeam: 'CAR', defenseTeam: 'ATL',
  });
  assert.deepEqual(out, [], 'a collision with an unknown is not a finding');
});

test('a collision built on small samples is flagged, not hidden', () => {
  const out = collisions({
    offense: { pass: dim(88, 30) }, defense: { pass: dim(12, 28) },
    offenseTeam: 'CAR', defenseTeam: 'ATL',
  });
  assert.equal(out[0].limited, true);
  assert.equal(out[0].offense_plays, 30);
});

/* ------------------------------------------------------------ availability */

test('availability orders by designation severity, and a missing report is not health', () => {
  const rows = orderAvailability([
    { player: { name: 'Q Player', position: 'WR' }, status: 'Questionable' },
    { player: { name: 'O Player', position: 'CB' }, status: 'Out' },
    { player: { name: 'D Player', position: 'TE' }, status: 'Doubtful' },
    { player: { name: 'No status' } },
  ]);
  assert.deepEqual(rows.map(r => r.status), ['OUT', 'DOUBTFUL', 'QUESTIONABLE']);
  assert.equal(rows.length, 3, 'a row with no designation is not invented into one');
  assert.deepEqual(orderAvailability([]), [], 'an empty board is empty, never "healthy"');
  assert.deepEqual(orderAvailability(null), []);
});

/* -------------------------------------------------------------- statements */

test('every "what matters most" line traces to a state that is displayed', () => {
  const lines = whatMattersMost({
    away: { team: 'CAR', rating: { state: STATE.PRIOR_BASELINE }, availability: [{ status: 'OUT' }] },
    home: { team: 'ATL', rating: { state: STATE.OK, prior_weight: 0.28 }, availability: [] },
    pressurePoints: [{ statement: 'CAR pass offence ranks 82nd percentile; ATL pass defence allows at the 18th percentile.', limited: false }],
    market: { state: STATE.OK },
  });
  const text = lines.map(l => l.text).join(' | ');
  assert.match(text, /82nd percentile/);
  assert.match(text, /prior-season baseline/);
  assert.match(text, /28% prior-season weight/);
  assert.match(text, /1 player ruled out/);
  assert.ok(lines.length <= 6);
  assert.equal(/will win|lock|guarantee|dominate/i.test(text), false, 'no claim the metrics do not support');
});

test('no market produces a stated line rather than a silent gap', () => {
  const lines = whatMattersMost({ away: null, home: null, pressurePoints: [], market: { state: STATE.NO_MARKET } });
  assert.match(lines.map(l => l.text).join(' '), /No current market snapshot/);
});

/* ---------------------------------------------------------------- free/pro */

test('the free payload has Pro values removed, not hidden', () => {
  const full = {
    model: { state: 'OK', rows: [{ fair_line: 245.5, market_consensus_line: 239.5 }] },
    role: { state: 'OK', players: [{ snap_share: 0.82 }] },
    red_zone: { state: 'OK', trips: 7 },
    pressure_points: [{ dimension: 'pass', offense_plays: 84, defense_plays: 79, statement: 'x' }],
  };
  const free = toFreePayload(full);
  const text = JSON.stringify(free);
  assert.equal(text.includes('245.5'), false, 'a fair value must not reach a free browser');
  assert.equal(text.includes('0.82'), false);
  assert.equal(free.model.state, 'PRO_REQUIRED');
  assert.equal(free.role.state, 'PRO_REQUIRED');
  assert.equal(free.red_zone.state, 'PRO_REQUIRED');
  assert.equal(free.entitlement.pro, false);
  /* The free page still gets the matchup advantage itself — it is football, not a price. */
  assert.equal(free.pressure_points[0].statement, 'x');
  assert.equal('offense_plays' in free.pressure_points[0], false);
  /* and the original is untouched */
  assert.equal(full.model.rows[0].fair_line, 245.5);
});

/* --------------------------------------------------- the endpoint contract */

test('no hardcoded event id survives anywhere in the matchup path', () => {
  const FIXTURE = '8c94552d022acec4a0458d70c19d3da9';
  for (const file of ['api/matchup-intel.js', 'api/_matchup/intel-core.js', 'matchups-v3.js']) {
    const source = readFileSync(join(REPO, file), 'utf8');
    assert.equal(source.includes(FIXTURE), false, `${file} must not carry the QA fixture id`);
  }
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  assert.equal(/DEFAULT_EVENT\s*=/.test(page), false, 'no default-event constant');
  assert.match(page, /\|\| ''/, 'with no event the server resolves the slate');
});

test('the page makes one authoritative request, not a waterfall', () => {
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  const fetches = page.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 1, `expected one fetch, saw ${fetches.length}`);
  assert.match(page, /\/api\/matchup-intel/);
});

test('the page no longer counts injury-shaped headlines', () => {
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  /* Comments are stripped first: the header deliberately QUOTES v2's
     "current injury stories" to record what was removed and why, and that
     documentation must not trip the check on the code. */
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/injuryCount/.test(code), false, 'no injury-story counter');
  assert.equal(/injury stories/i.test(code), false);
  assert.match(code, /AVAILABILITY WATCH/);
});

test('2025 is not the centerpiece: the hero leads with the current game', () => {
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  assert.equal(/2025 Final Context/.test(page), false);
  const heroAt = page.indexOf('function hero');
  const formAt = page.indexOf('CURRENT FORM');
  assert.ok(heroAt > 0 && formAt > heroAt, 'current form follows the hero');
});

test('advantage and edge are kept apart in the payload and in the copy', () => {
  const core = readFileSync(join(REPO, 'api', '_matchup', 'intel-core.js'), 'utf8');
  assert.match(core, /MATCHUP ADVANTAGE/);
  assert.match(core, /PBE EDGE/);
  const endpoint = readFileSync(join(REPO, 'api', 'matchup-intel.js'), 'utf8');
  /* pressure_points (advantage) and model (edge) are separate top-level keys. */
  assert.match(endpoint, /pressure_points:/);
  assert.match(endpoint, /model: \{/);
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  assert.match(page, /MATCHUP ADVANTAGE · NOT A PRICE/);
  assert.match(page, /PBE EDGE · MODEL vs MARKET/);
});

test('the contract is versioned and the thresholds are published', () => {
  assert.equal(CONTRACT, 'matchup-intel/v1');
  const endpoint = readFileSync(join(REPO, 'api', 'matchup-intel.js'), 'utf8');
  assert.match(endpoint, /thresholds:/, 'the page can show how it classified');
});
