import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const loader = readFileSync(new URL('../page-loader.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('cold PBEcast deep links use a dedicated route-priority dependency chain', () => {
  assert.match(loader, /const ROUTE_PRIORITY=\{[\s\S]*pbecast:\[/);
  for (const dep of [
    './team-globals-v1.js',
    './pbe-game-handoff-v1.js',
    './nfl-broadcast-v1.js',
    './nfl-game-context-v1.js',
    './season-state-v1.js',
    './nfl-slate-core-v1.js',
    './pbecast-v6.js',
  ]) {
    assert.ok(loader.includes(dep), `priority chain missing ${dep}`);
  }
});

test('PBEcast authority installs before the global eager CSS fan-out on a deep link', () => {
  const priority = loader.indexOf('if(ROUTE_PRIORITY[route])await loadPriorityRoute(route);');
  const cssFanout = loader.indexOf('upgrades.forEach(item=>{if(item.css&&(!item.lazy||item.cssEager))addCss(item.css)});');
  assert.ok(priority >= 0, 'priority route install exists');
  assert.ok(cssFanout > priority, 'global CSS fan-out happens only after priority route install');
});

test('PBEcast v6 is one authority with one cache version, not a nested stale query', () => {
  assert.match(loader, /\{css:'\.\/pbecast-v6\.css',js:'\.\/pbecast-v6\.js'\}/);
  assert.match(loader, /\{route:'pbecast',js:'\.\/pbecast-v6\.js'/);
  assert.doesNotMatch(loader, /pbecast-v6\.js\?v=/);
  assert.doesNotMatch(loader, /pbecast-v6\.css\?v=/);
});

test('the document points at the new loader generation', () => {
  assert.match(loader, /const VERSION='20260922pbecastfast1'/);
  assert.match(index, /page-loader\.js\?v=20260922pbecastfast1/);
  assert.match(index, /BUILD_VERSION='nfl-intelligence-os-production-20260922-pbecastfast1'/);
});
