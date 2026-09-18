/* GET /api/nfl-college-path?espn_id=3139477
 *
 * The College Path layer of Player DNA: which institution and programme a
 * player is associated with, in which conference, over which years, under which
 * head coach, and how they entered professional football.
 *
 *   data/dist/college-path.json   built by history/pipeline/build_college_product.mjs
 *                                 from the CC0 Wikidata + EADA college spine,
 *                                 read as the PUBLIC surface of the history
 *                                 graph and composed through
 *                                 history/api/college-pipeline.mjs
 *
 * ONE READ. The artifact is a stable historical fact table, so a profile view is
 * a single object lookup against a process-cached file — no graph queries, no
 * fan-out, and nothing for the browser to join. It is public and immutable
 * between releases, so it is cached hard at the edge.
 *
 * WHAT IT DOES NOT CARRY, and will not carry by accident: college statistics of
 * any kind, recruiting stars, talent composite, SP+, FPI, scouting or draft
 * grades, or any CollegeFootballData field. CFBD ingestion is disabled and no
 * CFBD data exists. college-core.js asserts the absence on every response.
 *
 * Identity is the ESPN athlete id, the same id the Career Ledger uses. An id we
 * have not resolved returns state UNRESOLVED — never "no college", because the
 * layer is built from a survivorship-biased source and absence is not evidence.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeCollegePath, CONTRACT } from './_collegepath/college-core.js';

let ARTIFACT = null;
function artifact() {
  if (ARTIFACT) return ARTIFACT;
  ARTIFACT = JSON.parse(readFileSync(join(process.cwd(), 'data', 'dist', 'college-path.json'), 'utf8'));
  return ARTIFACT;
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

export default function handler(req, res) {
  const espnId = String(req.query?.espn_id || '').trim();
  if (!/^\d{1,12}$/.test(espnId)) {
    return send(res, 400, { ok: false, contract: CONTRACT, error: 'espn_id_required' });
  }

  let data;
  try {
    data = artifact();
  } catch {
    /* The layer is additive. If the artifact is missing the profile still
       renders; it simply has no College Path, and says so in those words. */
    return send(res, 503, { ok: false, contract: CONTRACT, error: 'college_path_unavailable' });
  }

  const ambiguous = (data.meta?.ambiguous || []).some(a => String(a.espn_id) === espnId);
  const body = composeCollegePath({
    espnId,
    record: data.players?.[espnId] || null,
    ambiguous,
    meta: data.meta || {},
  });

  /* Historical facts that change only when a release rebuilds the artifact. */
  return send(res, 200, body, 'public, s-maxage=86400, stale-while-revalidate=604800');
}
