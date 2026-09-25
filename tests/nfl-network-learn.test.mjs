// Learn (learn.propbetedge.ai) is a first-party network destination in the NFL footer ecosystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('network footer ecosystem links to PropBetEdge Learn (canonical, same-tab, once)', () => {
  const src = fs.readFileSync(new URL('../network-footer-v1.js', import.meta.url), 'utf8');
  const eco = src.slice(src.indexOf('aria-label="PropBetEdge ecosystem"'));
  const nav = eco.slice(0, eco.indexOf('</nav>'));
  assert.match(nav, /<a href="https:\/\/learn\.propbetedge\.ai\/">Learn<\/a>/);
  assert.equal((src.match(/learn\.propbetedge\.ai/g) || []).length, 1, 'exactly one Learn link');
  // Existing ecosystem destinations are unchanged.
  for (const s of ['ALL ACCESS', 'Sports News', 'PropSports API', 'PropTechUSA.ai', 'Discord ↗']) assert.ok(nav.includes(s), s);
});
