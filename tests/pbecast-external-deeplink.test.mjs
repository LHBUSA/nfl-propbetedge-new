import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../pbecast-v6.js', import.meta.url), 'utf8');

test('PBEcast accepts a cross-product event deep link as an explicit game selection', () => {
  assert.match(source, /App\?\.params\?\.event/);
  assert.match(source, /new URLSearchParams\(location\.search\)\.get\('event'\)/);
  assert.match(source, /source:'url-deep-link'/);
  assert.match(source, /state\.explicit=true/);
});

test('the event deep link is one-shot and removed after consumption', () => {
  assert.match(source, /searchParams\.delete\('event'\)/);
  assert.match(source, /history\.replaceState/);
});
