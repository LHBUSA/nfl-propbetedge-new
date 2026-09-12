import { readFileSync, writeFileSync } from 'node:fs';

const acceptancePath = 'workers/nfl-picks-engine-shared/tests/acceptance.test.mjs';
let acceptance = readFileSync(acceptancePath, 'utf8');
const before = `const strongQuote = { side: 'SEA -2.5', line: -2.5, price: -110, opposite_price: -110, line_move: 0, selected_is_home: true };`;
const after = `const strongQuote = { side: 'SEA -2.5', line: -2.5, price: -110, opposite_price: -110, line_move: 0, selected_is_home: true, team: 'SEA', over_under: null };`;
if (acceptance.includes(before)) acceptance = acceptance.replace(before, after);
if (!acceptance.includes(after)) throw new Error('strongQuote canonical attribution fixture missing');
writeFileSync(acceptancePath, acceptance, 'utf8');

const runtimePath = 'tests/pbe-picks-runtime.test.mjs';
let runtime = readFileSync(runtimePath, 'utf8');
const oldQueryAssertion = `  const q = src.match(/sb\\('nfl_game_picks', 'select=([^&']+)/)[1];`;
const newQueryAssertion = `  const q = src.match(/sb\\('nfl_game_picks', '[^']*select=([^&']+)/)[1];`;
if (runtime.includes(oldQueryAssertion)) runtime = runtime.replace(oldQueryAssertion, newQueryAssertion);
if (!runtime.includes(newQueryAssertion)) throw new Error('runtime state-view query assertion missing');
writeFileSync(runtimePath, runtime, 'utf8');

console.log('integrity acceptance fixtures aligned');
