/* Injury availability team column -- deterministic regression.
 *
 * On 2026-09-13 the Injury Editorial smoke failed on unmodified main because
 * the top availability row (Myles Garrett, Rams) rendered with no team code.
 * The live feed tagged that story teams:["LA","LV"]; the page's team directory
 * keys the Rams as LAR, so "LA" matched nothing and was silently dropped even
 * though the headline itself says "Rams'". That is a normalizer defect, fixed
 * by mapping single-franchise aliases before the corroboration check.
 *
 * The other half of the contract is also pinned here: a row whose declared
 * team is NOT supported by its own text still gets a team cell -- an explicit
 * unknown marker, never a guessed code.
 *
 * The fixture rows are verbatim from GET /api/news-feed?limit=100 at
 * 2026-09-13T22:16:38Z. No live network is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/injury-news-feed-2026-09-13.json'), 'utf8'));

/* Minimal element: exactly the DOM surface splitTeamColumn touches. */
class El {
  constructor(tag, className = '') {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.children = [];
    this.parent = null;
    this.title = '';
    this._text = '';
  }
  get classList() {
    const self = this;
    return {
      add: c => { if (!self.contains(c)) self.className = `${self.className} ${c}`.trim(); },
      contains: c => self.contains(c)
    };
  }
  contains(c) { return this.className.split(/\s+/).includes(c); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  after(node) { const list = this.parent.children; node.parent = this.parent; list.splice(list.indexOf(this) + 1, 0, node); }
  remove() { if (!this.parent) return; const list = this.parent.children; list.splice(list.indexOf(this), 1); this.parent = null; }
  querySelector(selector) {
    const m = /^:scope > (?:\.([\w-]+)|(\w+))$/.exec(selector);
    if (!m) throw new Error(`unsupported selector in test DOM: ${selector}`);
    return this.children.find(c => (m[1] ? c.contains(m[1]) : c.tagName === m[2].toUpperCase())) || null;
  }
}

function load() {
  const window = { addEventListener() {} };
  window.window = window;
  const document = {
    readyState: 'loading',
    addEventListener() {},
    querySelector() { return null; },
    createElement: tag => new El(tag)
  };
  const context = vm.createContext({ window, document, console, setTimeout, URL, Date });
  for (const file of ['archive/teams.js', 'team-globals-v1.js', 'pbe-news-trust.js', 'injury-intel-v2.js', 'injury-readability-v5.js']) {
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), context, { filename: file });
  }
  return window;
}

function rowFor(fact) {
  /* Mirrors availabilityRow()'s player cell: the team span exists only when a
     team survived corroboration. */
  const row = new El('a', 'pbe13-availability-row');
  const player = row.appendChild(new El('div', 'pbe13-availability-player'));
  const strong = player.appendChild(new El('strong'));
  strong.textContent = fact.player;
  if (fact.team) player.appendChild(new El('span')).textContent = fact.team;
  for (let i = 0; i < 3; i++) row.appendChild(new El('div', 'pbe13-availability-cell'));
  return row;
}

test('single-franchise aliases canonicalize; relocation-era and unknown codes do not', () => {
  const { PBEInjuryIntelV2: api } = load();
  assert.equal(api.canonicalTeamCode('LA'), 'LAR');
  assert.equal(api.canonicalTeamCode('gbp'), 'GB');
  assert.equal(api.canonicalTeamCode('WSH'), 'WAS');
  assert.equal(api.canonicalTeamCode('JAC'), 'JAX');
  assert.equal(api.canonicalTeamCode('LAR'), 'LAR');
  assert.equal(api.canonicalTeamCode('OAK'), 'OAK');
  assert.equal(api.canonicalTeamCode('SD'), 'SD');
});

