import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function load(hostname) {
  const listeners = [];
  const appended = [];
  const ctx = {
    location: { hostname },
    document: {
      addEventListener: (type, fn) => listeners.push([type, fn]),
      querySelector: () => null,
      createElement: () => ({ setAttribute() {} }),
      head: { appendChild: (el) => appended.push(el) },
    },
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.runInNewContext(read('preferred-source-v1.js'), ctx);
  return { api: ctx.PBEPreferredSource, listeners, appended, ctx };
}

test('nfl host: parent source via deeplink, publisher.js never loaded', () => {
  const { api, listeners, appended, ctx } = load('nfl.propbetedge.ai');
  assert.deepEqual({ ...api.target() }, { source: 'propbetedge.ai', sdk: false });
  assert.equal(appended.length, 0);
  assert.equal(ctx.PREFERRED_SOURCE, undefined);
  assert.equal(listeners.filter(([t]) => t === 'click').length, 1);
  api.mount();
  assert.equal(listeners.filter(([t]) => t === 'click').length, 1, 'mount is idempotent');
});

test('markup: own control, deeplink href, analytics attributes, no Google auto-render hook', () => {
  const html = load('nfl.propbetedge.ai').api.render({ surface: 'footer' });
  assert.match(html, /href="https:\/\/www\.google\.com\/preferences\/source\?q=propbetedge\.ai"/);
  assert.match(html, /data-pbe-preferred-source/);
  assert.match(html, /data-surface="footer"/);
  assert.match(html, /data-sport="nfl"/);
  assert.doesNotMatch(html, /google-add-preferred-source-btn/);
});

test('footer renders the control and the loader loads it before the footer', () => {
  assert.match(read('network-footer-v1.js'), /PBEPreferredSource\?\.render\(\{ surface: 'footer' \}\)/);
  const loader = read('page-loader.js');
  const psrc = loader.indexOf("{css:'./preferred-source-v1.css',js:'./preferred-source-v1.js'}");
  const footer = loader.indexOf("{css:'./network-footer-v1.css',js:'./network-footer-v1.js'}");
  assert.ok(psrc > 0 && footer > psrc);
});
