/* Real ESM syntax check.
 *
 * `node --check file.js` does NOT reliably report syntax errors in a .js file
 * that contains ESM import/export: it parses as CommonJS, and the ESM retry
 * path lets genuine errors through with exit 0. Verified against a `*​/`
 * inside a block comment, which node --check passed and a .mjs check caught.
 *
 * This helper copies each target to a temporary .mjs and checks that instead,
 * so the parser is unambiguous.
 *
 * Usage: node check-syntax.mjs <file> [...files]
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node check-syntax.mjs <file> [...files]');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'pbe-syntax-'));
let failed = 0;

for (const file of files) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`MISSING  ${file}`);
    failed += 1;
    continue;
  }
  const target = join(dir, `${basename(file).replace(/\.[cm]?js$/, '')}.mjs`);
  writeFileSync(target, source);
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    console.log(`OK       ${file}`);
  } catch (error) {
    const detail = String(error.stderr || error.message)
      .split('\n')
      .filter(line => /SyntaxError|\^/.test(line))
      .slice(0, 2)
      .join(' ')
      .trim();
    console.error(`SYNTAX   ${file}: ${detail}`);
    failed += 1;
  }
}

rmSync(dir, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`\n${files.length} file(s) OK.`);
