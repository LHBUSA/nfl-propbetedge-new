/* PBE Replay enrichment: the ESPN <-> nflverse join is a key join, absent
 * values stay absent, and nothing is enriched for a game nflverse has not
 * published. The fixture is five real rows from nflverse play_by_play_2026
 * (CC-BY-4.0), captured 2026-09-11. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, extractGame, joinRate } from '../api/_replay/nflverse.js';

const rows = parseCsv(readFileSync(new URL('./fixtures/nflverse-pbp-2026-sample.csv', import.meta.url), 'utf8'));

test('csv parser keeps quoted commas and doubled quotes', () => {
  const r = parseCsv('a,b\n"x, y","say ""hi"""\n');
  assert.deepEqual(r[1], ['x, y', 'say "hi"']);
});

test('ESPN play id = ESPN event id + nflverse play_id', () => {
  const { plays, count } = extractGame(rows, '2026_01_SF_LA', '401872657');
  assert.equal(count, 4);
  const td = plays['4018726571539'];
  assert.ok(td, 'the 39-yard Purdy -> Robinson touchdown joins by key');
  assert.equal(td.passer_player_name, 'B.Purdy');
  assert.equal(td.receiver_player_name, 'D.Robinson');
  assert.equal(td.air_yards, 39);
  assert.equal(td.epa, 4.056);
  assert.equal(td.touchdown, true);
  assert.ok(!('desc' in td), 'the play text is ESPN\'s; enrichment does not duplicate it');
});

test('NA stays absent — never a zero', () => {
  const { plays } = extractGame(rows, '2026_01_SF_LA', '401872657');
  const start = plays['4018726571'];                     // the GAME start row
  assert.ok(start);
  assert.ok(!('epa' in start) || Number.isFinite(start.epa));
  assert.ok(!('air_yards' in start), 'no pass, no air yards');
  assert.ok(!('touchdown' in start), 'a 0 flag is omitted, not false-as-data');
});

test('a game nflverse has not published enriches nothing', () => {
  const { count } = extractGame(rows, '2026_01_TB_CIN', '401872925');
  assert.equal(count, 0);
});

test('join rate is measured, not assumed', () => {
  const { plays } = extractGame(rows, '2026_01_SF_LA', '401872657');
  const r = joinRate(Object.keys(plays), ['4018726571539', '40187265740', '4018726579999']);
  assert.equal(r.joined, 2);
  assert.equal(r.espn_plays, 3);
});

test('a renamed column fails loudly', () => {
  assert.throws(() => extractGame([['id', 'gid']], 'x', '1'), /nflverse_schema_changed/);
});
