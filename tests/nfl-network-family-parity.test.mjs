// Footer family parity: the NFL network footer must agree with the vendored PropBetEdge
// family registry (network-family.json, generated in propbetedge-workers
// shared/network/family.json). Re-vendor that file, then update the footer, when the family changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const family = JSON.parse(fs.readFileSync(new URL('../network-family.json', import.meta.url), 'utf8'));
const src = fs.readFileSync(new URL('../network-footer-v1.js', import.meta.url), 'utf8');
const block = (name) => {
  const start = src.indexOf(`const ${name} = [`);
  assert.ok(start > -1, `${name} registry exists`);
  return src.slice(start, src.indexOf('];', start));
};
const footerHtml = src.slice(src.indexOf('<footer id='), src.indexOf('</footer>'));

test('sports registry: same set, order and canonical urls as the family (self = in-app route)', () => {
  const rows = [...block('SPORTS').matchAll(/\{ key: '([a-z0-9]+)'[^\n]*?(?:href: '([^']+)'|route: '([^']+)')/g)];
  assert.deepEqual(rows.map((r) => r[1]), family.sports.map((s) => s.key));
  for (const [, key, href] of rows) {
    const want = family.sports.find((s) => s.key === key).url;
    if (key === 'nfl') assert.equal(href, undefined, 'NFL self tile stays an in-app route');
    else assert.equal(href, want, `${key} href`);
  }
});

test('Predictions is a separate intelligence product: never in SPORTS, linked exactly once', () => {
  const pred = family.products.find((p) => p.key === 'predictions');
  assert.equal(pred.url, 'https://predictions.propbetedge.ai/');
  assert.ok(!block('SPORTS').includes('predictions'), 'not a sport');
  assert.match(block('PRODUCTS'), new RegExp(`key: 'predictions', label: 'PropBetEdge Predictions', href: '${pred.url.replace(/[./]/g, '\$&')}'`));
  assert.equal((src.match(/predictions\.propbetedge\.ai/g) || []).length, 1);
  assert.equal((src.match(/f1\.propbetedge\.ai/g) || []).length, 1);
  assert.match(footerHtml, /aria-label="PropBetEdge intelligence"[\s\S]*PRODUCTS\.map/);
});

test('network links (hub, All Access, Learn) use the family urls; no retired hosts, no http', () => {
  const eco = footerHtml.slice(footerHtml.indexOf('aria-label="PropBetEdge ecosystem"'));
  const nav = eco.slice(0, eco.indexOf('</nav>'));
  /* Owner decision 2026-10-05: All Access navigation stays on NFL (/all-access);
     the registry's all_access url remains the network reference, not footer navigation. */
  assert.equal(src.match(/const ALL_ACCESS = '([^']+)'/)[1], '/all-access');
  assert.equal(family.network.find((n) => n.key === 'all_access').url, 'https://propbetedge.ai/pro');
  assert.ok(nav.includes('href="${ALL_ACCESS}"'));
  for (const key of ['hub', 'learn']) assert.ok(nav.includes(`href="${family.network.find((n) => n.key === key).url}"`), key);
  for (const host of family.retired_hosts) assert.ok(!src.includes(host), host);
  assert.ok(!/http:\/\/[^'"\s]*propbetedge\.ai/.test(src));
  assert.ok(!/\b(11|eleven) sports\b/i.test(src));
});
