/* nfl-replay: ingest once into R2, read many. Runs the Worker's pipeline code
 * against an in-memory R2 and a stubbed nflverse release, using five real
 * nflverse rows (CC-BY-4.0) as the season file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { streamIngest, enrich, trigger, TRANSITIONAL_MAX_GZ } from '../workers/nfl-replay/src/pipeline.js';

const csv = readFileSync(new URL('./fixtures/nflverse-pbp-2026-sample.csv', import.meta.url));
const gz = gzipSync(csv);

function r2() {
  const m = new Map();
  return {
    map: m,
    async put(k, v) { m.set(k, typeof v === 'string' ? v : String(v)); return { key: k }; },
    async get(k) { if (!m.has(k)) return null; const v = m.get(k); return { json: async () => JSON.parse(v) }; }
  };
}
/* Serve the gz in deliberately tiny chunks so CSV rows straddle boundaries. */
function chunkedFetch(buf, { size = 97, contentLength = buf.length } = {}) {
  return async () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < buf.length; i += size) c.enqueue(buf.subarray(i, i + size)); c.close(); }
  }), { headers: { 'content-length': String(contentLength), 'last-modified': 'Fri, 11 Sep 2026 14:01:43 GMT' } });
}
const asset = { url: 'https://example/pbp.csv.gz', last_modified: 'Fri, 11 Sep 2026 14:01:43 GMT', etag: 'e1', size: gz.length };
const q = s => new URL(`https://x/api/replay/enrich?${s}`);

test('streaming ingest writes one object per game and a season index', async () => {
  const env = { REPLAY_R2: r2() };
  const res = await streamIngest(env, 2026, asset, chunkedFetch(gz));
  assert.equal(res.games, 2);
  const sfla = JSON.parse(env.REPLAY_R2.map.get('replay/2026/2026_01_SF_LA.json'));
  assert.equal(sfla.count, 4);
  assert.equal(sfla.plays['1539'].receiver_player_name, 'D.Robinson');
  assert.equal(sfla.source.license, 'CC-BY-4.0');
  const index = JSON.parse(env.REPLAY_R2.map.get('replay/2026/index.json'));
  assert.deepEqual(Object.keys(index.games).sort(), ['2026_01_NE_SEA', '2026_01_SF_LA']);
});

test('read path: an ingested game joins by ESPN play id', async () => {
  const env = { REPLAY_R2: r2() };
  await streamIngest(env, 2026, asset, chunkedFetch(gz));
  const res = await enrich(env, q('event=401872657&season=2026&week=1&type=REG&away=SF&home=LAR'), async () => { throw new Error('must not fetch'); });
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.source.read_path, 'R2_INGESTED');
  assert.equal(body.plays['4018726571539'].epa, 4.056);
});

test('read path: a game absent from the ingested file is NOT_YET_PUBLISHED', async () => {
  const env = { REPLAY_R2: r2() };
  await streamIngest(env, 2026, asset, chunkedFetch(gz));
  const body = await (await enrich(env, q('event=401872925&season=2026&week=1&type=REG&away=TB&home=CIN'), async () => { throw new Error('must not fetch'); })).json();
  assert.equal(body.available, false);
  assert.equal(body.reason, 'NOT_YET_PUBLISHED');
});

test('transitional read: never over the bound, and says POST_GAME_ENRICHMENT_UNAVAILABLE', async () => {
  const env = { REPLAY_R2: r2() };
  const res = await enrich(env, q('event=401872657&season=2026&week=1&type=REG&away=SF&home=LAR'), chunkedFetch(gz, { contentLength: TRANSITIONAL_MAX_GZ + 1 }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).reason, 'POST_GAME_ENRICHMENT_UNAVAILABLE');
});

test('transitional read: within the bound it serves the game, labelled transitional', async () => {
  const env = { REPLAY_R2: r2() };
  const body = await (await enrich(env, q('event=401872657&season=2026&week=1&type=REG&away=SF&home=LAR'), chunkedFetch(gz))).json();
  assert.equal(body.available, true);
  assert.equal(body.source.read_path, 'TRANSITIONAL_BOUNDED_READ');
});

test('bad requests are refused, never guessed', async () => {
  const env = { REPLAY_R2: r2() };
  const res = await enrich(env, q('event=401872657&season=2026&away=SF&home=LAR'));
  assert.equal(res.status, 400);
});

test('trigger is idempotent on an unchanged asset', async () => {
  const env = { REPLAY_R2: r2(), INGEST: { create: async () => { throw new Error('must not start'); } } };
  await streamIngest(env, 2026, asset, chunkedFetch(gz));
  const res = await trigger(env, 2026, { fetchImpl: async () => new Response(null, { headers: { 'last-modified': asset.last_modified, 'content-length': String(gz.length) } }) });
  assert.equal(res.started, false);
  assert.equal(res.reason, 'asset_unchanged');
});
