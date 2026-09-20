/* GET /api/season-history
 *
 * Rights-clean NFL season archive. The request path serves a versioned release
 * snapshot built from Wikidata CC0 season and Super Bowl structured facts.
 * It never reads the retained legacy season encyclopedia.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONTRACT = 'pbe-nfl-season-history-v1';
export const SNAPSHOT_VERSION = '1.0.0';
export const SOURCE_ID = 'src_wikidata';
export const SOURCE_ENDPOINT = 'https://query.wikidata.org/sparql';
export const NFL_QID = 'Q1215884';

export const SEASONS_QUERY = `
SELECT ?season ?seasonLabel ?league ?date ?start ?end WHERE {
  VALUES ?league { wd:Q1215884 wd:Q464508 wd:Q389307 }
  ?season wdt:P3450 ?league .
  OPTIONAL { ?season wdt:P585 ?date }
  OPTIONAL { ?season wdt:P580 ?start }
  OPTIONAL { ?season wdt:P582 ?end }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?date
`.trim();

export const SUPER_BOWL_QUERY = `
SELECT ?game ?gameLabel ?class ?date ?winner ?winnerLabel ?venue ?venueLabel WHERE {
  ?game wdt:P31 ?class .
  VALUES ?class { wd:Q32096 }
  OPTIONAL { ?game wdt:P585 ?date }
  OPTIONAL { ?game wdt:P1346 ?winner }
  OPTIONAL { ?game wdt:P276 ?venue }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?date
`.trim();

function value(row, key) {
  const v = row?.[key]?.value;
  return v == null ? null : String(v);
}

function qidFromUrl(v) {
  return /^https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/.exec(String(v || ''))?.[1] || null;
}

function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function normalizeSeasons(bindings = []) {
  const byYear = new Map();
  for (const row of Array.isArray(bindings) ? bindings : []) {
    const league = qidFromUrl(value(row, 'league'));
    if (league !== NFL_QID) continue;
    const label = value(row, 'seasonLabel') || '';
    const year = Number(/^\s*(\d{4})/.exec(label)?.[1]);
    const qid = qidFromUrl(value(row, 'season'));
    if (!Number.isInteger(year) || !qid) continue;
    if (!byYear.has(year)) {
      byYear.set(year, {
        year,
        qid,
        label,
        date: isoDate(value(row, 'date')),
        starts_on: isoDate(value(row, 'start')),
        ends_on: isoDate(value(row, 'end')),
      });
    }
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

export function normalizeChampionships(bindings = []) {
  const rows = [];
  for (const row of Array.isArray(bindings) ? bindings : []) {
    const qid = qidFromUrl(value(row, 'game'));
    const name = value(row, 'gameLabel');
    const decidedOn = isoDate(value(row, 'date'));
    if (!qid || !name || !decidedOn) continue;
    const calendarYear = Number(decidedOn.slice(0, 4));
    if (!Number.isInteger(calendarYear)) continue;
    rows.push({
      qid,
      name,
      decided_on: decidedOn,
      season_year: calendarYear - 1,
      winner_qid: qidFromUrl(value(row, 'winner')),
      winner: value(row, 'winnerLabel'),
      venue_qid: qidFromUrl(value(row, 'venue')),
      venue: value(row, 'venueLabel'),
    });
  }
  rows.sort((a, b) => a.season_year - b.season_year || a.decided_on.localeCompare(b.decided_on));
  return rows;
}

let SNAPSHOT = null;

export function validateSnapshot(value) {
  if (!value || typeof value !== 'object') throw new Error('season_snapshot_invalid');
  if (value.contract !== CONTRACT) throw new Error('season_snapshot_contract');
  if (value.version !== SNAPSHOT_VERSION) throw new Error('season_snapshot_version');
  if (value.source?.source_id !== SOURCE_ID || value.source?.licence !== 'CC0-1.0') {
    throw new Error('season_snapshot_source');
  }
  if (!Array.isArray(value.seasons) || value.seasons.length < 100) throw new Error('season_snapshot_incomplete');
  const years = value.seasons.map(s => Number(s?.year));
  if (new Set(years).size !== years.length) throw new Error('season_snapshot_duplicate_year');
  if (Math.min(...years) > 1920 || Math.max(...years) < 2026) throw new Error('season_snapshot_span');
  for (const season of value.seasons) {
    if (!Number.isInteger(Number(season?.year)) || !/^Q\d+$/.test(String(season?.qid || '')) || !season?.label) {
      throw new Error('season_snapshot_row');
    }
    const c = season.championship;
    if (c && (!/^Q\d+$/.test(String(c.qid || '')) || !c.name || !c.decided_on)) {
      throw new Error('season_snapshot_championship');
    }
  }
  if (Number(value.season_count) !== value.seasons.length) throw new Error('season_snapshot_count');
  return value;
}

export function readSnapshot() {
  if (SNAPSHOT) return SNAPSHOT;
  const raw = readFileSync(join(process.cwd(), 'data', 'dist', 'nfl-season-history.v1.json'), 'utf8');
  SNAPSHOT = validateSnapshot(JSON.parse(raw));
  return SNAPSHOT;
}

function send(res, status, body, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cache);
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

export default function handler(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.setHeader('allow', 'GET');
    return send(res, 405, { ok: false, contract: CONTRACT, error: 'method_not_allowed' });
  }

  try {
    const snapshot = readSnapshot();
    return send(res, 200, { ok: true, ...snapshot, semantics: 'RELEASE_SNAPSHOT' },
      'public, s-maxage=86400, stale-while-revalidate=604800');
  } catch (error) {
    console.error('[season-history] snapshot unavailable', { error: String(error?.message || error) });
    return send(res, 503, { ok: false, contract: CONTRACT, error: 'season_history_unavailable' });
  }
}
