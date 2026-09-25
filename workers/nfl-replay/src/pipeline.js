/* nfl-replay pipeline + read logic — no Workers-only imports, so the same
 * code is exercised by the Node test suite. index.js adds the Workflow class,
 * the cron and the HTTP routing. */
import { COLUMNS, parseCsv, extractGame, createCsvParser, columnIndex, compactPlay, keyByEspn, gameMeta } from './nflverse.js';
import { aggregateGame, buildRollup, radarView, scriptView, OPPORTUNITY_VERSION, CONTRACT } from './opportunity.js';
import { nflverseCode, nflverseGameId } from '../../nfl-picks-engine-shared/current-slate.mjs';

export const VERSION = 'nfl-replay/1.1.0';
const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download/pbp';
export const TRANSITIONAL_MAX_GZ = 8 * 1024 * 1024;
export const PIPELINE_MAX_GZ = 96 * 1024 * 1024;   // streaming; a sanity bound, not a memory bound
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' };

export const assetUrl = season => `${RELEASE}/play_by_play_${season}.csv.gz`;
export const objectKey = (season, gameId) => `replay/${season}/${gameId}.json`;
export const indexKey = season => `replay/${season}/index.json`;
export const oppGameKey = (season, gameId) => `opportunity/${season}/games/${gameId}.json`;
export const rollupKey = season => `opportunity/${season}/rollup.json`;
/* nflverse's player table. Only two columns are read -- gsis_id and espn_id --
   for internal identity reconciliation (the owner-approved use of the id
   columns); no attribute column (name, position, team) is taken from it. */
export const PLAYERS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv';
const source = (season, extra = {}) => ({ dataset: `nflverse play_by_play_${season}`, url: assetUrl(season), license: 'CC-BY-4.0', attribution: 'nflverse', semantics: 'POST_GAME_ENRICHED', ...extra });

export function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': status === 200 && maxAge ? `public, max-age=${maxAge}` : 'no-store', 'x-pbe-runtime': VERSION }
  });
}

/* The season the nflverse file is named for: the NFL year starting in
   August. Only used by the cron; requests name their season explicitly. */
export function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 7 ? y : y - 1;
}

export async function probeAsset(fetchImpl = fetch, season) {
  const r = await fetchImpl(assetUrl(season), { method: 'HEAD', redirect: 'follow' });
  if (!r.ok) throw new Error(`nflverse_head_${r.status}`);
  return { url: assetUrl(season), last_modified: r.headers.get('last-modified'), etag: r.headers.get('etag'), size: Number(r.headers.get('content-length')) || null };
}

/* Stream the season file into one R2 object per game. The file is grouped by
   game (measured on 2025: 285 games, 285 contiguous runs), so exactly one
   game is held in memory; a game id seen twice would still merge correctly
   because objects are rebuilt from scratch per run. */
