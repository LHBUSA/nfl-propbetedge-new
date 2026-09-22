import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const loader = readFileSync(new URL('../page-loader.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('cold PBEcast deep links install v6 before every unrelated dynamic route module', () => {
  assert.match(loader, /const ROUTE_PRIORITY=\{[\s\S]*pbecast:\['\.\/pbecast-v6\.js'\]/);
  const priority = loader.indexOf("pbecast:['./pbecast-v6.js']");
  assert.ok(priority >= 0, 'v6 is the PBEcast priority authority');
});

test('PBEcast route priority does not change the production CSS cascade', () => {
  const priority = loader.indexOf('if(ROUTE_PRIORITY[route])await loadPriorityRoute(route);');
  const cssFanout = loader.indexOf('upgrades.forEach(item=>{if(item.css&&(!item.lazy||item.cssEager))addCss(item.css)});');
  assert.ok(cssFanout >= 0, 'eager CSS fan-out exists');
  assert.ok(priority > cssFanout, 'CSS keeps manifest order before the route-first JS authority installs');
});

test('PBEcast v6 is one authority with one cache version, not a nested stale query', () => {
  assert.match(loader, /\{css:'\.\/pbecast-v6\.css',js:'\.\/pbecast-v6\.js'\}/);
  assert.match(loader, /\{route:'pbecast',js:'\.\/pbecast-v6\.js'/);
  assert.doesNotMatch(loader, /pbecast-v6\.js\?v=/);
  assert.doesNotMatch(loader, /pbecast-v6\.css\?v=/);
});

test('the document points at the new loader generation', () => {
  assert.match(loader, /const VERSION='20260922pbecastfast2'/);
  assert.match(index, /page-loader\.js\?v=20260922pbecastfast2/);
  assert.match(index, /BUILD_VERSION='nfl-intelligence-os-production-20260922-pbecastfast2'/);
});
