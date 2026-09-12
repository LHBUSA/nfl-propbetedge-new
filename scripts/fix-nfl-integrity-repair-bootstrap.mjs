import { readFileSync, writeFileSync } from 'node:fs';

const path = 'scripts/apply-nfl-picks-integrity-repair.mjs';
let src = readFileSync(path, 'utf8');

const badApiBlock = `api = replaceOnce(api,\n  \`      env, 'nfl_learning_observations', 'select=week,season,publication_scope&limit=5000',\`,\n  \`      env, 'nfl_learning_observations', 'integrity_status=eq.eligible&select=week,season,publication_scope&limit=5000',\`,\n  'engine state eligible observations');\n`;

if (src.includes(badApiBlock)) src = src.replace(badApiBlock, '');

const writeMarker = `write(orchestratorPath, orchestrator);`;
const correctBlock = `orchestrator = replaceOnce(orchestrator,\n  \`      env, 'nfl_learning_observations', 'select=week,season,publication_scope&limit=5000',\`,\n  \`      env, 'nfl_learning_observations', 'integrity_status=eq.eligible&select=week,season,publication_scope&limit=5000',\`,\n  'engine state eligible observations');\nwrite(orchestratorPath, orchestrator);`;

if (!src.includes("orchestrator = replaceOnce(orchestrator,\n  `      env, 'nfl_learning_observations'")) {
  if (!src.includes(writeMarker)) throw new Error('orchestrator write marker missing');
  src = src.replace(writeMarker, correctBlock);
}

if (src.includes(badApiBlock)) throw new Error('bad API marker still present');
writeFileSync(path, src, 'utf8');
console.log('integrity bootstrap script target fixed');
