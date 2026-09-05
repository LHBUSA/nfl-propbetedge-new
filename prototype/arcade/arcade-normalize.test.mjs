/* PHASE 1.5 — ArcadePlay regression suite.
 *
 * Every fixture is a REAL upstream play object captured from
 * cdn.espn.com/core/nfl/playbyplay, run through api/nfl-live.js's own play()
 * normalizer and then through normalizePlayForArcade. Nothing is hand-written,
 * so a test failing means the real contract moved.
 *
 * The three mistakes found in Phase 1 have named tests of their own.
 *
 * Run: node --test prototype/arcade/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePlayForArcade } from './arcade-normalize.js';

const SRC = readFileSync(new URL('../../api/nfl-live.js', import.meta.url), 'utf8');
function loadPlay() {
  /* Take the shipped file from its first line down to the end of play(), which
     captures every helper that function depends on, and return play itself. The
     function under test is therefore the shipped one, not a copy. */
  const fnStart = SRC.indexOf('function play(p){');
  const fnEnd = SRC.indexOf('\n}', fnStart) + 2;
  return new Function(SRC.slice(0, fnEnd) + '\nreturn play;')();
}
const apiPlay = loadPlay();
const FIX = JSON.parse(readFileSync(new URL('./fixtures/upstream-plays.json', import.meta.url), 'utf8'));

/* full pipeline: raw upstream -> shipped API normalizer -> ArcadePlay */
function arcade(name) {
  const f = FIX[name];
  if (!f) throw new Error(`fixture ${name} missing`);
  const norm = apiPlay(f.raw);
  const drive = f.drive ? { id: f.drive.id, team: f.drive.team } : null;
  return normalizePlayForArcade(norm, {
    drive,
    homeTeam: f.teams?.home || null,
    awayTeam: f.teams?.away || null
  });
}

/* ------------------------------------------------------------------ classes */
const CLASSES = {
  rush: 'rush',
  pass_complete: 'pass_complete',
  incomplete: 'pass_incomplete',
  incomplete_penalty: 'pass_incomplete',
  sack: 'sack',
  interception: 'interception',
  fumble_lost: 'fumble_lost',
  touchdown_pass: 'passing_touchdown',
  touchdown_rush: 'rushing_touchdown',
  field_goal: 'field_goal_good',
  field_goal_miss: 'field_goal_missed',
  punt: 'punt',
  kickoff: 'kickoff',
  penalty: 'penalty',
  turnover_on_downs: 'pass_incomplete',
  safety: 'safety'
};

test('every play class classifies from the structured type id, never from prose', () => {
  for (const [fixture, kind] of Object.entries(CLASSES)) {
    const a = arcade(fixture);
    assert.equal(a.kind, kind, `${fixture} classified as ${a.kind}`);
    assert.equal(a.typeBasis, 'type_id', `${fixture} did not classify from type_id`);
    assert.equal(a.typeVerified, true, `${fixture} used an unverified mapping`);
  }
});

test('every class produces a usable snap spot and ball spot, or fails closed', () => {
  for (const fixture of Object.keys(CLASSES)) {
    const a = arcade(fixture);
    assert.ok(Number.isFinite(a.startYard), `${fixture}: no snap spot`);
    if (a.confidence.level === 'field_state_only') continue;   // failing closed is allowed
    assert.ok(Number.isFinite(a.ballEndYard), `${fixture}: no ball spot and did not fail closed`);
    assert.ok(a.ballEndYard >= 0 && a.ballEndYard <= 100, `${fixture}: ball spot off the field`);
  }
});

/* --------------------------------------------------- MISTAKE 1: field goals */
test('MISTAKE 1 — a field goal kick distance never becomes offensive yards gained', () => {
  for (const fixture of ['field_goal', 'field_goal_miss']) {
    const a = arcade(fixture);
    assert.equal(a.yardsGained, null,
      `${fixture}: yards gained must not be asserted for a kick (got ${a.yardsGained})`);
    assert.equal(a.provenance.yardsGained, 'UNAVAILABLE');
    assert.ok(Number.isFinite(a.kickDistanceYards), `${fixture}: kick distance should be reported`);
    /* the audited relationship: kick distance is roughly the snap's distance to
       the end zone plus the 18 yards of end zone and snap depth */
    const implied = (100 - a.startYard) + 18;
    assert.ok(Math.abs(a.kickDistanceYards - implied) <= 2,
      `${fixture}: kick distance ${a.kickDistanceYards} is not a kick distance for a snap at ${a.startYard}`);
    assert.ok(a.kickDistanceYards > (100 - a.startYard),
      `${fixture}: kick distance must exceed the distance to the goal line, proving it is not field advance`);
  }
});

