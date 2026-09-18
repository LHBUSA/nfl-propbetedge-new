/**
 * Team attribution in the news trust guard.
 *
 *   node --test tests/news-team-attribution.test.mjs
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 * On 2026-09-18 the live Carolina @ Atlanta matchup page listed, under
 * Atlanta's "Current News": DJ Moore (Bills), Jalen Carter (Eagles), Josh Allen
 * (Bills), a Sean McVay quote about Myles Garrett, and a Bills-Lions game
 * recap. None of them is an Atlanta story.
 *
 * The cause was not a loose regex in the matchup page. /api/news-feed returned
 * 27 of 50 articles carrying the IDENTICAL boilerplate summary "Atlanta's
 * cornerstone corner and pro-bowl guard cleared for practice Thursday…", and
 * the upstream had derived teams:["ATL"] and the identical pair
 * players:["A.J. Terrell","Chris Lindstrom"] from that boilerplate. The tag was
 * canonical and it was wrong. Matchups trusted it.
 *
 * Rule 1 (duplicate summary = service fallback) already suppressed the dek and
 * rule 2 already stripped the player tags. Teams were passed through
 * uncorroborated. They no longer are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

function loadTrust() {
  const sandbox = { window: {}, module: { exports: {} }, console };
  vm.runInNewContext(
    readFileSync(join(REPO, 'archive', 'teams.js'), 'utf8')
    + '\n;window.NFL_TEAMS=(typeof NFL_TEAMS!=="undefined")?NFL_TEAMS:{};', sandbox);
  vm.runInNewContext(readFileSync(join(REPO, 'pbe-news-trust.js'), 'utf8'), sandbox);
  return { T: sandbox.window.PBENewsTrust, TEAMS: sandbox.window.NFL_TEAMS };
}

const { T, TEAMS } = loadTrust();
const opts = { teams: TEAMS };

const story = (title, summary, teams = [], players = []) =>
  ({ title, summary, teams, players, published_at: '2026-09-18T12:00:00Z' });

/* ---------------------------------------------------- the exact live failure */

test('the CAR @ ATL regression: boilerplate-derived ATL tags are refused', () => {
  /* The five stories the owner saw, with the real boilerplate summary that
     produced the tag, plus two more so rule 1 sees it as a duplicate. */
  const BOILER = "Atlanta's cornerstone corner and pro-bowl guard cleared for practice Thursday, "
    + 'signaling their readiness for a weekend divisional clash.';
  const feed = [
    story('Report: DJ Moore day-to-day with shoulder injury', BOILER, ['ATL'], ['A.J. Terrell', 'Chris Lindstrom']),
    story('Jalen Carter to wear a cast on his wrist against the Titans', BOILER, ['ATL'], ['A.J. Terrell', 'Chris Lindstrom']),
    story('Josh Allen: Very fortunate to be the QB to open this stadium', BOILER, ['ATL'], ['A.J. Terrell', 'Chris Lindstrom']),
    story("Sean McVay: Myles Garrett is like Wolverine, healing fast, but we won't rush him back", BOILER, ['ATL'], ['A.J. Terrell', 'Chris Lindstrom']),
    story("Thursday Night Football: Josh Allen accounts for five TDs in Bills' 41-31 win over Lions", BOILER, ['ATL'], ['A.J. Terrell', 'Chris Lindstrom']),
  ];
  T.prepare(feed, opts);

  assert.deepEqual(T.storiesForTeam(feed, 'ATL', { limit: 99 }), [],
    'not one of these may be attached to Atlanta');
  for (const item of feed) {
    assert.deepEqual(item._trust.teams, [], `${item.title} must carry no team`);
    assert.deepEqual(item._trust.teamsSuppressed, ['ATL'], 'the refusal is auditable, not silent');
    assert.equal(item._trust.summarySuppressed, true, 'the boilerplate dek is suppressed too');
    assert.deepEqual(item._trust.players, [], 'the boilerplate player pair is refused');
  }
});

test('the same five stories are not attached to Carolina either', () => {
  const BOILER = "Atlanta's cornerstone corner and pro-bowl guard cleared for practice Thursday, "
    + 'signaling their readiness for a weekend divisional clash.';
  const feed = [
    story('Report: DJ Moore day-to-day with shoulder injury', BOILER, ['ATL']),
    story('Jalen Carter to wear a cast on his wrist against the Titans', BOILER, ['ATL']),
  ];
  T.prepare(feed, opts);
  assert.deepEqual(T.storiesForTeam(feed, 'CAR', { limit: 99 }), []);
});

/* -------------------------------------------------------- the attribution rules */

test('a canonical tag corroborated by the headline is kept', () => {
  const feed = [
    story("Allen's Five-TD Debut Lifts Bills Past Lions in Highmark Stadium Christening",
      'A unique editorial dek about the game.', ['BUF', 'DET']),
  ];
  T.prepare(feed, opts);
  assert.deepEqual(feed[0]._trust.teams.sort(), ['BUF', 'DET']);
  assert.equal(T.storiesForTeam(feed, 'BUF').length, 1);
  assert.equal(T.storiesForTeam(feed, 'DET').length, 1);
});

test('a Falcons story with no city in the title is still an Atlanta story', () => {
  const feed = [story('Falcons place Kyle Pitts on injured reserve', 'A unique dek.', ['ATL'])];
  T.prepare(feed, opts);
  assert.deepEqual(feed[0]._trust.teams, ['ATL'], 'the nickname corroborates');
});

