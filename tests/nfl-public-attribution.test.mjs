import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async p => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const executable = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('PBEcast public attribution is PropSports, never ESPN-branded', async () => {
  const src = await read('pbecast-v6.js');
  const code = executable(src);
  assert.match(code, /PUBLIC_DATA_LABEL='PropSports\.PropTechUSA\.ai'/);
  assert.match(code, /function sourceLabel\(\)\{return PUBLIC_DATA_LABEL\}/);
  assert.match(code, /PUBLIC_DATA_URL='https:\/\/propsports\.proptechusa\.ai'/);
  assert.match(code, /class="cast6-source-link"/);
  assert.match(code, /target="_blank"/);
  assert.match(code, /rel="noopener noreferrer"/);
  assert.equal(/ESPN LIVE|ESPN SCOREBOARD/.test(code), false);
});

test('late production polish cannot restore ESPN-branded source labels', async () => {
  const src = await read('production-polish-v2.js');
  const code = executable(src);
  assert.match(code, /PUBLIC_DATA_LABEL='PropSports\.PropTechUSA\.ai'/);
  assert.equal(/['"]ESPN LIVE['"]|['"]ESPN SCOREBOARD['"]/.test(code), false);
  assert.match(code, /ESPN_CDN_GAMEPACKAGE',PUBLIC_DATA_LABEL/);
  assert.match(code, /ESPN_CDN_SCOREBOARD',PUBLIC_DATA_LABEL/);
});

test('consumer game-status labels use PropSports while raw provider identity stays internal', async () => {
  const propchain = await read('propchain-core-v3.js');
  const changes = await read('workers/nfl-intel/src/changes-core.js');
  assert.match(propchain, /label: c\.source\?\.label \|\| 'PropSports\.PropTechUSA\.ai'/);
  assert.match(changes, /provider: 'espn_site_scoreboard', label: 'PropSports\.PropTechUSA\.ai'/);
});

test('loader version-busts both attribution authorities', async () => {
  const loader = await read('page-loader.js');
  const index = await read('index.html');
  assert.match(loader, /pbecast-v6\.js\?v=20260920propsports2/);
  assert.match(loader, /production-polish-v2\.js\?v=20260920propsports1/);
  assert.match(index, /page-loader\.js\?v=20260920propsports2/);
});