export async function streamIngest(env, season, asset, fetchImpl = fetch) {
  const r = await fetchImpl(asset.url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`nflverse_get_${r.status}`);
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > PIPELINE_MAX_GZ) throw new Error(`asset_too_large:${len}`);
  const ingestedAt = new Date().toISOString();
  let at = null, current = null, plays = {}, count = 0, meta = null;
  const pending = [];
  const games = {};
  const flush = () => {
    if (!current) return;
    const src = source(season, { asset_last_modified: asset.last_modified, asset_etag: asset.etag });
    const body = JSON.stringify({ game_id: current, season, count, plays, source: src, ingested_at: ingestedAt });
    /* The opportunity aggregate is derived from the same in-memory game, so
       it can never describe a different revision than the Replay object. */
    const agg = aggregateGame(plays, meta);
    games[current] = { plays: count, bytes: body.length, complete: agg.complete, week: agg.week, season_type: agg.season_type };
    const put = (key, value) => pending.push(env.REPLAY_R2.put(key, value, { httpMetadata: { contentType: 'application/json' }, customMetadata: { asset_last_modified: String(asset.last_modified || '') } }));
    put(objectKey(season, current), body);
    put(oppGameKey(season, current), JSON.stringify({ ...agg, version: OPPORTUNITY_VERSION, source: src, ingested_at: ingestedAt }));
  };
  const parser = createCsvParser(row => {
    if (!at) { at = columnIndex(row); return; }
    const gid = row[at.game_id];
    if (!gid) return;
    if (gid !== current) { flush(); current = gid; plays = {}; count = 0; meta = gameMeta(row, at, gid); }
    const play = compactPlay(row, at);
    if (play) { plays[play.play_id] = play; count++; }
  });
  const reader = r.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
    if (pending.length >= 8) await Promise.all(pending.splice(0));
  }
  parser.end();
  flush();
  await Promise.all(pending.splice(0));
  if (!at) throw new Error('nflverse_empty_file');
  const index = { season, asset, processed_at: new Date().toISOString(), columns: COLUMNS, games };
  await env.REPLAY_R2.put(indexKey(season), JSON.stringify(index), { httpMetadata: { contentType: 'application/json' } });
  return { season, games: Object.keys(games).length, plays: Object.values(games).reduce((a, g) => a + g.plays, 0), processed_at: index.processed_at };
}

/* ---- opportunity rollup ------------------------------------------------------ */

/* gsis_id -> espn_id for the ids asked about. Streams the players table; only
   the two id columns are read. A gsis id without an ESPN id, or an ESPN id
   claimed by two gsis ids, stays unresolved rather than guessed. */
export async function fetchCrosswalk(wanted, fetchImpl = fetch) {
  const need = new Set(wanted);
  const out = {}, claims = {};
  if (!need.size) return { map: out, fetched_at: null, last_modified: null };
  const r = await fetchImpl(PLAYERS_URL, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`nflverse_players_${r.status}`);
  let g = -1, e = -1;
  const parser = createCsvParser(row => {
    if (g < 0) { g = row.indexOf('gsis_id'); e = row.indexOf('espn_id'); if (g < 0 || e < 0) throw new Error('nflverse_players_schema_changed'); return; }
    const gsis = row[g], espn = row[e];
    if (!need.has(gsis) || !/^[0-9]{3,12}$/.test(espn || '')) return;
    out[gsis] = espn;
    (claims[espn] ||= []).push(gsis);
  });
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; parser.push(value); }
  parser.end();
  for (const ids of Object.values(claims)) if (ids.length > 1) for (const id of ids) delete out[id];
  return { map: out, fetched_at: new Date().toISOString(), last_modified: r.headers.get('last-modified') };
}

/* Rebuild the season contract from the per-game aggregates the last ingest
   wrote. Idempotent: the same objects always produce the same rollup (apart
   from generated_at), and a corrected nflverse file simply rewrites them. */
export async function rebuildOpportunity(env, season, fetchImpl = fetch) {
  const index = await env.REPLAY_R2.get(indexKey(season)).then(o => (o ? o.json() : null));
  if (!index) throw new Error('replay_not_ingested');
  const ids = Object.keys(index.games || {});
  const aggs = [];
  for (let i = 0; i < ids.length; i += 16) {
    const batch = await Promise.all(ids.slice(i, i + 16).map(id => env.REPLAY_R2.get(oppGameKey(season, id)).then(o => (o ? o.json() : null))));
    aggs.push(...batch.filter(Boolean));
  }
  if (aggs.length !== ids.length) throw new Error(`opportunity_aggregates_missing:${ids.length - aggs.length}`);
  const gsis = new Set();
  for (const g of aggs) for (const t of Object.values(g.teams || {})) for (const id of Object.keys(t.players || {})) gsis.add(id);
  const xw = await fetchCrosswalk(gsis, fetchImpl);
  const rollup = buildRollup(aggs, {
    season,
    crosswalk: xw.map,
    source: {
      dataset: `nflverse play_by_play_${season}`, url: assetUrl(season), license: 'CC-BY-4.0', attribution: 'nflverse',
      asset_last_modified: index.asset?.last_modified || null, asset_etag: index.asset?.etag || null,
      ingested_at: index.processed_at || null, revision: index.asset?.etag || index.asset?.last_modified || null,
      identity: { dataset: 'nflverse players (gsis_id, espn_id only)', url: PLAYERS_URL, fetched_at: xw.fetched_at, last_modified: xw.last_modified || null }
    }
  });
  await env.REPLAY_R2.put(rollupKey(season), JSON.stringify(rollup), { httpMetadata: { contentType: 'application/json' } });
  return { season, games: rollup.coverage.games_complete, players: rollup.players.length, highlights: rollup.highlights.length, identity: rollup.coverage.identity, revision: rollup.source.revision };
}

