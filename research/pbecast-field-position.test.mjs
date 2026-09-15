/* PBEcast field-position semantics: the real pbecast-v6.js in a sandbox.
 *
 * ESPN's situation.possessionText is the spot of the ball, not the team with
 * it, and yardLine is a 0-100 coordinate. Observed live on 2026-09-14 (DEN @
 * KC): possession_id DEN, possession_text "DEN 39", yard_line 61 rendered as
 * "POSSESSION DEN 39 · BALL 61". It must read POSSESSION DEN, FIELD POSITION
 * DEN 39, and the coordinate must never be shown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const noop = () => {};
function loadV6() {
  const window = { App: null, addEventListener: noop };
  const ctx = { window, document: { addEventListener: noop, querySelector: () => null, visibilityState: 'visible' }, localStorage: { getItem: () => null, setItem: noop }, sessionStorage: { getItem: () => null, removeItem: noop }, setTimeout: noop, clearTimeout: noop, console, AbortController, Date, JSON, Math, Number, String, Array, Map, Set, Object, Promise };
  vm.runInNewContext(readFileSync(new URL('../pbecast-v6.js', import.meta.url), 'utf8'), ctx);
  return window.PBEcastV6;
}
const V6 = loadV6();
const pulseWindow = { PBEcastV6: V6 };
vm.runInNewContext(readFileSync(new URL('../pbecast-pulse-v1.js', import.meta.url), 'utf8'), { window: pulseWindow, document: { addEventListener: noop }, JSON, Math, Number, String, Array, Map, Set, Object });
const Pulse = pulseWindow.PBEcastPulse;

const DEN = { id: '7', abbreviation: 'DEN', display_name: 'Denver Broncos', score: 7 };
const KC = { id: '12', abbreviation: 'KC', display_name: 'Kansas City Chiefs', score: 7 };
const detail = situation => ({
  source: { semantics: 'LIVE', provider: 'espn_site_scoreboard' },
  game: { id: '401872931', status: { semantics: 'LIVE', period: 2, clock: '6:46', short_detail: '6:46 - 2nd' }, teams: { away: DEN, home: KC }, situation },
  current_play: null
});
const facts = d => Object.fromEntries([...V6.situationFacts(d)].map(([k, v]) => [k, v]));
function hero(d) {
  V6.state.detail = d;
  const html = V6.heroHtml();
  V6.state.detail = null;
  return html;
}
const factRows = html => [...html.matchAll(/<div><span>([^<]+)<\/span><b>([^<]+)<\/b><\/div>/g)].map(m => `${m[1]}=${m[2]}`);

test('observed DEN @ KC case: POSSESSION DEN, FIELD POSITION DEN 39, never BALL 61', () => {
  const d = detail({ possession_id: '7', possession_text: 'DEN 39', yard_line: 61, down_distance_text: '4th & 5', red_zone: false });
  const f = facts(d);
  assert.equal(f.POSSESSION, 'DEN');
  assert.equal(f['DOWN & DISTANCE'], '4th & 5');
  assert.equal(f['FIELD POSITION'], 'DEN 39');
  assert.equal(f.BALL, undefined);
  const rows = factRows(hero(d));
  assert.ok(rows.includes('POSSESSION=DEN'), rows.join(' | '));
  assert.ok(rows.includes('FIELD POSITION=DEN 39'), rows.join(' | '));
  assert.ok(!rows.some(r => r.startsWith('BALL')), 'BALL never appears');
  assert.ok(!rows.some(r => /=61$/.test(r)), 'the raw coordinate 61 never renders as a fact');
  assert.ok(!rows.includes('POSSESSION=DEN 39'), 'field position is never labelled possession');
});

test('home possession on its own side', () => {
  const f = facts(detail({ possession_id: '12', possession_text: 'KC 22', yard_line: 78, down_distance_text: '1st & 10' }));
  assert.equal(f.POSSESSION, 'KC');
  assert.equal(f['FIELD POSITION'], 'KC 22');
});

test('away possession on its own side', () => {
  const f = facts(detail({ possession_id: '7', possession_text: 'DEN 25', yard_line: 75, down_distance_text: '1st & 10' }));
  assert.equal(f.POSSESSION, 'DEN');
  assert.equal(f['FIELD POSITION'], 'DEN 25');
});

test('crossing midfield: the offense is DEN, the ball is on the KC side', () => {
  const f = facts(detail({ possession_id: '7', possession_text: 'KC 45', yard_line: 45, down_distance_text: '2nd & 4' }));
  assert.equal(f.POSSESSION, 'DEN');
  assert.equal(f['FIELD POSITION'], 'KC 45');
});

test('midfield is 50', () => {
  const f = facts(detail({ possession_id: '12', possession_text: '50', yard_line: 50, down_distance_text: '4th & 14' }));
  assert.equal(f.POSSESSION, 'KC');
  assert.equal(f['FIELD POSITION'], '50');
});

test('red zone', () => {
  const f = facts(detail({ possession_id: '12', possession_text: 'DEN 12', yard_line: 12, down_distance_text: '3rd & 2', red_zone: true }));
  assert.equal(f.POSSESSION, 'KC');
  assert.equal(f['FIELD POSITION'], 'DEN 12');
  assert.equal(f['RED ZONE'], 'YES');
});

test('possession change: the next frame names the new offense and its spot', () => {
  const before = facts(detail({ possession_id: '7', possession_text: 'DEN 39', yard_line: 61, down_distance_text: '4th & 5' }));
  const after = facts(detail({ possession_id: '12', possession_text: 'KC 40', yard_line: 60, down_distance_text: '1st & 10' }));
  assert.deepEqual([before.POSSESSION, before['FIELD POSITION']].join(), 'DEN,DEN 39');
  assert.deepEqual([after.POSSESSION, after['FIELD POSITION']].join(), 'KC,KC 40');
});

test('unverifiable field position is omitted, and the coordinate is still never shown', () => {
  for (const possession_text of [undefined, '', 'XYZ 39', 'DEN 61', 'DEN 0', '39', 'Denver 39', 'DEN39']) {
    const d = detail({ possession_id: '7', possession_text, yard_line: 61, down_distance_text: '4th & 5' });
    const f = facts(d);
    assert.equal(f['FIELD POSITION'], undefined, `omit for ${JSON.stringify(possession_text)}`);
    assert.equal(f.BALL, undefined);
    assert.ok(!factRows(hero(d)).some(r => /=61$/.test(r)));
  }
});

test('possession is only a team matched by id; an unknown id shows no possession', () => {
  assert.equal(facts(detail({ possession_id: '99', possession_text: 'DEN 39' })).POSSESSION, undefined);
  assert.equal(facts(detail({ possession_text: 'DEN 39' })).POSSESSION, undefined);
});

test('field strip label uses the verified spot; geometry may still use the coordinate', () => {
  V6.state.detail = null;
  const d = detail({ possession_id: '7', possession_text: 'DEN 39', yard_line: 61, down_distance_text: '4th & 5' });
  const html = hero(d);
  assert.doesNotMatch(html, /POSSESSION<\/span><b>DEN 39/);
});

test('Game Pulse state line: team in possession, down and distance at the verified spot', () => {
  const d = detail({ possession_id: '7', possession_text: 'DEN 39', yard_line: 61, down_distance_text: '4th & 5' });
  assert.equal(Pulse.stateLine(d), '6:46 - 2nd · DEN ball · 4th & 5 at DEN 39');
  const bad = detail({ possession_id: '7', possession_text: 'XYZ 1', yard_line: 61, down_distance_text: '4th & 5' });
  assert.equal(Pulse.stateLine(bad), '6:46 - 2nd · DEN ball · 4th & 5');
  assert.doesNotMatch(Pulse.stateLine(bad), /61/);
});

test('painted game carries the scoreboard situation when both lanes stand at the same moment', () => {
  const status = { semantics: 'LIVE', period: 3, clock: '5:00' };
  const fast = { id: '401872931', status, teams: { away: DEN, home: KC }, situation: { possession_id: '12', possession_text: 'KC 31', yard_line: 69, down_distance_text: '2nd & 10' } };
  const summary = { id: '401872931', status, teams: { away: DEN, home: KC }, situation: { possession_id: '12' } };
  V6.state.detail = { source: { semantics: 'LIVE' } };
  V6.state.fastGame = fast; V6.state.detailGame = summary;
  V6.promoteGame();
  const f = facts(V6.state.detail);
  assert.equal(f.POSSESSION, 'KC');
  assert.equal(f['FIELD POSITION'], 'KC 31');
  /* a summary strictly ahead does not borrow a spot from an earlier moment */
  V6.state.detailGame = { ...summary, status: { ...status, clock: '4:10' } };
  V6.promoteGame();
  assert.equal(facts(V6.state.detail)['FIELD POSITION'], undefined);
  V6.state.detail = null; V6.state.fastGame = null; V6.state.detailGame = null;
});
