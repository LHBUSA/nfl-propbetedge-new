/* PHASE 1.5 — additive API contract test.
 *
 * Exercises api/nfl-live.js's own play() normalizer against a REAL upstream
 * game package, proving (a) the five new fields appear, (b) they carry the
 * semantics the audit established, and (c) nothing that PBEcast already reads
 * changed shape.
 *
 * The module is a Vercel handler with a default export and top-level bindings,
 * so play() is not importable. It is loaded as text and the normalizer's own
 * source is evaluated in isolation -- the function under test is therefore the
 * shipped one, byte for byte, not a copy.
 *
 * Run: node --test prototype/arcade/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../api/nfl-live.js', import.meta.url), 'utf8');

/* Pull the helpers and play() out of the shipped file and evaluate just those. */
function loadPlay() {
  /* Take the shipped file from its first line down to the end of play(), which
     captures every helper that function depends on, and return play itself. The
     function under test is therefore the shipped one, not a copy. */
  const fnStart = SRC.indexOf('function play(p){');
  const fnEnd = SRC.indexOf('\n}', fnStart) + 2;
  return new Function(SRC.slice(0, fnEnd) + '\nreturn play;')();
}
const play = loadPlay();

const FIX = JSON.parse(readFileSync(new URL('./fixtures/upstream-plays.json', import.meta.url), 'utf8'));

test('the five additive fields are present on the normalized play', () => {
  const out = play(FIX.rush.raw);
  for (const k of ['stat_yardage', 'is_turnover', 'is_penalty']) assert.ok(k in out, `${k} missing`);
  assert.ok('team_id' in out.start, 'start.team_id missing');
  assert.ok('team_id' in out.end, 'end.team_id missing');
});

test('nothing PBEcast already reads changed shape', () => {
  const out = play(FIX.rush.raw);
  for (const k of ['id','sequence','text','short_text','type','type_id','period','clock','wallclock',
                   'scoring_play','score_value','team','start','end','home_score','away_score','participants']) {
    assert.ok(k in out, `existing field ${k} disappeared`);
  }
  for (const k of ['down','distance','yard_line','yards_to_endzone','possession_text','down_distance_text']) {
    assert.ok(k in out.start && k in out.end, `existing start/end field ${k} disappeared`);
  }
  assert.equal(typeof out.scoring_play, 'boolean');
  assert.ok(Array.isArray(out.participants));
});

test('stat_yardage is the official yardage, carried through unchanged', () => {
  for (const [name, f] of Object.entries(FIX)) {
    if (f.raw.statYardage === undefined) continue;
    assert.equal(play(f.raw).stat_yardage, f.raw.statYardage, `${name}: stat_yardage altered`);
  }
});

test('a missing upstream value stays null and is never coerced to zero', () => {
  const bare = play({ id: 'x', type: { id: '5', text: 'Rush' } });
  assert.equal(bare.stat_yardage, null);
  assert.equal(bare.is_turnover, null);
  assert.equal(bare.is_penalty, null);
  assert.equal(bare.start.team_id, null);
  assert.equal(bare.end.team_id, null);
});

test('is_turnover and is_penalty are booleans when reported', () => {
  const out = play(FIX.interception.raw);
  assert.equal(typeof out.is_turnover, 'boolean');
  assert.equal(out.is_turnover, true, 'the interception fixture is a turnover upstream');
  assert.equal(typeof out.is_penalty, 'boolean');
});

test('team ids identify the possession frame on both sides', () => {
  const intercept = play(FIX.interception.raw);
  assert.ok(intercept.start.team_id, 'start.team_id required to detect the frame');
  assert.ok(intercept.end.team_id, 'end.team_id required to detect the frame');
  assert.notEqual(intercept.start.team_id, intercept.end.team_id,
    'an interception must show a changed possession frame');

  const rush = play(FIX.rush.raw);
  assert.equal(rush.start.team_id, rush.end.team_id,
    'a rush that keeps the ball must show an unchanged possession frame');
});
