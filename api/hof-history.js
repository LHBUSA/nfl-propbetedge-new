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
 *   - position/team affiliations when Wikidata carries them
 *
 * We do NOT synthesize an induction year, class, career note or ranking.
 */
export const CONTRACT = 'pbe-nfl-hof-v1';
export const SOURCE_ID = 'src_wikidata';
export const SOURCE_PROPERTY = 'P6930';

export const HOF_QUERY = `
SELECT ?person ?personLabel ?hofId
       (GROUP_CONCAT(DISTINCT ?positionLabel; separator="|") AS ?positions)
       (GROUP_CONCAT(DISTINCT ?teamLabel; separator="|") AS ?teams)
WHERE {
  ?person wdt:P6930 ?hofId .
  ?person rdfs:label ?personLabel .
  FILTER(LANG(?personLabel) = "en")
  OPTIONAL {
    ?person wdt:P413 ?position .
    ?position rdfs:label ?positionLabel .
    FILTER(LANG(?positionLabel) = "en")
  }
  OPTIONAL {
    ?person wdt:P54 ?team .
    ?team rdfs:label ?teamLabel .
    FILTER(LANG(?teamLabel) = "en")
  }
}
GROUP BY ?person ?personLabel ?hofId
ORDER BY ?personLabel
`.trim();

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'PropBetEdgeNFLHistory/1.0 (https://nfl.propbetedge.ai; sales@proptechusa.ai)';
const MAX_UPSTREAM_MS = 12000;

function bindingValue(binding, key) {
  const value = binding?.[key]?.value;
  return value == null ? null : String(value);
}

function list(value) {
  return [...new Set(String(value || '').split('|').map(v => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
    current.positions = [...new Set([...current.positions, ...list(bindingValue(binding, 'positions'))])].sort((a, b) => a.localeCompare(b));
    current.teams = [...new Set([...current.teams, ...list(bindingValue(binding, 'teams'))])].sort((a, b) => a.localeCompare(b));
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
        note: 'Membership is represented by the Wikidata Pro Football Hall of Fame identifier (P6930). Position and team affiliations appear only when present in the source.',
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
