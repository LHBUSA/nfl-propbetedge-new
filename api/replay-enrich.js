/* GET /api/replay-enrich?event=<ESPN id>&season=2026&week=1&type=REG&away=SF&home=LAR
 *
 * PBE Replay's POST-GAME ENRICHED layer for one finished game: nflverse
 * play-by-play (CC-BY-4.0), keyed by the ESPN play id it joins to exactly —
 * see ./_replay/nflverse.js for why that join needs no matching heuristics.
 *
 * This is the prototype read path, deliberately bounded. It downloads the
 * season file from the nflverse release on a cache miss, which is fine while
 * the file is small (week 1: 0.1 MB gzipped) and wrong once it is not (a full
 * season is ~19 MB gzipped / ~100 MB CSV). Past MAX_GZ_BYTES it refuses with
 * ENRICHMENT_PIPELINE_REQUIRED instead of degrading: the production path is
 * the Cloudflare Workflow in NFL_REPLAY_ARCHITECTURE.md, which splits the
 * season file into per-game objects once per nflverse update.
 *
 * Nothing here is live. A game nflverse has not published yet returns
 * available:false with reason NOT_YET_PUBLISHED — never an empty success.
 */
import { gunzipSync } from 'node:zlib';
import { parseCsv, extractGame } from './_replay/nflverse.js';
import { nflverseGameId, nflverseCode } from '../workers/nfl-picks-engine-shared/current-slate.mjs';

const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download/pbp';
const MAX_GZ_BYTES = 8 * 1024 * 1024;

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl}` : 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  const q = req?.query || {};
  const event = String(q.event || '');
  const season = Number(q.season), week = Number(q.week);
  const type = String(q.type || 'REG').toUpperCase();
  const away = String(q.away || '').toUpperCase(), home = String(q.home || '').toUpperCase();
  if (!/^\d{6,12}$/.test(event) || !Number.isInteger(season) || !Number.isInteger(week) || !/^[A-Z]{2,3}$/.test(away) || !/^[A-Z]{2,3}$/.test(home)) {
    return send(res, 400, { available: false, error: 'bad_request', need: 'event, season, week, away, home (ESPN abbreviations)' });
  }
  const gameId = nflverseGameId({ season, seasonType: type, week, away: nflverseCode(away), home: nflverseCode(home) });
  if (!gameId) return send(res, 400, { available: false, error: 'unsupported_season_type', type });

  const url = `${RELEASE}/play_by_play_${season}.csv.gz`;
  const source = { dataset: `nflverse play_by_play_${season}`, url, license: 'CC-BY-4.0', attribution: 'nflverse', semantics: 'POST_GAME_ENRICHED' };
  let gz;
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return send(res, 502, { available: false, reason: `nflverse_${r.status}`, game_id: gameId, source });
    const len = Number(r.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_GZ_BYTES) {
      return send(res, 503, { available: false, reason: 'ENRICHMENT_PIPELINE_REQUIRED', detail: `season file is ${(len / 1048576).toFixed(1)} MB gzipped; the per-game pipeline must serve this`, game_id: gameId, source });
    }
    gz = Buffer.from(await r.arrayBuffer());
    source.last_modified = r.headers.get('last-modified') || null;
  } catch (error) {
    return send(res, 502, { available: false, reason: 'nflverse_unreachable', detail: String(error?.message || error), game_id: gameId, source });
  }
  if (gz.length > MAX_GZ_BYTES) return send(res, 503, { available: false, reason: 'ENRICHMENT_PIPELINE_REQUIRED', game_id: gameId, source });

  const text = gunzipSync(gz).toString('utf8');
  const nl = text.indexOf('\n');
  /* Only this game's lines are parsed; the header rides along. */
  const lines = [text.slice(0, nl), ...text.slice(nl + 1).split('\n').filter(l => l.includes(`"${gameId}"`) || l.includes(`,${gameId},`))];
  const { plays, count } = extractGame(parseCsv(lines.join('\n')), gameId, event);
  if (!count) return send(res, 200, { available: false, reason: 'NOT_YET_PUBLISHED', game_id: gameId, source, fetched_at: new Date().toISOString() }, 600);
  send(res, 200, { available: true, game_id: gameId, espn_event: event, plays_enriched: count, source, fetched_at: new Date().toISOString(), plays }, 3600);
}