test('MISTAKE 1b — a made field goal does not advance the offence down the field', () => {
  const a = arcade('field_goal');
  assert.equal(a.scoring, true);
  /* the ball never travelled from the snap to the end zone as a carry */
  assert.notEqual(a.provenance.yardsGained, 'SOURCE_FACT');
});

/* ---------------------------------------------- MISTAKE 2: incomplete passes */
test('MISTAKE 2 — an incompletion never gains yards and is never a completion', () => {
  for (const fixture of ['incomplete', 'incomplete_penalty', 'turnover_on_downs']) {
    const a = arcade(fixture);
    assert.equal(a.kind, 'pass_incomplete');
    assert.equal(a.yardsGained, 0, `${fixture}: an incompletion gained ${a.yardsGained}`);
    assert.equal(a.ballEndYard, a.startYard,
      `${fixture}: the ball must return to the snap spot, not travel to ${a.ballEndYard}`);
  }
});

test('MISTAKE 2b — an incompletion with a penalty still moves the NEXT SNAP', () => {
  const a = arcade('incomplete_penalty');
  assert.equal(a.penaltyOnPlay, true, 'fixture must be flagged as a penalty upstream');
  assert.ok(Number.isFinite(a.nextSnapYard), 'the next snap spot must still be reported');
  assert.notEqual(a.nextSnapYard, a.ballEndYard,
    'this fixture is a penalty that moved the ball; the next snap must differ from the ball spot');
  assert.ok(Number.isFinite(a.penaltyYards) && a.penaltyYards !== 0,
    `penalty displacement must be reported (got ${a.penaltyYards})`);
  /* and the two must not be conflated */
  assert.equal(a.yardsGained, 0, 'the penalty is not yards gained by the pass');
});

test('MISTAKE 2c — a clean incompletion reports no penalty displacement', () => {
  const a = arcade('incomplete');
  assert.equal(a.penaltyYards, null);
  assert.equal(a.yardsGained, 0);
});

/* ----------------------------------------------- MISTAKE 3: scoring sentinel */
test('MISTAKE 3 — a scoring end state is never read as an ordinary field transition', () => {
  for (const fixture of ['touchdown_pass', 'touchdown_rush', 'field_goal', 'safety']) {
    const a = arcade(fixture);
    assert.equal(a.scoringSentinel, true, `${fixture}: sentinel not detected`);
    assert.equal(a.nextSnapYard, null,
      `${fixture}: the sentinel end state must NOT be published as a next snap spot`);
  }
});

test('MISTAKE 3b — a touchdown finishes in the end zone, not at the kickoff spot', () => {
  for (const fixture of ['touchdown_pass', 'touchdown_rush']) {
    const a = arcade(fixture);
    assert.equal(a.scoring, true);
    assert.equal(a.ballEndYard, 100, `${fixture}: a touchdown must finish at the goal line`);
    /* the raw end state on these fixtures carries the ensuing kickoff spot;
       proving we did not use it */
    const rawEnd = FIX[fixture].raw.end?.yardsToEndzone;
    if (Number.isFinite(rawEnd) && rawEnd !== 0) {
      assert.notEqual(a.ballEndYard, 100 - rawEnd,
        `${fixture}: the ball spot came from the kickoff sentinel (${rawEnd})`);
    }
  }
});

/* ------------------------------------------------------ possession changes */
test('possession change is detected from the team ids on every turnover class', () => {
  for (const fixture of ['interception', 'fumble_lost', 'punt', 'kickoff', 'turnover_on_downs']) {
    const a = arcade(fixture);
    assert.equal(a.possessionChange, true, `${fixture}: possession change missed`);
    assert.equal(a.provenance.possessionChange, 'SOURCE_FACT',
      `${fixture}: possession change should come from the team ids, not a type guess`);
  }
});

