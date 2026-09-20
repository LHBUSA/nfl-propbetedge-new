/* Build data/dist/nfl-season-history.v1.json from approved Wikidata
 * CC0 season ontology + Super Bowl result facts.
 *
 * Release-time only:
 *   node scripts/build-season-history-snapshot.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CONTRACT, SNAPSHOT_VERSION, SOURCE_ID, SOURCE_ENDPOINT,
  SEASONS_QUERY, SUPER_BOWL_QUERY, normalizeSeasons, normalizeChampionships,
} from '../api/season-history.js';

const OUT = join(process.cwd(), 'data', 'dist', 'nfl-season-history.v1.json');
const UA = 'PropBetEdgeNFLSeasonHistoryBuilder/1.0 (https://nfl.propbetedge.ai; sales@proptechusa.ai)';
const TIMEOUT_MS = 120000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sparql(query) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const body = new URLSearchParams({ query, format: 'json' });
      const response = await fetch(SOURCE_ENDPOINT, {
        method: 'POST',
        headers: {
          accept: 'application/sparql-results+json',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'user-agent': UA,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`wikidata_http_${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json?.results?.bindings)) throw new Error('wikidata_shape');
      return json.results.bindings;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 3000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('wikidata_unavailable');
}

const seasonBindings = await sparql(SEASONS_QUERY);
const championshipBindings = await sparql(SUPER_BOWL_QUERY);

const seasonRows = normalizeSeasons(seasonBindings);
const championshipRows = normalizeChampionships(championshipBindings);
if (seasonRows.length < 100) throw new Error(`season_snapshot_incomplete_${seasonRows.length}`);

const championshipByYear = new Map();
for (const row of championshipRows) {
  const previous = championshipByYear.get(row.season_year);
  if (!previous || (!previous.winner && row.winner)) championshipByYear.set(row.season_year, row);
}

const seasons = seasonRows.map(season => ({
  ...season,
  championship: championshipByYear.get(season.year) || null,
}));

const retrievedAt = new Date().toISOString();
const seasonSha256 = createHash('sha256').update(JSON.stringify(seasonRows)).digest('hex');
const championshipSha256 = createHash('sha256').update(JSON.stringify(championshipRows)).digest('hex');
const contentSha256 = createHash('sha256').update(JSON.stringify(seasons)).digest('hex');

const snapshot = {
  contract: CONTRACT,
  version: SNAPSHOT_VERSION,
  season_count: seasons.length,
  championship_result_count: seasons.filter(s => s.championship).length,
  championships_with_winner: seasons.filter(s => s.championship?.winner).length,
  content_sha256: contentSha256,
  source: {
    source_id: SOURCE_ID,
    name: 'Wikidata',
    licence: 'CC0-1.0',
    endpoint: SOURCE_ENDPOINT,
    retrieved_at: retrievedAt,
    snapshots: {
      league_seasons: { content_sha256: seasonSha256, query: SEASONS_QUERY },
      super_bowls: { content_sha256: championshipSha256, query: SUPER_BOWL_QUERY },
    },
    note: 'Season identity uses Wikidata P3450. Championship context uses Super Bowl items and only the winner/date/venue fields the source actually carries. No score, runner-up, MVP, award, statistical leader or narrative is inferred.',
  },
  seasons,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log('NFL SEASON HISTORY SNAPSHOT BUILT', {
  seasons: snapshot.season_count,
  championship_results: snapshot.championship_result_count,
  championships_with_winner: snapshot.championships_with_winner,
  retrieved_at: retrievedAt,
  content_sha256: contentSha256,
  output: OUT,
});