/* GET /api/replay/opportunity?season=&view=radar|script&team= */
export async function opportunity(env, url) {
  const q = url.searchParams;
  const season = Number(q.get('season'));
  const view = String(q.get('view') || 'radar');
  const team = q.get('team');
  if (!q.get('season') || !Number.isInteger(season) || season < 2020 || season > 2100) return json({ contract: CONTRACT, state: 'BAD_REQUEST', error: 'season required' }, 400);
  if (!['radar', 'script'].includes(view)) return json({ contract: CONTRACT, state: 'BAD_REQUEST', error: 'view must be radar or script' }, 400);
  if (team && !/^[A-Za-z]{2,3}$/.test(team)) return json({ contract: CONTRACT, state: 'BAD_REQUEST', error: 'team must be a 2-3 letter abbreviation' }, 400);
  if (view === 'script' && !team) return json({ contract: CONTRACT, state: 'BAD_REQUEST', error: 'team required for the script view' }, 400);
  const obj = await env.REPLAY_R2.get(rollupKey(season));
  if (!obj) {
    const index = await env.REPLAY_R2.get(indexKey(season)).then(o => (o ? o.json() : null));
    /* Not published is a state, not an error: 200 with a short cache. */
    return json({ contract: CONTRACT, version: OPPORTUNITY_VERSION, season, state: 'NOT_YET_PUBLISHED', detail: index ? 'play-by-play ingested; the opportunity rollup has not been built yet' : `no ${season} play-by-play has been ingested yet` }, 200, 120);
  }
  const rollup = await obj.json();
  const body = view === 'script' ? scriptView(rollup, team) : radarView(rollup, { team });
  return json({ ...body, state: 'READY', served_at: new Date().toISOString() }, 200, 300);
}

/* Start an ingest for the asset's current version. The instance id is the
   idempotency key: the same Last-Modified never ingests twice. */
export async function trigger(env, season, { force = false, fetchImpl = fetch } = {}) {
  const asset = await probeAsset(fetchImpl, season);
  const index = await env.REPLAY_R2.get(indexKey(season)).then(o => (o ? o.json() : null));
  if (!force && index?.asset?.last_modified && index.asset.last_modified === asset.last_modified) return { started: false, reason: 'asset_unchanged', asset };
  const stamp = Date.parse(asset.last_modified || '') || Date.now();
  const id = `pbp-${season}-${stamp}${force ? `-f${Date.now()}` : ''}`;
  try {
    const inst = await env.INGEST.create({ id, params: { season } });
    return { started: true, instance: inst.id, asset };
  } catch (e) {
    return { started: false, reason: 'instance_exists_or_failed', detail: String(e?.message || e), instance: id, asset };
  }
}

