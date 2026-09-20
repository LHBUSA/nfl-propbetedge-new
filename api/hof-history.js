/* GET /api/hof-history
 *
 * Rights-clean Pro Football Hall of Fame member index.
 *
 * Source: Wikidata structured data (CC0-1.0), using P6930, the
 * Pro Football Hall of Fame identifier already approved for public display in
 * history/registry/sources.v2.json. This endpoint deliberately does NOT read
 * archive/hof.js: that retained file is unprovenanced and contains claims that
 * failed verification.
 *
 * We publish only what the source actually gives us:
 *   - person identity + QID
 *   - PFHOF identifier (the membership signal)
 *
 * Version 1 intentionally keeps the live query to identity + membership only.
 * Optional position/team joins made the public SPARQL request exceed the
 * production latency budget. We do NOT synthesize an induction year, class,
 * position, team, career note or ranking.
 */
export const CONTRACT = 'pbe-nfl-hof-v1';
export const SOURCE_ID = 'src_wikidata';
export const SOURCE_PROPERTY = 'P6930';

export const HOF_QUERY = `
SELECT ?person ?personLabel ?hofId
WHERE {
  ?person wdt:P6930 ?hofId .
  ?person rdfs:label ?personLabel .
  FILTER(LANG(?personLabel) = "en")
}
ORDER BY ?personLabel


const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'PropBetEdgeNFLHistory/1.0 (https://nfl.propbetedge.ai; sales@proptechusa.ai)';
const MAX_UPSTREAM_MS = 12000;

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

function send(res, status, body, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cache);
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

async function readWikidata() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_UPSTREAM_MS);
  try {
    const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(HOF_QUERY)}`;
    const response = await fetch(url, {
      headers: {
        accept: 'application/sparql-results+json',
        'user-agent': UA,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`wikidata_http_${response.status}`);
    const json = await response.json();
    const bindings = json?.results?.bindings;
    if (!Array.isArray(bindings)) throw new Error('wikidata_shape');
    return normalizeBindings(bindings);
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.setHeader('allow', 'GET');
    return send(res, 405, { ok: false, contract: CONTRACT, error: 'method_not_allowed' });
  }

  try {
    const members = await readWikidata();
    if (members.length < 100) throw new Error('wikidata_hof_incomplete');

    const retrievedAt = new Date().toISOString();
    return send(res, 200, {
      ok: true,
      contract: CONTRACT,
      semantics: 'SOURCE_SNAPSHOT',
      count: members.length,
      members,
      source: {
        source_id: SOURCE_ID,
        name: 'Wikidata',
        licence: 'CC0-1.0',
        property: SOURCE_PROPERTY,
        endpoint: ENDPOINT,
        retrieved_at: retrievedAt,
        note: 'Membership is represented by the Wikidata Pro Football Hall of Fame identifier (P6930). Version 1 publishes identity and membership only; no induction class or career context is inferred.',
      },
    }, 'public, s-maxage=86400, stale-while-revalidate=604800');
  } catch (error) {
    console.error('[hof-history] source unavailable', {
      error: String(error?.message || error),
    });
    return send(res, 503, {
      ok: false,
      contract: CONTRACT,
      error: 'hof_source_unavailable',
    });
  }
}