test('a city mentioned incidentally is not a team match', () => {
  /* Atlanta is a real city that hosts games, meetings and players' hometowns.
     None of that makes a story a Falcons story. */
  const feed = [
    story('Super Bowl LIII was played in Atlanta', 'A unique dek about the venue.', []),
    story('Player grew up in Atlanta before starring at Georgia', 'A unique dek.', []),
  ];
  T.prepare(feed, opts);
  for (const item of feed) assert.deepEqual(item._trust.teams, []);
  assert.deepEqual(T.storiesForTeam(feed, 'ATL', { limit: 99 }), []);
});

test('a shared or ambiguous city never corroborates on its own', () => {
  for (const [abbr, title] of [
    ['CAR', 'Heavy rain across North Carolina delayed the flight'],
    ['WAS', 'The bill stalled in Washington this week'],
    ['NYG', 'A New York restaurant honoured the coach'],
    ['NYJ', 'A New York restaurant honoured the coach'],
    ['LAR', 'Los Angeles traffic delayed the team bus'],
    ['NE', 'New England weather turned in the fourth quarter'],
  ]) {
    const feed = [story(title, 'A unique dek.', [abbr])];
    T.prepare(feed, opts);
    assert.deepEqual(feed[0]._trust.teams, [],
      `${abbr}: "${title}" must not corroborate on the city alone`);
  }
});

test('the abbreviation matches as a word, never inside another word', () => {
  const feed = [
    story('A story about the Atlantic coast schedule', 'A unique dek.', ['ATL']),
    story('No decision yet on the roster move', 'A unique dek.', ['NO']),
  ];
  T.prepare(feed, opts);
  assert.deepEqual(feed[0]._trust.teams, [], '"Atlantic" must not corroborate ATL');
  assert.deepEqual(feed[1]._trust.teams, [], '"No" must not corroborate NO');

  const good = [story('ATL activates its third quarterback', 'A unique dek.', ['ATL'])];
  T.prepare(good, opts);
  assert.deepEqual(good[0]._trust.teams, ['ATL'], 'a standalone abbreviation does corroborate');
});

test('boilerplate can never corroborate a team, even when it names one', () => {
  /* Two articles sharing a dek that names the Falcons. Rule 1 removes the dek,
     so rule 3 has nothing left to read — which is the entire point. */
  const BOILER = 'The Falcons cleared two starters for practice on Thursday ahead of a divisional clash.';
  const feed = [
    story('Unrelated wire story about another club', BOILER, ['ATL']),
    story('A second unrelated wire story', BOILER, ['ATL']),
  ];
  T.prepare(feed, opts);
  for (const item of feed) assert.deepEqual(item._trust.teams, []);

  /* The same dek on ONE article is that article's own copy and does corroborate. */
  const single = [story('Unrelated wire story about another club', BOILER, ['ATL'])];
  T.prepare(single, opts);
  assert.deepEqual(single[0]._trust.teams, ['ATL']);
});

test('an unresolved or unknown tag is never team-specific', () => {
  const feed = [
    story('A story with no tags at all', 'A unique dek.', []),
    story('A story tagged with a team that does not exist', 'A unique dek.', ['ZZZ']),
  ];
  T.prepare(feed, opts);
  assert.deepEqual(feed[0]._trust.teams, []);
  assert.deepEqual(feed[1]._trust.teams, []);
});

test('storiesForTeam is the only team matcher, and it orders newest first', () => {
  const feed = [
    { ...story('Falcons sign a guard', 'Unique A.', ['ATL']), published_at: '2026-09-01T00:00:00Z' },
    { ...story('Falcons waive a tackle', 'Unique B.', ['ATL']), published_at: '2026-09-17T00:00:00Z' },
  ];
  T.prepare(feed, opts);
  const out = T.storiesForTeam(feed, 'ATL');
  assert.equal(out.length, 2);
  assert.match(out[0].title, /waive/, 'newest first');
  /* Length, not deepEqual: the module runs in a vm realm, so an array it
     creates itself has a different Array.prototype and strict deepEqual would
     fail on the prototype rather than on the contents. */
  assert.equal(T.storiesForTeam(feed, '').length, 0, 'no abbreviation means no stories');
});

/* ------------------------------------------- no second matcher in the product */

test('the matchup page does not keep a team matcher of its own', () => {
  const candidates = ['matchups-v3.js', 'matchups-v2.js'];
  const file = candidates.map(f => join(REPO, f)).find(existsSync);
  assert.ok(file, 'a matchup module must exist');
  const source = readFileSync(file, 'utf8');
  assert.equal(/includes\(\s*city\s*\)/.test(source), false, 'no city-substring matcher');
  assert.equal(/\.includes\(name\)/.test(source), false, 'no team-name substring matcher');
  assert.match(source, /PBENewsTrust/, 'it must use the shared trust guard');
});

/* --------------------------------------------- the live feed, when available */

const LIVE = join(REPO, 'tests', 'fixtures', 'news-feed-2026-09-18.json');
test('the captured live feed: 27 false Atlanta tags, 0 survive', { skip: existsSync(LIVE) ? false : 'fixture not captured' }, () => {
  const payload = JSON.parse(readFileSync(LIVE, 'utf8'));
  const arr = Object.values(payload).find(v => Array.isArray(v) && v.length && v[0].title);
  const rawAtl = arr.filter(a => (a.teams || []).includes('ATL')).length;
  T.prepare(arr, opts);
  assert.equal(rawAtl, 27, 'the fixture is the payload that produced the failure');
  assert.equal(T.storiesForTeam(arr, 'ATL', { limit: 99 }).length, 0, 'none may survive');
  /* and the genuinely-tagged game stories are untouched */
  assert.ok(T.storiesForTeam(arr, 'BUF', { limit: 99 }).length > 0, 'real Bills stories survive');
  assert.ok(T.storiesForTeam(arr, 'DET', { limit: 99 }).length > 0, 'real Lions stories survive');
});
