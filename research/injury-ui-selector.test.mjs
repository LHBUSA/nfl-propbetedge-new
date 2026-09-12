import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../injury-command-center-v1.js', import.meta.url), 'utf8');

test('injury UI defaults to a single selected team instead of all teams', () => {
  assert.match(src, /selectedTeam:\s*'AUTO'/);
  assert.match(src, /data-team-select/);
  assert.match(src, /function selectedTeams\(/);
});

test('injury UI defaults to actionable statuses, not active roster noise', () => {
  assert.match(src, /status:\s*'IMPACT'/);
  assert.match(src, /\['IMPACT','Injured \/ Questionable'\]/);
});
