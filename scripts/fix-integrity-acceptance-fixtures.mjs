import { readFileSync, writeFileSync } from 'node:fs';

const path = 'workers/nfl-picks-engine-shared/tests/acceptance.test.mjs';
let src = readFileSync(path, 'utf8');
const before = `const strongQuote = { side: 'SEA -2.5', line: -2.5, price: -110, opposite_price: -110, line_move: 0, selected_is_home: true };`;
const after = `const strongQuote = { side: 'SEA -2.5', line: -2.5, price: -110, opposite_price: -110, line_move: 0, selected_is_home: true, team: 'SEA', over_under: null };`;
if (src.includes(before)) src = src.replace(before, after);
if (!src.includes(after)) throw new Error('strongQuote canonical attribution fixture missing');
writeFileSync(path, src, 'utf8');
console.log('integrity acceptance fixture aligned');
