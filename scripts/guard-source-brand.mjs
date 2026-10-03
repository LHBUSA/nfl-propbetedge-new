// Source-brand guard v2 (PropBetEdge network standard; reference implementation LHBUSA/golf 43c4677, 2026-10-03).
// Customer-facing data attribution is "DATA · PropSports" (https://propsports.proptechusa.ai). Upstream providers
// stay in ingest provenance, captures, logs, admin/debug, source registries and tests.
// v2 scans every customer-rendered directory INCLUDING lib/ and data/ and the public API serializers, and flags an
// upstream provider name inside any string literal (URLs are ignored: a fetch target is not customer copy).
// A line that IS a licence credit, image credit, named publisher / sportsbook / broadcaster, or a provenance
// surface carries an inline marker:  source-brand:allow (<why>)   Files that are wholly provenance surfaces go in ALLOW.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
// ---- per-repo configuration -------------------------------------------------------------------------------------
const SCOPE = ['.'];                  // NFL frontend lives at the repo root; api/ = Vercel public serializers                // customer-rendered code + public API serializers (files or dirs)
const ALLOW = new Set([
  'game-script-lab-v1.js',  /* nflverse play-by-play CC BY 4.0 licence credit */
]);            // whole files that are provenance / licence surfaces (repo-relative)
// ------------------------------------------------------------------------------------------------------------------
const SKIP = new Set(['node_modules', 'dist', 'build', '.next', '.vercel', 'coverage', 'tests', 'test', '__tests__', 'fixtures', 'research', 'docs',
  'workers', 'scripts', 'data', 'history', 'supabase', 'migrations', 'archive', 'release', 'qa-artifacts', 'vendor', 'design', 'reports']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.vue', '.svelte']);
const PROVIDERS = String.raw`(?:ESPN|The Odds API|the-odds-api(?:\.com)?|Odds API|MLB Stats ?API|StatsAPI|Baseball Savant|UFC ?Stats|NBA\.com|stats\.nba\.com|Basketball[- ]Reference|Baseball[- ]Reference|Pro Football Reference|NFL\.com|NHL\.com|NHL Edge|api-web\.nhle\.com|WNBA\.com|FanGraphs|Sportradar|SportsDataIO|OpenLigaDB|Jolpica|Ergast|OpenF1|BoxRec|Sherdog|Tapology|Wikidata)`;
const FORBIDDEN = [
  new RegExp(String.raw`\b(?:per|via|from|by|through) ${PROVIDERS}`, 'gi'),
  new RegExp(String.raw`\b(?:Data|Source|Sources|Sourced from|Powered by|Data provided by|Data from|Upstream)\s*[:·]?\s*${PROVIDERS}`, 'gi'),
  // any upstream provider name inside a string literal on a customer surface
  new RegExp(String.raw`(['"\`])[^'"\`\n]*?(?<![\w.$/-])${PROVIDERS}(?![\w$])[^'"\`\n]*?\1`, 'gi'),
  /\bESPN(?:’|')s (?:injury|transactions|season|own|primary|public)\b/gi,
  // operational setup must never reach customers
  /wrangler secret put|npx wrangler|C:\\\\Workers/gi,
];
// Publisher / sportsbook / broadcaster names that merely contain a provider word.
const BENIGN = /\bESPN ?BET\b|\bESPN\+|\bESPN2\b|\bESPNU\b|\bESPN Deportes\b|\bWatchESPN\b/gi;

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([;,{}()\]])\s*\/\/(?![^'"`\n]*['"`]).*$/gm, '$1');
}
function files(rel, out = []) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return out;
  if (fs.statSync(full).isFile()) { out.push(rel.replaceAll('\\', '/')); return out; }
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const r = rel + '/' + e.name;
    if (e.isDirectory()) files(r, out);
    else if (EXTENSIONS.has(path.extname(e.name).toLowerCase()) && !/\.(test|spec)\.[a-z]+$/.test(e.name)) out.push(r.replaceAll('\\', '/'));
  }
  return out;
}
export function scan(root = ROOT) {
  const violations = [];
  for (const rel of SCOPE.flatMap((s) => files(s))) {
    if (ALLOW.has(rel)) continue;
    const raw = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    const lines = stripComments(raw.join('\n')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (raw[i].includes('source-brand:allow')) continue;
      const line = lines[i].replace(/(?:https?:)?\/\/[^\s'"`)]+/g, '').replace(BENIGN, '');
      for (const pattern of FORBIDDEN) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) { violations.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 180)}`); break; }
      }
    }
  }
  return [...new Set(violations)];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = scan();
  if (violations.length) {
    console.error('\nUpstream provider branding detected in customer-facing source or public API serializers.');
    console.error('Customer-facing attribution is "DATA · PropSports" (https://propsports.proptechusa.ai).');
    console.error('Licence credits, image credits and named publishers stay: mark those lines `source-brand:allow (<why>)`.\n');
    for (const v of violations) console.error(` - ${v}`);
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
  }
  console.log(`PASS source-brand guard v2: ${SCOPE.join(', ')} clean (${ALLOW.size} provenance file(s) allowed).`);
}
