// nfl.propbetedge.ai share identity: @PROPBETEDGE (network X account), the
// dedicated 1200x630 NFL card (not the bare logo), and no stale identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const meta = (attr, name) => {
  const open = `<meta ${attr}="${name}" content="`;
  const i = html.indexOf(open);
  return i < 0 ? undefined : html.slice(i + open.length, html.indexOf('"', i + open.length));
};
const CARD = 'https://nfl.propbetedge.ai/og/propbetedge-nfl-1200x630.png?v=20260926';

test('homepage share card is the dedicated NFL card with complete, matching meta', () => {
  assert.equal(meta('property', 'og:image'), CARD);
  assert.equal(meta('property', 'og:image:secure_url'), CARD);
  assert.equal(meta('property', 'og:image:type'), 'image/png');
  assert.equal(meta('property', 'og:image:width'), '1200');
  assert.equal(meta('property', 'og:image:height'), '630');
  assert.ok(meta('property', 'og:image:alt').length > 20);
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta('name', 'twitter:site'), '@PROPBETEDGE');
  assert.equal(meta('name', 'twitter:image'), CARD);
  assert.equal(meta('name', 'twitter:image:alt'), meta('property', 'og:image:alt'));
  assert.doesNotMatch(html, /pbe-full-600\.png/, 'the bare logo is not a share card');
  assert.equal(html.split('<link rel="canonical" href="https://nfl.propbetedge.ai/">').length - 1, 1);
});

test('the card asset is a 1200x630 RGB PNG', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'og/propbetedge-nfl-1200x630.png'));
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(buf.readUInt32BE(16), 1200);
  assert.equal(buf.readUInt32BE(20), 630);
  assert.equal(buf[25], 2, 'RGB, no alpha');
});

test('PropBetEdge publisher sameAs is the canonical X profile, once', () => {
  assert.equal(html.split('"https://x.com/PROPBETEDGE"').length - 1, 1);
});

test('no stale PropBetEdge X identity or legacy share intent in shipped source', () => {
  const STALE = [/x\.com\/MLBHRALERTSPBE/i, /@MLBHRALERTSPBE/i, /x\.com\/propbetedgeai/i, /@propbetedgeai/i, /twitter\.com\/intent/i, /x\.com\/intent\/tweet/i];
  const files = execSync('git ls-files -- "*.js" "*.html" "*.mjs"', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(f => f && !f.startsWith('tests/') && !f.startsWith('docs/') && !f.startsWith('history/'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const re of STALE) assert.doesNotMatch(text, re, `${f} contains ${re}`);
  }
});