/* ---- read path --------------------------------------------------------------- */
export async function transitionalRead(season, gameId, event, fetchImpl = fetch) {
  const url = assetUrl(season);
  const r = await fetchImpl(url, { redirect: 'follow' });
  if (!r.ok) return json({ available: false, reason: `nflverse_${r.status}`, game_id: gameId, source: source(season) }, 502);
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > TRANSITIONAL_MAX_GZ) {
    return json({ available: false, reason: 'POST_GAME_ENRICHMENT_UNAVAILABLE', detail: `pipeline has not ingested season ${season} and the file (${(len / 1048576).toFixed(1)} MB gzipped) exceeds the transitional bound`, game_id: gameId, source: source(season) }, 503);
  }
  const buf = await r.arrayBuffer();
  if (buf.byteLength > TRANSITIONAL_MAX_GZ) return json({ available: false, reason: 'POST_GAME_ENRICHMENT_UNAVAILABLE', game_id: gameId, source: source(season) }, 503);
  const text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const nl = text.indexOf('\n');
  const lines = [text.slice(0, nl), ...text.slice(nl + 1).split('\n').filter(l => l.includes(`"${gameId}"`) || l.includes(`,${gameId},`))];
  const { plays, count } = extractGame(parseCsv(lines.join('\n')), gameId, event);
  const src = source(season, { last_modified: r.headers.get('last-modified'), read_path: 'TRANSITIONAL_BOUNDED_READ' });
  if (!count) return json({ available: false, reason: 'NOT_YET_PUBLISHED', game_id: gameId, source: src }, 200, 600);
  return json({ available: true, game_id: gameId, espn_event: event, plays_enriched: count, source: src, fetched_at: new Date().toISOString(), plays }, 200, 3600);
}

export async function enrich(env, url, fetchImpl = fetch) {
  const q = url.searchParams;
  const event = String(q.get('event') || '');
  const season = Number(q.get('season')), week = Number(q.get('week'));
  const type = String(q.get('type') || 'REG').toUpperCase();
  const away = String(q.get('away') || '').toUpperCase(), home = String(q.get('home') || '').toUpperCase();
  if (!/^\d{6,12}$/.test(event) || !q.get('season') || !q.get('week') || !Number.isInteger(season) || !Number.isInteger(week) || !/^[A-Z]{2,3}$/.test(away) || !/^[A-Z]{2,3}$/.test(home)) {
    return json({ available: false, error: 'bad_request', need: 'event, season, week, away, home (ESPN abbreviations)' }, 400);
  }
  const gameId = nflverseGameId({ season, seasonType: type, week, away: nflverseCode(away), home: nflverseCode(home) });
  if (!gameId) return json({ available: false, error: 'unsupported_season_type', type }, 400);

  const obj = await env.REPLAY_R2.get(objectKey(season, gameId));
  if (obj) {
    const doc = await obj.json();
    return json({ available: true, game_id: gameId, espn_event: event, plays_enriched: doc.count, source: { ...doc.source, read_path: 'R2_INGESTED', ingested_at: doc.ingested_at }, fetched_at: new Date().toISOString(), plays: keyByEspn(doc.plays, event) }, 200, 3600);
  }
  const index = await env.REPLAY_R2.get(indexKey(season)).then(o => (o ? o.json() : null));
  if (index) {
    return json({ available: false, reason: 'NOT_YET_PUBLISHED', detail: `not in the nflverse file as of the last ingest (asset ${index.asset?.last_modified || 'unknown'}, processed ${index.processed_at})`, game_id: gameId, source: source(season, { read_path: 'R2_INGESTED', asset_last_modified: index.asset?.last_modified || null }) }, 200, 600);
  }
  return transitionalRead(season, gameId, event, fetchImpl);
}

export async function health(env, url) {
  const season = Number(url.searchParams.get('season')) || currentSeason();
  const [index, last] = await Promise.all([
    env.REPLAY_R2.get(indexKey(season)).then(o => (o ? o.json() : null)),
    env.REPLAY_R2.get(`replay/${season}/last-run.json`).then(o => (o ? o.json() : null))
  ]);
  return json({ service: 'nfl-replay', version: VERSION, season, ingested: Boolean(index), asset: index?.asset || null, processed_at: index?.processed_at || null, games: index ? Object.keys(index.games).length : 0, last_run: last, checked_at: new Date().toISOString() });
}

