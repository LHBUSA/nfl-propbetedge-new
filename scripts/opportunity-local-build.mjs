/* Run nfl-replay's real ingest + opportunity rollup against local copies of the
 * nflverse files, with an in-memory R2. No network, no Cloudflare.
 *
 *   node scripts/opportunity-local-build.mjs <pbp.csv.gz> <players.csv> [outDir]
 *
 * Writes <outDir>/rollup.json (default .gate/opportunity) so the reconciliation
 * script and the browser QA harness can read exactly what the Worker would serve.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { streamIngest, rebuildOpportunity, rollupKey, opportunity } from '../workers/nfl-replay/src/pipeline.js';

const [pbpPath, playersPath, outDir = '.gate/opportunity'] = process.argv.slice(2);
if (!pbpPath || !playersPath) { console.error('usage: opportunity-local-build.mjs <pbp.csv.gz> <players.csv> [outDir]'); process.exit(2); }
const season = Number((pbpPath.match(/(20\d\d)/) || [])[1]) || 2026;

const map = new Map();
const R2 = {
  async put(k, v) { map.set(k, typeof v === 'string' ? v : String(v)); return { key: k }; },
  async get(k) { if (!map.has(k)) return null; const v = map.get(k); return { json: async () => JSON.parse(v), text: async () => v }; }
};
const file = p => async () => new Response(new Blob([readFileSync(p)]).stream(), { headers: { 'last-modified': statSync(p).mtime.toUTCString() } });
const pbpFetch = file(pbpPath);
const playersFetch = file(playersPath);

const asset = { url: 'local', last_modified: statSync(pbpPath).mtime.toUTCString(), etag: `local-${statSync(pbpPath).size}`, size: statSync(pbpPath).size };
const env = { REPLAY_R2: R2 };
const t0 = Date.now();
const ingest = await streamIngest(env, season, asset, pbpFetch);
const t1 = Date.now();
const built = await rebuildOpportunity(env, season, playersFetch);
const t2 = Date.now();
const rollup = map.get(rollupKey(season));
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/rollup.json`, rollup);
const radar = await (await opportunity(env, new URL(`https://x/api/replay/opportunity?season=${season}`))).text();
writeFileSync(`${outDir}/radar.json`, radar);
console.log(JSON.stringify({ ingest, built, ms: { ingest: t1 - t0, rollup: t2 - t1 }, bytes: { rollup: rollup.length, radar_view: radar.length } }, null, 1));
