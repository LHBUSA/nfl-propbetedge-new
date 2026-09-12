import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../best-line-model-overlay-v1.js', import.meta.url), 'utf8');

test('overlay consumes only already-authorized PBE Card model state', () => {
  assert.match(src, /window\.PBECard\?\.cards\?\.\(\)/);
  assert.match(src, /window\.PBECard\.ensure\(true\)/);
  assert.match(src, /window\.PBEPro\?\.state/);
  assert.doesNotMatch(src, /fetch\(/);
});

test('overlay fills both Best Line model columns', () => {
  assert.match(src, /data-label=\"PBE fair\"/);
  assert.match(src, /data-label=\"Model edge\"/);
  assert.match(src, /modelHtml\(event, market, side\)/);
});

test('every non-modelled market explains itself; access errors stay explicit', () => {
  /* The canonical bare dash is gone. Best Line now shows model value whenever
   * the engine evaluated the market, so the remaining states are named states,
   * not an unexplained "—": a total has no model, an anomaly is quarantined, a
   * missing input is unavailable, and an un-evaluated market says so. */
  assert.match(src, /Model layer locked/);
  assert.match(src, /MODEL DISABLED/);
  assert.match(src, /Dedicated total model required/);
  assert.match(src, /NOT MODELED/);
  assert.match(src, /QUARANTINED/);
  assert.match(src, /UNAVAILABLE/);
  assert.match(src, /Not evaluated/);
  assert.doesNotMatch(src, /No active signal/);
  assert.doesNotMatch(src, /Best Line will not invent one/);
  assert.match(src, /No model value is guessed/);
});

test('model truth stays distinct from current market truth', () => {
  /* Best Line now reads the CURRENT engine evaluation rather than a value
   * frozen at pick issue, so the distinction is carried by freshness: the
   * evaluation's own instant, and an explicit note when the displayed tape has
   * moved past it. Timestamps are never silently mixed. */
  assert.match(src, /PBE MODEL · \$\{scope\} v\$\{version\}/);
  assert.match(src, /evaluated at this tape/);
  assert.match(src, /market moved since evaluation/);
  assert.match(src, /at evaluation/);
  assert.match(src, /Never estimated from consensus/);
  /* And the model value still never comes from the book consensus. */
  assert.ok(!src.includes('no_vig_probability'), 'model value must not be derived from consensus');
});
