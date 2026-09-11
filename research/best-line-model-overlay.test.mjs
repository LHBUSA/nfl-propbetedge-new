import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../best-line-model-overlay-v1.js', import.meta.url), 'utf8');

test('overlay consumes only already-authorized PBE Card model state', () => {
  assert.match(src, /window\.PBECard\?\.cards\?\.\(\)/);
  assert.match(src, /window\.PBECard\.ensure\(true\)/);
  assert.match(src, /window\.PBEPro\?\.state/);
  assert.doesNotMatch(src, /fetch\(/);
});

test('overlay fills both Best Line model columns', () => {
  assert.match(src, /data-label=\"PBE fair\"/);
  assert.match(src, /data-label=\"Model edge\"/);
  assert.match(src, /modelHtml\(event, market, side\)/);
});

test('non-Pro and missing-signal states are explicit and fail closed', () => {
  assert.match(src, /Model layer locked/);
  assert.match(src, /No active signal/);
  assert.match(src, /Best Line will not invent one/);
  assert.match(src, /No model value is guessed/);
});

test('issue-time semantics stay distinct from current market truth', () => {
  assert.match(src, /ISSUED MODEL/);
  assert.match(src, /frozen at issue/);
  assert.match(src, /Never estimated from consensus/);
  assert.match(src, /Current market movement remains separate/);
});