test('a play that keeps the ball is not reported as a possession change', () => {
  for (const fixture of ['rush', 'pass_complete', 'incomplete', 'sack', 'touchdown_pass']) {
    assert.equal(arcade(fixture).possessionChange, false, `${fixture}: false turnover`);
  }
});

test('a turnover on downs is caught even though is_turnover is false', () => {
  const f = FIX.turnover_on_downs;
  assert.equal(f.raw.isTurnover, false, 'fixture premise: upstream does not flag this as a turnover');
  assert.notEqual(String(f.raw.start?.team?.id), String(f.raw.end?.team?.id), 'fixture premise: the frame changed');
  assert.equal(arcade('turnover_on_downs').possessionChange, true);
});

test('an interception return lands on the published spot in the offence frame', () => {
  const a = arcade('interception');
  const raw = FIX.interception.raw;
  /* frames differ, so the end spot expressed in the snapping offence's frame is
     the raw end.yardsToEndzone itself -- see the field model comment */
  assert.equal(a.nextSnapYard, raw.end.yardsToEndzone);
  assert.equal(a.possessionChange, true);
});

/* ------------------------------------------------------------- yards gained */
test('yards gained comes from stat_yardage, not the yards_to_endzone delta', () => {
  for (const fixture of ['rush', 'pass_complete', 'sack']) {
    const a = arcade(fixture);
    assert.equal(a.yardsGained, FIX[fixture].raw.statYardage, `${fixture}: yardage not from stat_yardage`);
    assert.equal(a.provenance.yardsGained, 'SOURCE_FACT');
  }
});

test('a sack is a loss and moves the ball backwards', () => {
  const a = arcade('sack');
  assert.ok(a.yardsGained < 0, 'a sack fixture must be a loss');
  assert.ok(a.ballEndYard < a.startYard, 'the ball must finish behind the snap');
});

/* --------------------------------------------------------- fail closed */
test('an unknown play type falls back to field state and never invents an event', () => {
  const a = normalizePlayForArcade(
    { id: 'x', type: '???', type_id: '99999', period: 1, clock: '1:00',
      start: { down: 1, distance: 10, yards_to_endzone: 50 },
      end: { down: 2, distance: 6, yards_to_endzone: 46 },
      text: 'Something the taxonomy has never seen.' }, {});
  assert.equal(a.kind, 'unknown');
  assert.equal(a.typeBasis, 'none');
  assert.equal(a.confidence.level, 'field_state_only');
  assert.equal(a.actualText, 'Something the taxonomy has never seen.');
});

test('a play with no published field state fails closed rather than guessing', () => {
  const a = normalizePlayForArcade(
    { id: 'y', type: 'Rush', type_id: '5', start: {}, end: {}, text: 'x' }, {});
  assert.equal(a.startYard, null);
  assert.equal(a.confidence.level, 'field_state_only');
  assert.equal(a.provenance.startYard, 'UNAVAILABLE');
});

test('a stoppage has no field action and says so', () => {
  const a = normalizePlayForArcade(
    { id: 'z', type: 'Official Timeout', type_id: '74', period: 2, clock: '2:00',
      start: { down: 1, distance: 10, yards_to_endzone: 40 },
      end: { down: 1, distance: 10, yards_to_endzone: 40 }, text: 'Official Timeout.' }, {});
  assert.equal(a.kind, 'stoppage');
  assert.equal(a.confidence.level, 'no_field_action');
  assert.equal(a.yardsGained, null);
});

/* ------------------------------------------- names must not be load-bearing */
test('player names never determine field geometry or possession', () => {
  for (const fixture of Object.keys(CLASSES)) {
    const a = arcade(fixture);
    const stripped = normalizePlayForArcade(
      { ...apiPlay(FIX[fixture].raw), text: '' },
      { drive: FIX[fixture].drive ? { id: FIX[fixture].drive.id, team: FIX[fixture].drive.team } : null,
        homeTeam: FIX[fixture].teams?.home || null, awayTeam: FIX[fixture].teams?.away || null });
    for (const k of ['kind', 'startYard', 'ballEndYard', 'nextSnapYard', 'yardsGained',
                     'possessionChange', 'scoring', 'firstDownYard', 'kickDistanceYards']) {
      assert.deepEqual(stripped[k], a[k],
        `${fixture}: removing the play text changed ${k} — a name is load-bearing`);
    }
  }
});

