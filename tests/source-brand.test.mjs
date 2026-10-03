// Network source-brand standard (DATA · PropSports): customer surfaces and public serializers carry no upstream branding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../scripts/guard-source-brand.mjs';

test('source-brand guard: no upstream provider branding in the NFL frontend or api/ serializers', () => {
  assert.deepEqual(scan(), []);
});
