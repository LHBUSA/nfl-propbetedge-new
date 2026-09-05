/* Local invoker: runs a Vercel-style handler without a server.
 * node research/qbdna/call.mjs <route> "k=v&k=v"
 *   routes: qb-dna | prop-history | compare | prop-lab | game-context
 *           wr-dna | wr-prop-lab | wr-compare
 *           rb-dna | rb-prop-lab | rb-compare
 *           te-dna | te-prop-lab | te-compare
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ROUTES = {
  'qb-dna': 'api/qb-dna.js',
  'prop-history': 'api/qb-dna/prop-history.js',
  'compare': 'api/qb-dna/compare.js',
  'prop-lab': 'api/qb-dna/prop-lab.js',
  'game-context': 'api/qb-dna/game-context.js',
  'wr-dna': 'api/wr-dna.js',
  'wr-prop-lab': 'api/wr-dna/prop-lab.js',
  'wr-compare': 'api/wr-dna/compare.js',
  'rb-dna': 'api/rb-dna.js',
  'rb-prop-lab': 'api/rb-dna/prop-lab.js',
  'rb-compare': 'api/rb-dna/compare.js',
  'te-dna': 'api/te-dna.js',
  'te-prop-lab': 'api/te-dna/prop-lab.js',
  'te-compare': 'api/te-dna/compare.js'
};

export async function call(route, qs = '') {
  const mod = await import(pathToFileURL(resolve(process.cwd(), ROUTES[route])).href);
  const query = Object.fromEntries(new URLSearchParams(qs));
  let status = 0, body = null, headers = {};
  const res = {
    statusCode: 200,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    end: s => { status = res.statusCode; body = JSON.parse(s); }
  };
  await mod.default({ query, method: 'GET' }, res);
  return { status, headers, body };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , route, qs] = process.argv;
  const r = await call(route, qs || '');
  console.log(JSON.stringify(r.body, null, 2));
  if (r.status !== 200) process.exitCode = 1;
}
