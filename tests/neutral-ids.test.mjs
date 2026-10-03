// Neutral public identifiers (PropSports data contract, 2026-10-03): player_id / game_id / team_id are ADDED next to
// deprecated lane identifiers; legacy fields and ?espn_id= keep working; player_id is the canonical gsis id and is
// never filled with a lane value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { playerIdFor, laneIdFor, athleteParam, gameParam, markDeprecatedIds, GSIS_RE } from '../api/_neutral-ids.js';
import { laneToPlayer, neutralizeIds, laneIdFrom } from '../workers/nfl-picks-engine-shared/neutral-ids.mjs';
import qbDna from '../api/qb-dna.js';
import collegePath from '../api/nfl-college-path.js';
import nflMedia from '../api/nfl-media.js';
import playerCareer from '../api/player-career.js';
import { gameView } from '../api/_td-game-view.js';

const XW = JSON.parse(readFileSync(join(process.cwd(), 'data', 'dist', 'player-id-crosswalk.json'), 'utf8'));
const [LANE, GSIS] = Object.entries(XW.lane_to_player_id)[0];

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = (s) => { if (s != null && r.body == null) r.body = JSON.parse(s); return r; };
  return r;
}
const call = async (h, query) => { const res = mockRes(); await h({ method: 'GET', query, headers: {} }, res); return res; };

test('crosswalk: canonical gsis player_id <-> lane id, conflicts dropped, never a lane value as player_id', () => {
  assert.ok(XW.count > 1000);
  assert.match(GSIS, GSIS_RE);
  assert.equal(playerIdFor(LANE), GSIS);
  assert.equal(laneIdFor(GSIS), LANE);
  assert.equal(playerIdFor('999999999'), null);
  assert.equal(laneIdFor(LANE), null, 'a lane value is not a player_id');
});

test('params: ?player_id= and legacy ?espn_id= resolve to the same lane id; ?game_id= beats legacy keys', () => {
  assert.deepEqual(athleteParam({ espn_id: LANE }).laneId, LANE);
  assert.deepEqual(athleteParam({ player_id: GSIS }).laneId, LANE);
  assert.equal(athleteParam({ player_id: '00-9999999' }).laneId, null);
  assert.equal(gameParam({ game_id: '401', espn_id: '402' }), '401');
  assert.equal(gameParam({ event: '403' }), '403');
});

test('markDeprecatedIds lists legacy id keys and leaves values untouched', () => {
  const b = markDeprecatedIds({ ok: true, player: { espn_id: '1', player_id: 'x' }, home_team_espn_id: '9', team_id: 'KC' });
  assert.deepEqual(b.deprecated_fields, ['espn_id', 'home_team_espn_id']);
  assert.match(b.deprecation_note, /future versioned contract/);
  assert.equal(b.player.espn_id, '1');
  assert.equal(markDeprecatedIds({ ok: true, player_id: 'x' }).deprecated_fields, undefined);
});

test('QB DNA list: every row carries player_id (= gsis_id) beside the deprecated espn_id', async () => {
  const res = await call(qbDna, { list: '1' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.players.length > 0);
  for (const p of res.body.players) { assert.equal(p.player_id, p.gsis_id); assert.ok('espn_id' in p); }
  assert.ok(res.body.deprecated_fields.includes('espn_id'));
});

test('College Path: ?player_id= answers exactly like the deprecated ?espn_id=, and both bodies carry player_id', async () => {
  const art = JSON.parse(readFileSync(join(process.cwd(), 'data', 'dist', 'college-path.json'), 'utf8'));
  const lane = Object.keys(art.players).find((id) => playerIdFor(id));
  const pid = playerIdFor(lane);
  const a = await call(collegePath, { espn_id: lane });
  const b = await call(collegePath, { player_id: pid });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.deepEqual(b.body, a.body);
  assert.equal(a.body.player_id, pid);
  assert.equal(a.body.espn_id, lane);
  const miss = await call(collegePath, { player_id: '00-9999999' });
  assert.equal(miss.statusCode, 404);
});

test('Media: ?player_id= resolves the same headshot as ?espn_id=; team blocks carry team_id', async () => {
  const a = await call(nflMedia, { kind: 'player', espn_id: LANE });
  const b = await call(nflMedia, { kind: 'player', player_id: GSIS });
  assert.equal(a.body.image, b.body.image);
  assert.equal(b.body.player_id, GSIS);
  const t = await call(nflMedia, { kind: 'team', abbr: 'kc' });
  assert.equal(t.body.team_id, 'KC');
});

test('Career: an unknown ?player_id= is a 404 not_tracked (never a name match); a missing id keeps the legacy 400 code', async () => {
  const miss = await call(playerCareer, { player_id: '00-9999999' });
  assert.equal(miss.statusCode, 404);
  assert.equal(miss.body.error, 'not_tracked');
  const none = await call(playerCareer, {});
  assert.equal(none.statusCode, 400);
  assert.equal(none.body.error, 'espn_id_required');
});

test('TD game view: ?game_id= is accepted and echoed as game_id beside the deprecated espn_id', async () => {
  const sent = {};
  const send = (_res, status, body) => { sent.status = status; sent.body = body; };
  await gameView({ res: {}, send, sb: async () => [], secret: 'x', query: { game_id: '401772510' }, resolveAccess: async () => ({ tier: 'anonymous' }), driversFrom: () => [] });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.game_id, '401772510');
  assert.equal(sent.body.espn_id, '401772510');
});

test('Worker boundary: player objects gain player_id from the bundled crosswalk; envelope lists deprecated ids', () => {
  const map = laneToPlayer(XW);
  const body = neutralizeIds({ ok: true, player: { espn_id: LANE, name: 'X' }, rows: [{ player: { espn_id: '1' } }], espn_id: LANE }, map);
  assert.equal(body.player.player_id, GSIS);
  assert.equal(body.rows[0].player.player_id, undefined, 'unproven pair stays without player_id');
  assert.ok(body.deprecated_fields.includes('espn_id'));
  assert.equal(laneIdFrom(map, GSIS), LANE);
  assert.deepEqual(neutralizeIds([1, 2], map), [1, 2]);
});
