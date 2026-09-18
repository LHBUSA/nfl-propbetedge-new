/* API contract over the 2023 technical-validation slice.
 * Requires the slice database: npm --prefix history run slice:load
 * (skips itself when the database is absent, so CI without the slice is green).
 *
 *   node --test history/tests/slice-api.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHistoryApi } from '../api/history-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', '.out', 'pg');
const hasSlice = existsSync(DB_DIR);

let api, db;
if (hasSlice) {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite(DB_DIR);
  api = createHistoryApi({ query: (sql, params) => db.query(sql, params) });
}

const get = async path => {
  const r = await api(new Request(`https://history.test${path}`));
  return { status: r.status, body: await r.json() };
};
const t = (name, fn) => test(name, { skip: hasSlice ? false : 'slice database not built' }, fn);

t('sources: the registry is served with each verdict and display policy', async () => {
  const { body } = await get('/v1/history/sources');
  const pbp = body.data.find(s => s.source_id === 'src_nflverse_pbp');
  const wd = body.data.find(s => s.source_id === 'src_wikidata');
  assert.equal(pbp.commercial_verdict, 'review');
  assert.equal(pbp.display_policy, 'internal_only');
  assert.equal(pbp.model_use_allowed, false);
  assert.equal(wd.display_policy, 'public');
});

t('rights: play-by-play is withheld from public and pro, and served internally', async () => {
  const game = (await get('/v1/history/games?season=2023&surface=internal')).body.data[0];
  for (const surface of ['public', 'pro']) {
    const r = await get(`/v1/history/games/${game.game_id}/plays?surface=${surface}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, [], `${surface} must see no plays from a REVIEW source`);
    assert.equal(r.body.rights.surface, surface);
  }
  const internal = await get(`/v1/history/games/${game.game_id}/plays?surface=internal`);
  assert.ok(internal.body.data.length > 100);
  assert.equal(internal.body.provenance.sources[0].source_id, 'src_nflverse_pbp');
});

t('rights: CC0 franchise lineage is public', async () => {
  const franchises = await db.query(`select global_football_franchise_id id from football.franchise order by id limit 1`);
  const { body } = await get(`/v1/history/franchises/${franchises.rows[0].id}/lineage?surface=public`);
  assert.ok(body.data.identities.length >= 1);
  assert.equal(body.provenance.sources[0].licence_class, 'cc0');
});

t('every response carries provenance and an as-of pair', async () => {
  const { body } = await get('/v1/history/games?season=2023&surface=internal');
  assert.ok(body.provenance.sources.length >= 1);
  assert.ok(Object.hasOwn(body.provenance, 'derived'));
  assert.ok(Object.hasOwn(body.provenance.as_of, 'valid_at'));
});

t('game package: score, periods and drives come from canonical rows', async () => {
  const games = await get('/v1/history/games?season=2023&surface=internal');
  const sb = games.body.data.find(g => g.week_label === 'Super Bowl');
  const { body } = await get(`/v1/history/games/${sb.game_id}?surface=internal`);
  assert.equal(body.data.scores.length, 2);
  assert.equal(body.data.scores.reduce((n, s) => n + s.final_score, 0), sb.home_score + sb.away_score);
  assert.ok(body.data.drives.length > 10);
  assert.equal(body.data.overtime_periods > 0, true, 'Super Bowl LVIII went to overtime');
  assert.equal(body.data.kickoff_precision, 'date_only', 'kickoff instant is not claimed without a source');
});

t('standings are labelled derived; leaderboards too', async () => {
  const standings = await get('/v1/history/seasons/nfl/2023/standings?surface=internal');
  assert.equal(standings.body.provenance.derived, true);
  assert.equal(standings.body.data.length, 32);
  assert.equal(standings.body.data[0].wins + standings.body.data[0].losses + standings.body.data[0].ties, 17);
  const leaders = await get('/v1/history/leaderboards?stat=passing_yards&season=2023&surface=internal');
  assert.equal(leaders.body.provenance.derived, true);
  assert.ok(leaders.body.data[0].value > 3000);
});

t('player passport carries ids and the source position label', async () => {
  const leaders = await get('/v1/history/leaderboards?stat=passing_yards&season=2023&surface=internal');
  const name = leaders.body.data[0].display_name;
  const row = await db.query(
    `select pl.global_football_player_id id from football.player pl
     join football.person_name n on n.global_football_person_id = pl.global_football_person_id
     where n.display_name = $1 limit 1`, [name]);
  const { body } = await get(`/v1/history/players/${row.rows[0].id}?surface=internal`);
  assert.equal(body.data.display_name, name);
  assert.ok(body.data.external_ids.some(x => x.id_system === 'nfl_gsis_id'));
  assert.ok(body.data.positions.every(p => typeof p.source_label === 'string'));
  const log = await get(`/v1/history/players/${row.rows[0].id}/gamelog?season=2023&surface=internal`);
  assert.ok(log.body.data.length >= 15);
  assert.ok(log.body.data[0].stats.passing_yards !== undefined);
});

t('roster AS-OF: knowledge time before ingestion returns nobody', async () => {
  // 'KC' is nflverse's code for this identity, not a property of the club, so
  // it resolves through the external identifier that records whose code it is.
  const team = await db.query(`select entity_id id from football_src.external_id
     where entity_type='team_identity' and id_system='nflverse_team_abbr' and id_value='KC' limit 1`);
  const inSeason = await get(`/v1/history/rosters/${team.rows[0].id}?valid_at=2023-11-01&surface=internal`);
  assert.ok(inSeason.body.data.length > 40);
  assert.equal(inSeason.body.provenance.as_of.valid_at, '2023-11-01');
  const beforeKnown = await get(`/v1/history/rosters/${team.rows[0].id}?valid_at=2023-11-01&known_at=2023-01-01T00:00:00Z&surface=internal`);
  assert.deepEqual(beforeKnown.body.data, [], 'nothing observed after the cutoff may appear');
});

t('unknown routes, surfaces and methods are refused', async () => {
  assert.equal((await get('/v1/history/nope')).status, 404);
  assert.equal((await get('/v1/history/games?surface=marketing')).status, 400);
  const post = await api(new Request('https://history.test/v1/history/games', { method: 'POST' }));
  assert.equal(post.status, 405);
});

test('close', { skip: hasSlice ? false : 'slice database not built' }, async () => { await db.close(); });
