import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../event-selector-v2.js', import.meta.url), 'utf8');

test('global NFL event selector formats every displayed kickoff in Eastern Time', () => {
  assert.match(src, /timeZone:'America\/New_York'/);
  assert.match(src, /function fmtDate\(value\).*\.\.\.ET/s);
  assert.match(src, /function dayKey\(value\).*\.\.\.ET/s);
  assert.match(src, /function timeOnly\(value\).*\.\.\.ET/s);
  assert.match(src, /Eastern Time \(ET\)/);
});
