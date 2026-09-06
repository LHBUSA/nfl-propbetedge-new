/* Prop Board v5 — static contracts that keep the cleanup from regressing.
 *
 * The behavioural acceptance run lives in scripts/propboard-gate.mjs
 * (headless Chrome). These tests pin the architecture without a browser:
 *   · one presentation authority is loaded (v5), the retired layers are not
 *   · v3 stays the data authority and exposes the single load() path
 *   · v5 has no page-wide observer and no odds polling loop
 *   · the visual system stays on pbe-tokens.css (no fresh colour system,
 *     no sub-10px type)
 *   · the desktop scan is seven columns, and the eleven-column table is gone
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const loader = read('page-loader.js');
const index = read('index.html');
const v3 = read('prop-board-v3.js');
const v5 = read('prop-board-v5.js');
const css = read('prop-board-v5.css');

test('page-loader loads Prop Board v5 and no superseded Prop Board layer', () => {
  assert.match(loader, /\{css:'\.\/prop-board-v5\.css',js:'\.\/prop-board-v5\.js'\}/);
  assert.doesNotMatch(loader, /prop-board-v4\.(js|css)'/);
  assert.doesNotMatch(loader, /prop-board-responsive-v5\.css/);
  assert.doesNotMatch(index, /prop-board-v4|prop-board-responsive-v5|prop-board-v5/);
});

test('v3 remains the data authority and exposes the single load() path + truth helpers', () => {
  assert.match(v3, /async function load\(\)/);
  assert.match(v3, /render,load,changeEvent,openDrawer,closeDrawer,state/);
  assert.match(v3, /helpers:\{ modelGap,modelFair,modelProb,pointOf,priceOf,bookOf,sideOf,updatedOf,playerOf,bestQuote,median,isPro \}/);
  assert.match(v3, /const BATCH_SIZE = 5;/, 'provider-safe batching contract untouched');
  assert.match(v3, /\/api\/odds\/board/);
  assert.match(v3, /\/api\/picks\/pass/);
  assert.doesNotMatch(v3, /Math\.random/);
});

test('v5 registers the route, reads state from v3, and does not fetch market data itself', () => {
  assert.match(v5, /window\.App\.VIEWS\.propboard = render/);
  assert.match(v5, /await Promise\.all\(\[v3\(\)\.load\(\), loadRoster\(\)\]\)/);
  assert.doesNotMatch(v5, /api\/odds/, 'no direct odds requests in the presentation layer');
  assert.doesNotMatch(v5, /api\/picks/, 'no direct model requests in the presentation layer');
});

test('v5 has no page-wide MutationObserver and no odds polling loop', () => {
  assert.doesNotMatch(v5, /MutationObserver/);
  assert.doesNotMatch(v5, /setInterval/);
  const timeouts = v5.match(/setTimeout\(/g) || [];
  assert.ok(timeouts.length <= 2, `only the resize debounce uses setTimeout (found ${timeouts.length})`);
});

test('v5 keeps truth semantics: no LIVE label, snapshot distribution labelled, nothing fabricated', () => {
  assert.doesNotMatch(v5, /['"]LIVE['"]/, 'v5 never labels the board LIVE');
  assert.match(v5, /CURRENT SNAPSHOT · NOT HISTORICAL MOVEMENT/);
  assert.match(v5, /No production model output for this prop/);
  assert.doesNotMatch(v5, /Math\.random/);
});

test('desktop scan is seven columns; the eleven-column table is gone', () => {
  const head = v5.match(/class="pbe5-table"><thead><tr>(.*?)<\/tr><\/thead>/s)?.[1] || '';
  assert.equal((head.match(/<th/g) || []).length, 7, head);
  assert.match(head, /Player \/ prop.*Consensus.*Best over.*Best under.*PBE fair.*Edge.*Status/s);
  assert.doesNotMatch(v5, /Book Range|Depth<\/th>|PBE Over<\/th>/);
});

test('non-PRO board carries a single unlock message and one gated column state', () => {
  assert.equal((v5.match(/Unlock NFL Pro/g) || []).length, 2, 'signal strip + row detail only');
  assert.match(v5, /Unlock PBE model<\/b><span>Fair line · probability · model gap/);
  assert.match(v5, /class="pbe5-gated"/);
});

test('pins and settings keep the existing localStorage keys so nothing a user pinned is lost', () => {
  assert.match(v5, /const SETTINGS_KEY = 'pbe_propboard_v4_settings'/);
  assert.match(v5, /const PIN_PREFIX = 'pbe_propboard_v4_pins_'/);
});

test('the board follows the shared event selection and opens Player Research from a name', () => {
  assert.match(v5, /addEventListener\('pbe:event-changed'/);
  assert.match(v5, /PBEPlayerResearch\?\.show\?\.\(name\.dataset\.pbe5Player\)/);
  assert.match(v5, /PBEEventSelector\?\.open/);
});

test('stylesheet stays on the design tokens with no sub-10px type', () => {
  assert.match(css, /var\(--pbe-gold\)/);
  assert.match(css, /var\(--pbe-font-data\)/);
  assert.match(css, /var\(--pbe-font-ui\)/);
  assert.doesNotMatch(css, /:root\s*\{/, 'no competing token root');
  const sizes = [...css.matchAll(/font:[^;}]*?(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 20);
  assert.ok(sizes.every((s) => s >= 10), `smallest font ${Math.min(...sizes)}px`);
  assert.doesNotMatch(css, /backdrop-filter/, 'no glass');
  assert.match(css, /@media \(max-width:760px\)/, 'phone cards breakpoint');
});

test('CI and smoke references point at the v5 layer', () => {
  const wf = read('.github/workflows/nfl-os-regression-v4.yml');
  assert.match(wf, /prop-board-v5\.js/);
  assert.doesNotMatch(wf, /prop-board-v4|prop-board-responsive-v5/);
  assert.match(read('scripts/recovery-browser-smoke.mjs'), /'prop-board-v5\.css'/);
  assert.match(read('.github/workflows/ci.yml'), /prop-board-v5\.js/);
});