test('live 2026-09-13 payload: the Rams row tagged "LA" resolves to LAR from its own headline', () => {
  const win = load();
  const api = win.PBEInjuryIntelV2;
  const rows = api.uniqueArticles(win.PBENewsTrust.prepare(structuredClone(FIXTURE.articles)));
  const garrett = FIXTURE.articles.find(a => a.id === 'ae1deb6e-6132-444d-9ad7-23e9b4f0eb7b');
  assert.deepEqual(garrett.teams, ['LA', 'LV'], 'fixture must carry the upstream alias verbatim');
  assert.match(garrett.title, /Rams'/);

  const facts = api.availabilityFacts(rows);
  const byPlayer = Object.fromEntries(facts.map(f => [f.player, f.team]));
  assert.deepEqual(byPlayer, { 'Myles Garrett': 'LAR', "De'Zhaun Stribling": 'SF', 'Cooper Rush': 'ATL' });
  assert.equal(facts[0].player, 'Myles Garrett', 'Garrett is the first row the smoke measured');
  /* LV is the Rams' Week 3 opponent named only in the article body; the
     visible text does not support it, so it is not shown. */
  assert.deepEqual([...api.safeTeams(rows.find(a => a.id === garrett.id))], ['LAR']);
  /* An article tagged both spellings yields one code, not two. */
  assert.deepEqual([...api.safeTeams({ title: "Rams' edge rush", summary: '', teams: ['LA', 'LAR'] })], ['LAR']);
});

test('declared teams the article text does not support are withheld, not guessed', () => {
  const win = load();
  const api = win.PBEInjuryIntelV2;
  const prepared = win.PBENewsTrust.prepare(structuredClone(FIXTURE.articles));
  /* Wire rows that share one borrowed "Jets" dek and a NYJ tag. */
  const davis = prepared.find(a => a.id === '44f515ef-e3b2-4ff8-bf41-a13db1436d0b');
  assert.equal(davis._trust.summarySuppressed, true);
  assert.deepEqual([...api.safeTeams(davis)], []);

  /* "Los Angeles" is shared by two franchises and corroborates neither, so an
     "LA" tag on a Chargers story cannot become LAR through the alias. */
  const chargers = { title: 'Los Angeles loses its left tackle to a knee injury', summary: '', teams: ['LA'] };
  assert.deepEqual([...api.safeTeams(chargers)], []);
  const jetsOrGiants = { title: 'New York loses its starting corner to a hamstring injury', summary: '', teams: ['NYJ'] };
  assert.deepEqual([...api.safeTeams(jetsOrGiants)], []);

  const named = api.factForArticle({
    title: 'Quinlan Ashworth out for the season after ankle surgery',
    summary: '', slug: 'synthetic-no-team-2', topic_kind: 'injury', teams: ['NYJ'], players: ['Quinlan Ashworth'],
    published_at: '2026-09-13T12:00:00Z'
  });
  assert.equal(named.player, 'Quinlan Ashworth');
  assert.equal(named.team, '', 'uncorroborated team is empty, never a fallback code');
});

test('team column: every row gets a second-column team cell; unknown is explicit and is not a team code', () => {
  const win = load();
  const split = win.PBEInjuryReadabilityV5.splitTeamColumn;

  const known = rowFor({ player: 'Myles Garrett', team: 'LAR' });
  assert.equal(split(known), true);
  const knownCell = known.children[1];
  assert.equal(knownCell.className, 'pbe13-availability-team');
  assert.equal(knownCell.querySelector(':scope > .team-code').textContent, 'LAR');
  assert.equal(knownCell.querySelector(':scope > .team-unreported'), null);
  assert.equal(known.children[0].querySelector(':scope > span'), null, 'the team span moves out of the player cell');
  assert.equal(known.children.length, 5);

  const unknown = rowFor({ player: 'Quinlan Ashworth', team: '' });
  assert.equal(split(unknown), true);
  const unknownCell = unknown.children[1];
  assert.equal(unknownCell.contains('pbe13-availability-team'), true);
  assert.equal(unknownCell.contains('is-unreported'), true);
  assert.equal(unknownCell.querySelector(':scope > .team-code'), null);
  const marker = unknownCell.querySelector(':scope > .team-unreported');
  assert.equal(marker.textContent, '—');
  assert.match(marker.title, /not stated/i);
  assert.equal(unknown.children.length, 5, 'five cells keep injury/status/timeline in their columns');

  assert.equal(split(unknown), false, 'idempotent across render bursts');
  assert.equal(unknown.children.length, 5);
});
