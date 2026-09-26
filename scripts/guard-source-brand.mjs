// Source-brand guard (PropBetEdge network standard, 2026-09-26).
// Customer-facing data attribution is "DATA · PropSports" (https://propsports.proptechusa.ai).
// Upstream providers stay in API provenance, logs, admin/debug views and audit artifacts,
// and on the provenance / licence surfaces listed in ALLOW (source registries, trust
// pages, methodology citations, CC BY and image credits, named-publisher reporting).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  '.git', '.github', '.vercel', '.next', 'node_modules', 'dist', 'build', 'out', 'coverage',
  'docs', 'api', 'workers', 'server', 'scripts', 'tests', 'test', 'research',
  'history', 'supabase', 'migrations', 'data', 'fixtures', 'shared', 'lib', 'archive', 'release', 'qa-artifacts'
]);
// Files that ARE provenance / licence / citation surfaces: upstream names are required there.
const ALLOW = new Set([
  'game-script-lab-v1.js',  /* nflverse play-by-play CC BY 4.0 licence credit */
]);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.vue', '.svelte', '.css']);
const PROVIDERS = String.raw`(?:ESPN|MLB Stats API|Baseball Savant|UFC ?Stats|NBA\.com|NFL\.com|NHL\.com|WNBA\.com|nflverse|The Odds API)`;
const FORBIDDEN = [
  /\bMLB Stats API\b/gi,
  /\bThe Odds API\b/gi,
  /\bTHE ODDS API\b/g,
  /\bESPN API\b/gi,
  /\bNBA API\b/gi,
  /\bNHL API\b/gi,
  /\bWNBA API\b/gi,
  // generic "this product's data comes from <provider>" branding
  new RegExp(String.raw`\b(?:per|via|from|by|through) ${PROVIDERS}\b`, 'gi'),
  new RegExp(String.raw`\b(?:Data|Source|Sources|Powered by|Data provided by|Data from)\s*[:·]?\s*${PROVIDERS}\b`, 'gi'),
  /\bESPN(?:’|')s (?:injury|transactions|season|own|primary|public)\b/gi,
  /\bESPN (?:team totals|injury (?:feed|report|note)|feed|roster|game records|league standings|athlete IDs?|lists|has published|clinch|scoreboard|live|model|MODEL|LIVE|SCOREBOARD)\b/gi,
];

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))  // keep line numbers
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !ALLOW.has(rel)) out.push({ full, rel });
  }
  return out;
}

const violations = [];
for (const file of walk(ROOT)) {
  const text = stripComments(fs.readFileSync(file.full, 'utf8'));
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of FORBIDDEN) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) violations.push(`${file.rel}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
    }
  }
}

if (violations.length) {
  console.error('\nUpstream provider branding detected in consumer-facing source.');
  console.error('Customer-facing attribution is "DATA · PropSports" (https://propsports.proptechusa.ai).');
  console.error('Keep legally required attribution, licence credits and methodology citations on the ALLOW surfaces.\n');
  for (const v of [...new Set(violations)]) console.error(` - ${v}`);
  process.exit(1);
}

console.log(`PASS source-brand guard: no upstream provider branding in consumer-facing source (${ALLOW.size} provenance surfaces allowed).`);
