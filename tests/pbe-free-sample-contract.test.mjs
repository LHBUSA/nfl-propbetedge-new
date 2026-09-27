/* Free-sample publication contract: only OFFICIAL decisions may leave
 * /api/pbe-picks?view=free-sample. Tracking / validation / shadow / research /
 * rehearsal_shadow / unpublished rows can never escape, whatever their edge. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isFreeSamplePublishable, selectFreeSample } from '../api/pbe-picks.js';

const row = (publication_scope, edge_pct, id = publication_scope) => ({
  row: { id, publication_scope, edge_pct, market: 'spread' },
  lifecycle: 'ACTIVE',
});

test('only official decisions are publishable', () => {
  assert.equal(isFreeSamplePublishable({ publication_scope: 'official' }), true);
  assert.equal(isFreeSamplePublishable({ publication_scope: 'OFFICIAL' }), true);
  for (const scope of ['tracking', 'validation', 'shadow', 'research', 'rehearsal_shadow', 'unpublished', '', null, undefined, 'something_new']) {
    assert.equal(isFreeSamplePublishable({ publication_scope: scope }), false, String(scope));
  }
});

test('validation rows cannot escape even with the highest edge', () => {
  const picked = selectFreeSample([
    row('tracking', 0.30, 'val-a'),
    row('validation', 0.25, 'val-b'),
    row('shadow', 0.22),
    row('research', 0.21),
    row('rehearsal_shadow', 0.2),
    row('unpublished', 0.19),
    row('official', 0.05, 'off-a'),
    row('official', 0.04, 'off-b'),
    row('official', 0.03, 'off-c'),
  ]);
  assert.deepEqual(picked.map((c) => c.row.id), ['off-a', 'off-b']);
});

test('a tracking-only card yields an empty free sample, not validation filler', () => {
  assert.deepEqual(selectFreeSample([row('tracking', 0.104792), row('tracking', 0.092327)]), []);
});

test('lifecycle is still enforced: FINAL/KILLED official picks do not leave', () => {
  assert.deepEqual(selectFreeSample([{ row: { publication_scope: 'official', edge_pct: 0.1 }, lifecycle: 'FINAL' }]), []);
});

test('freeSampleView routes through selectFreeSample and refuses non-official output', () => {
  const src = readFileSync(new URL('../api/pbe-picks.js', import.meta.url), 'utf8');
  const view = src.slice(src.indexOf('async function freeSampleView'), src.indexOf('async function validationHistoryView'));
  assert.match(view, /selectFreeSample\(ctx\.eligible\.current\)/);
  assert.match(view, /free_sample_non_official_selection/);
  assert.doesNotMatch(view, /ctx\.eligible\.current\s*\n?\s*\.filter/);
});