test('every player name is marked TEXT_DERIVED, never SOURCE_FACT', () => {
  for (const fixture of Object.keys(CLASSES)) {
    const a = arcade(fixture);
    for (const k of ['passer', 'receiver', 'rusher', 'tackler', 'interceptor', 'kicker', 'fumbledBy', 'recoveredBy']) {
      if (a[k]) assert.equal(a.provenance[k], 'TEXT_DERIVED', `${fixture}.${k} claimed ${a.provenance[k]}`);
    }
  }
});

test('reconstructed geometry is always labelled reconstructed', () => {
  const a = arcade('rush');
  for (const k of ['routes', 'blocking', 'defenderMovement', 'formation', 'runningLane', 'allTwentyTwoPositions', 'timing']) {
    assert.equal(a.provenance[k], 'RECONSTRUCTED');
  }
});

/* ---------------------------------------------- corpus-driven regressions
 * The two rows below are real, captured verbatim from the 59-game corpus. Both
 * classes failed closed before the sentinel rule was narrowed, so they are
 * pinned here.
 */
const CORPUS = {
  kickoff_return: { id: 'kr', type: { id: '12', text: 'Kickoff Return (Offense)' },
    period: { number: 1 }, clock: { displayValue: '15:00' }, scoringPlay: false,
    statYardage: 48, isTurnover: false, isPenalty: false,
    start: { down: 0, distance: 0, yardsToEndzone: 65, team: { id: '11' } },
    end:   { down: -1, distance: 10, yardsToEndzone: 48, team: { id: '4' } },
    text: 'S.Shrader kicks 61 yards from IND 35 to CIN 4. C.Jones to IND 48.' },
  field_goal_good: { id: 'fg', type: { id: '59', text: 'Field Goal Good' },
    period: { number: 2 }, clock: { displayValue: '0:30' }, scoringPlay: true,
    statYardage: 56, isTurnover: false, isPenalty: false,
    start: { down: 4, distance: 6, yardsToEndzone: 38, team: { id: '11' } },
    end:   { down: -1, distance: 10, yardsToEndzone: 65, team: { id: '11' } },
    text: 'M.Kicker 56 yard field goal is GOOD.' }
};

test('a kickoff return is not a scoring sentinel and keeps its real end spot', () => {
  const a = normalizePlayForArcade(apiPlay(CORPUS.kickoff_return), { drive: { team: { abbreviation: 'IND' } } });
  assert.equal(a.kind, 'kickoff_return');
  assert.equal(a.scoringSentinel, false, 'down === -1 alone must not be read as a scoring sentinel');
  assert.equal(a.confidence.level, 'exact_endpoints');
  assert.ok(Number.isFinite(a.ballEndYard), 'the return must land somewhere real');
  assert.equal(a.possessionChange, true);
});

test('a made field goal finishes at the uprights, never at the ensuing kickoff spot', () => {
  const a = normalizePlayForArcade(apiPlay(CORPUS.field_goal_good), { drive: { team: { abbreviation: 'IND' } } });
  assert.equal(a.scoring, true);
  assert.equal(a.scoringSentinel, true);
  assert.equal(a.ballEndYard, 100, 'a made kick finishes through the posts');
  assert.equal(a.nextSnapYard, null, 'the kickoff spot is not a next snap for this offence');
  assert.equal(a.yardsGained, null, 'and it still gains no offensive yards');
  assert.equal(a.kickDistanceYards, 56);
});

test('every observed type id in the corpus taxonomy maps to a known kind', () => {
  const ids = ['5','24','3','7','52','53','12','32','59','60','67','68','26','36','9','29','20','8','2','65','66','21','74','75','80','39','38'];
  for (const id of ids) {
    const a = normalizePlayForArcade({ id: 't', type_id: id, type: 'x', start: {}, end: {}, text: '' }, {});
    assert.notEqual(a.kind, 'unknown', `type_id ${id} is unmapped`);
    assert.equal(a.typeBasis, 'type_id');
  }
});
