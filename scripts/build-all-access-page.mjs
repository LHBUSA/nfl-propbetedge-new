#!/usr/bin/env node
/* Regenerates the network block of all-access.html from network-family.json
 * (the vendored canonical family registry) so the NFL All Access page never
 * carries a hand-maintained sport list.
 *
 *   node scripts/build-all-access-page.mjs          rewrite the marked block
 *   node scripts/build-all-access-page.mjs --check  exit 1 if it is stale
 *
 * tests/nfl-all-access-page.test.mjs runs the same comparison. */
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const family = JSON.parse(readFileSync(new URL('network-family.json', root), 'utf8'));
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const displayName = (e) => (e.name === `PropBetEdge ${e.label}` ? e.label : e.name);

/* One-line, sport-agnostic descriptions are deliberately absent: the tile names
   the product and links to it; what each desk contains is that desk's job. */
export function networkBlock() {
  const sports = family.sports.map((s) => {
    const here = s.key === 'nfl';
    return `        <li><a class="nflaa-net-tile${here ? ' is-here' : ''}" href="${here ? '/' : esc(s.url)}" data-net-key="${esc(s.key)}"${here ? ' aria-current="page"' : ''}>
          <b>${esc(displayName(s))}</b><span>${esc(s.name)}</span><em data-net-status>${here ? 'YOU ARE HERE' : 'INCLUDED'}</em>
        </a></li>`;
  }).join('\n');
  const products = family.products.map((p) => `        <li><a class="nflaa-net-tile is-product" href="${esc(p.url)}" data-net-key="${esc(p.key)}">
          <b>${esc(p.name)}</b><span>Intelligence product · not a sport</span><em data-net-status>INCLUDED</em>
        </a></li>`).join('\n');
  return `<!-- network:begin (generated from network-family.json by scripts/build-all-access-page.mjs) -->
      <div class="nflaa-net-group">
        <span class="nflaa-k">SPORTS · ${family.sports.length}</span>
        <ul class="nflaa-net-grid" data-net="sports">
${sports}
        </ul>
      </div>
      <div class="nflaa-net-group is-intel">
        <span class="nflaa-k">INTELLIGENCE</span>
        <ul class="nflaa-net-grid is-products" data-net="products">
${products}
        </ul>
      </div>
      <!-- network:end -->`;
}

export function currentBlock(html) {
  const a = html.indexOf('<!-- network:begin');
  const b = html.indexOf('<!-- network:end -->');
  if (a < 0 || b < 0) return null;
  return html.slice(a, b + '<!-- network:end -->'.length).replace(/\r\n/g, '\n');
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('build-all-access-page.mjs')) {
  const file = new URL('all-access.html', root);
  const html = readFileSync(file, 'utf8');
  const now = currentBlock(html);
  if (!now) { console.error('all-access.html has no network:begin/end markers'); process.exit(1); }
  const next = networkBlock();
  if (process.argv.includes('--check')) {
    if (now !== next) { console.error('all-access.html network block is stale; run node scripts/build-all-access-page.mjs'); process.exit(1); }
    console.log('all-access.html network block matches network-family.json');
  } else {
    writeFileSync(file, html.replace(now, next));
    console.log('all-access.html network block regenerated');
  }
}
