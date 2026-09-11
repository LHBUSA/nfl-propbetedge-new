import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const media = read('nfl-brand-media-v2.js');
const archive = read('archive/utils.js');

test('archive teamCrest renders real NFL image assets instead of synthetic shields', () => {
  /* Line-ending agnostic: the committed file is LF, but a Windows checkout with
     core.autocrlf=true has CRLF, and an LF-only closing-brace extraction then
     matched nothing and failed an otherwise-correct teamCrest. Same assertions. */
  const body = archive.match(/function teamCrest\([\s\S]*?\r?\n}\r?\n/)?.[0] || '';
  assert.match(archive, /a\.espncdn\.com\/i\/teamlogos\/nfl\/500/);
  assert.match(body, /pbe-official-team-logo/);
  assert.doesNotMatch(body, /<svg|<path|<text/);
});

test('global media authority recognizes every known synthetic team-logo fallback', () => {
  for (const selector of ['pbes-score-logo-fallback','pbe25-logo-fallback','pbe-team-logo-fallback','pbe2-team-fallback','pbe-team-img','pbe7-team-logo']) {
    assert.match(media, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(media, /svg\.team-crest/);
  assert.match(media, /replaceWithRealTeamLogo/);
});

test('team logo failures retry a second real image and never synthesize initials', () => {
  assert.match(media, /scoreboard\/\$\{key\}\.png/);
  assert.match(media, /teamlogos\/nfl\/500\/\$\{key\}\.png/);
  assert.doesNotMatch(media, /fallback\.textContent\s*=\s*abbr/);
  assert.doesNotMatch(media, /className='pbe-team-logo-fallback'/);
});

test('fake PropBetEdge svg marks are replaced with the real published brand mark', () => {
  assert.match(media, /https:\/\/propbetedge\.ai\/logo\/pbe-mark-160\.png/);
  assert.match(media, /\.sidebar-logo,\.pbe-v2-brand/);
  assert.match(media, /pbe-official-brand-logo/);
});

test('sportsbook abbreviation marks are replaced by real domain brand icons', () => {
  for (const domain of ['draftkings.com','fanduel.com','betmgm.com','caesars.com','betrivers.com','bet365.com','fanatics.com','espnbet.com','hardrock.bet']) {
    assert.match(media, new RegExp(domain.replace('.', '\\.')));
  }
  assert.match(media, /\.pbe22-bookmark/);
  assert.match(media, /i\.pbe5-mark/);
  assert.match(media, /favicon\.ico/);
  assert.match(media, /google\.com\/s2\/favicons/);
});

test('logo repair stays bounded without a page-wide MutationObserver', () => {
  assert.doesNotMatch(media, /new MutationObserver/);
  assert.match(media, /setInterval\(scan,15000\)/);
  assert.match(media, /pbe:route-changed/);
});
