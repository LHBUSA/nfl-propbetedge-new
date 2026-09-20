/* Build data/dist/hof-members.v1.json from the approved Wikidata CC0 source.
 *
 * This is a release-time operation, never a request-time dependency.
 * Run:
 *   node scripts/build-hof-snapshot.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CONTRACT, SNAPSHOT_VERSION, SOURCE_ID, SOURCE_PROPERTY, SOURCE_ENDPOINT,
  HOF_QUERY, normalizeBindings,
} from '../api/hof-history.js';

const OUT = join(process.cwd(), 'data', 'dist', 'hof-members.v1.json');
const UA = 'PropBetEdgeNFLHistoryBuilder/1.0 (https://nfl.propbetedge.ai; sales@proptechusa.ai)';
const TIMEOUT_MS = 120000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchBindings() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const body = new URLSearchParams({ query: HOF_QUERY, format: 'json' });
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

const bindings = await fetchBindings();
const members = normalizeBindings(bindings);
if (members.length < 100) throw new Error(`hof_snapshot_incomplete_${members.length}`);

const retrievedAt = new Date().toISOString();
const contentSha256 = createHash('sha256')
  .update(JSON.stringify(members))
  .digest('hex');

const snapshot = {
  contract: CONTRACT,
  version: SNAPSHOT_VERSION,
  count: members.length,
  content_sha256: contentSha256,
  source: {
    source_id: SOURCE_ID,
    name: 'Wikidata',
    licence: 'CC0-1.0',
    property: SOURCE_PROPERTY,
    endpoint: SOURCE_ENDPOINT,
    retrieved_at: retrievedAt,
    query: HOF_QUERY,
    note: 'Membership is represented by the Wikidata Pro Football Hall of Fame identifier (P6930). Identity and membership only; no induction class or career context is inferred.',
  },
  members,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log('HOF SNAPSHOT BUILT', {
  count: members.length,
  retrieved_at: retrievedAt,
  content_sha256: contentSha256,
  output: OUT,
});
