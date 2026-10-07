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
  for (const s of ['ALL ACCESS', 'Sports News', 'PropSports API', 'PropTechUSA.ai']) assert.ok(nav.includes(s), s);
  assert.doesNotMatch(nav, /Discord|discord\.gg/i, 'Discord is retired from the brand footer');
});

test('network footer sports grid holds the ten family sports in canonical order (Soccer after Tennis, F1 last)', () => {
  const src = fs.readFileSync(new URL('../network-footer-v1.js', import.meta.url), 'utf8');
  const sports = src.slice(src.indexOf('const SPORTS = ['), src.indexOf('];', src.indexOf('const SPORTS = [')));
  assert.deepEqual([...sports.matchAll(/key: '([a-z0-9]+)'/g)].map((m) => m[1]), ['mlb', 'nfl', 'nba', 'wnba', 'nhl', 'ufc', 'tennis', 'soccer', 'golf', 'f1']);
  assert.match(sports, /\{ key: 'soccer', label: 'Soccer', sub: 'Soccer Intelligence', href: 'https:\/\/soccer\.propbetedge\.ai\/' \}/);
  assert.equal((src.match(/soccer\.propbetedge\.ai/g) || []).length, 1, 'Soccer lives once, in the SPORTS registry');
  const css = fs.readFileSync(new URL('../network-footer-v1.css', import.meta.url), 'utf8');
  assert.match(css, /\.pbe-network-sports\{display:grid;grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
});
