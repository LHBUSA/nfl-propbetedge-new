/* GET /api/hof-history
 *
 * Rights-clean Pro Football Hall of Fame member index.
 *
 * The request path never calls a third-party source. It serves a versioned
 * release snapshot built by scripts/build-hof-snapshot.mjs from Wikidata
 * structured data (CC0-1.0), using P6930, the Pro Football Hall of Fame ID
 * approved for public display in history/registry/sources.v2.json.
 *
 * The legacy archive/hof.js dataset is deliberately not read here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONTRACT = 'pbe-nfl-hof-v1';
export const SNAPSHOT_VERSION = '1.0.0';
export const SOURCE_ID = 'src_wikidata';
export const SOURCE_PROPERTY = 'P6930';
export const SOURCE_ENDPOINT = 'https://query.wikidata.org/sparql';

export const HOF_QUERY = `
SELECT ?person ?personLabel ?hofId
WHERE {
  ?person wdt:P6930 ?hofId .
  ?person rdfs:label ?personLabel .
  FILTER(LANG(?personLabel) = "en")
}
ORDER BY ?personLabel
`.trim();

function bindingValue(binding, key) {
  const value = binding?.[key]?.value;
  return value == null ? null : String(value);
}

function mergeLabels(...groups) {
  const labels = new Map();
  for (const value of groups.flat()) {
    const clean = String(value || '').trim();
    if (!clean) continue;
    const key = clean.toLocaleLowerCase('en-US');
    const existing = labels.get(key);
    if (!existing || (/^[a-z]/.test(existing) && /^[A-Z]/.test(clean))) labels.set(key, clean);
  }
  return [...labels.values()].sort((a, b) => a.localeCompare(b));
}

function list(value) {
  return mergeLabels(String(value || '').split('|'));
}

export function normalizeBindings(bindings = []) {
  const byId = new Map();
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const personUrl = bindingValue(binding, 'person') || '';
    const qid = /^https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/.exec(personUrl)?.[1] || null;
    const hofId = bindingValue(binding, 'hofId');
    const name = bindingValue(binding, 'personLabel');
    if (!qid || !hofId || !name) continue;
    const key = `${qid}:${hofId}`;
    const current = byId.get(key) || { qid, name, hof_id: hofId, positions: [], teams: [] };
    current.positions = mergeLabels(current.positions, list(bindingValue(binding, 'positions')));
    current.teams = mergeLabels(current.teams, list(bindingValue(binding, 'teams')));
    byId.set(key, current);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

let SNAPSHOT = null;

export function validateSnapshot(value) {
  if (!value || typeof value !== 'object') throw new Error('hof_snapshot_invalid');
  if (value.contract !== CONTRACT) throw new Error('hof_snapshot_contract');
  if (value.version !== SNAPSHOT_VERSION) throw new Error('hof_snapshot_version');
  if (value.source?.source_id !== SOURCE_ID || value.source?.property !== SOURCE_PROPERTY) {
    throw new Error('hof_snapshot_source');
  }
  if (!Array.isArray(value.members) || value.members.length < 100) throw new Error('hof_snapshot_incomplete');
  if (value.members.length !== Number(value.count)) throw new Error('hof_snapshot_count');
  for (const member of value.members) {
    if (!/^Q\d+$/.test(String(member?.qid || '')) || !member?.name || !member?.hof_id) {
      throw new Error('hof_snapshot_member');
    }
  }
  return value;
}

export function readSnapshot() {
  if (SNAPSHOT) return SNAPSHOT;
  const raw = readFileSync(join(process.cwd(), 'data', 'dist', 'hof-members.v1.json'), 'utf8');
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
    return send(res, 200, {
      ok: true,
      ...snapshot,
      semantics: 'RELEASE_SNAPSHOT',
    }, 'public, s-maxage=86400, stale-while-revalidate=604800');
  } catch (error) {
    console.error('[hof-history] snapshot unavailable', {
      error: String(error?.message || error),
    });
    return send(res, 503, {
      ok: false,
      contract: CONTRACT,
      error: 'hof_source_unavailable',
    });
  }
}
