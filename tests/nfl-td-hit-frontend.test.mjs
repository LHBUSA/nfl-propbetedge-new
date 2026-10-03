/* TOUCHDOWN TARGET HIT — the browser half, without a browser.
 *
 * pbe-breaking-v1.js is evaluated in a VM with just enough of window/document
 * for its IIFE to install (its start() waits for DOMContentLoaded, which never
 * fires here), so the real tdHitBody renderer can be asserted as HTML. The
 * poller is checked for what it must never contain. The full-browser proof at
 * 320-1440 is scripts/td-hit-gate.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const executable = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function loadRail() {
  const store = new Map();
  const window = {
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  };
  const document = { readyState: 'loading', addEventListener() {}, getElementById: () => null, documentElement: { classList: { add() {}, remove() {} } } };
  window.window = window;
  window.document = document;
  const context = vm.createContext({ window, document, sessionStorage: window.sessionStorage, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON, Number, String, Array, Set, Map, Object, Promise, console });
  vm.runInContext(read('pbe-breaking-v1.js'), context);
  return window.PBEBreaking;
}
const rail = loadRail();
const T = rail._test;
/* values built inside the VM carry its realm's prototypes */
const plain = value => JSON.parse(JSON.stringify(value));

const event = (over = {}) => ({
  kind: 'TD_TARGET_HIT',
  game: { id: '401872954', away: 'NYJ', home: 'DET', away_score: 7, home_score: 14, period: 2, clock: '8:14' },
  player: { name: 'Jahmyr Gibbs', gsis_id: '00-0039139', position: 'RB', team: 'DET', headshot_url: 'https://a.espncdn.com/i/headshots/nfl/players/full/4429795.png' },
  target: { rank: 'primary', publication_scope: 'tracking', model_prob: 0.533039, market_price: -275 },
  play: { type: 'Rushing Touchdown', yards: 2 },
  live_stats: { carries: 8, rush_yards: 42, rushing_td: 1, receptions: 3, receiving_yards: 27, receiving_td: 0 },
  cta: [{ label: 'WATCH IN PBECAST', route: 'pbecast', game_id: '401872954' }, { label: 'VIEW TOUCHDOWN TARGETS', route: 'tdtargets' }],
  ...over,
});
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('renders the brief\'s primary copy: photo, name, rank, verified-live, probability, price, play, score, stats, footer', () => {
  const html = T.tdHitBody(event());
  const t = text(html);
  assert.match(html, /<img src="https:\/\/a\.espncdn\.com\/i\/headshots\/nfl\/players\/full\/4429795\.png"/);
  for (const expected of ['TOUCHDOWN TARGET HIT', 'Jahmyr Gibbs', 'PRIMARY TARGET · VERIFIED LIVE TARGET', 'TRACKING TARGET',
    'PBE TD PROBABILITY 53.3%', 'LOCKED PRICE -275', 'Q2 · 8:14', '2-YARD RUSHING TOUCHDOWN', 'DET 14', 'NYJ 7',
    '8 CAR · 42 YDS · 1 TD', '3 REC · 27 YDS', 'LIVE HIT · FINAL RESULT SETTLES AFTER THE GAME', 'WATCH IN PBECAST', 'VIEW TOUCHDOWN TARGETS']) {
    assert.ok(t.includes(expected), `missing: ${expected}\n${t}`);
  }
  assert.equal(/OFFICIAL/.test(t), false);
});

test('a missing photo renders no image and no stand-in', () => {
  const html = T.tdHitBody(event({ player: { name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', headshot_url: null } }));
  assert.equal(/<img[^>]+headshot/.test(html), false);
  assert.match(html, /pbeb-td is-nophoto/);
});

test('SECONDARY and OFFICIAL come only from the persisted row', () => {
  const t = text(T.tdHitBody(event({ target: { rank: 'secondary', publication_scope: 'official', model_prob: 0.333899, market_price: 500 } })));
  assert.ok(t.includes('SECONDARY TARGET HIT'));
  assert.ok(t.includes('SECONDARY TARGET · OFFICIAL TARGET'));
  assert.ok(t.includes('FINAL RESULT SETTLES AFTER THE GAME'));
  assert.equal(t.includes('VERIFIED LIVE TARGET'), false);
  for (const scope of [undefined, null, 'tracking', 'OFFICIAL', 'anything']) {
    const u = text(T.tdHitBody(event({ target: { rank: 'primary', publication_scope: scope, model_prob: 0.5, market_price: 100 } })));
    assert.equal(/OFFICIAL/.test(u), false, `scope ${scope} rendered as official`);
  }
});

test('probability and American odds formatting', () => {
  assert.equal(T.pctLabel(0.533039), '53.3%');
  assert.equal(T.pctLabel(0.3), '30.0%');
  for (const bad of [null, undefined, 0, 1, 1.5, 'x']) assert.equal(T.pctLabel(bad), null);
  assert.equal(T.oddsLabel(-275), '-275');
  assert.equal(T.oddsLabel(133), '+133');
  assert.equal(T.oddsLabel(100), '+100');
  for (const bad of [null, undefined, 0, 'x']) assert.equal(T.oddsLabel(bad), null);
});

test('live stat line: position decides the order; missing fields are absent, never zero-filled', () => {
  assert.deepEqual(plain(T.tdStatLines({ carries: 8, rush_yards: 42, rushing_td: 1, receptions: 3, receiving_yards: 27 }, 'RB')), ['8 CAR · 42 YDS · 1 TD', '3 REC · 27 YDS']);
  assert.deepEqual(plain(T.tdStatLines({ targets: 7, receptions: 5, receiving_yards: 61, receiving_td: 1, carries: 1, rush_yards: 4 }, 'WR')), ['5 REC · 61 YDS · 1 TD · 7 TGT', '1 CAR · 4 YDS']);
  assert.deepEqual(plain(T.tdStatLines({ receptions: 2 }, 'TE')), ['2 REC']);
  assert.deepEqual(plain(T.tdStatLines({ carries: 6 }, 'RB')), ['6 CAR']);
  assert.deepEqual(plain(T.tdStatLines({}, 'QB')), []);
  assert.equal(text(T.tdHitBody(event({ live_stats: {} }))).includes(' LIVE 8'), false);
  assert.deepEqual([T.tdPlayLabel({ type: 'Passing Touchdown', yards: 31 }), T.tdPlayLabel({ type: 'Rushing Touchdown', yards: null }), T.tdPlayLabel({})],
    ['31-YARD RECEIVING TOUCHDOWN', 'RUSHING TOUCHDOWN', 'TOUCHDOWN']);
});

test('long names are escaped and allowed to wrap, never truncated into another identity', () => {
  const html = T.tdHitBody(event({ player: { name: 'Christopher <b>Rodriguez-Montgomery</b> Jr.', position: 'RB', team: 'DET' } }));
  assert.ok(html.includes('Christopher &lt;b&gt;Rodriguez-Montgomery&lt;/b&gt; Jr.'));
  assert.match(read('pbe-breaking-v1.css'), /\.pbeb-tdname \{[^}]*overflow-wrap: anywhere;/);
});

test('priority: above GAME_BREAK and ordinary news, below NWS emergency and major breaking news', () => {
  const P = rail.PRIORITY;
  assert.ok(P.TD_TARGET_HIT < P.GAME_BREAK);
  assert.ok(P.TD_TARGET_HIT < P.NFL_BREAKING);
  assert.ok(P.TD_TARGET_HIT > P.NWS_EMERGENCY);
  assert.ok(P.TD_TARGET_HIT > P.NFL_BREAKING_MAJOR);
  assert.equal(rail.CONFIG.visible_ms.GAME_BREAK, 16000, 'generic GAME_BREAK kept');
});

test('once per session: the rail refuses a second offer of the same pick', () => {
  const ev = { ...event(), key: 'tdhit:test-pick', family: 'GAME', priority: rail.PRIORITY.TD_TARGET_HIT, label: 'TOUCHDOWN TARGET HIT', headline: 'x', visible_ms: 26000 };
  assert.equal(rail.offer(ev).accepted, true);
  rail.next();
  assert.equal(rail.offer({ ...ev }).accepted, false);
});

test('Player DNA only on an exact gsis id — never a name match', () => {
  T.DNA_INDEX.rows.set('rbdna', [{ route: 'rbdna', short: 'RB', gsis_id: '00-0039139', name: 'Jahmyr Gibbs' }]);
  assert.equal(T.resolvePlayerDnaById('00-0039139').route, 'rbdna');
  assert.equal(T.resolvePlayerDnaById('Jahmyr Gibbs'), null);
  assert.equal(T.resolvePlayerDnaById(null), null);
});

test('the poller detects nothing and writes nothing', () => {
  const src = executable(read('touchdown-hit-live-v1.js'));
  assert.match(src, /const ENDPOINT = '\/api\/pbe-touchdown-targets\?view=hits'/);
  assert.match(src, /const POLL_MS = 10000/);
  assert.match(src, /const INITIAL_WINDOW_MS = 3 \* 60 \* 1000/);
  assert.match(src, /window\.PBEBreaking\.offer\(toRailEvent\(hit\)\)/);
  for (const forbidden of [/method\s*:/i, /POST/, /PUT/, /PATCH/, /DELETE/, /sendBeacon/, /webhook/i, /slack/i, /discord/i, /supabase/i, /readPlayerScoring/, /nfl-live/]) {
    assert.equal(forbidden.test(src), false, `poller contains ${forbidden}`);
  }
  assert.match(src, /visibilityState === 'visible'/);
  assert.match(src, /key: `tdhit:\$\{hit\.pick_id\}`/);
  assert.match(src, /route: 'pbecast', game_id: String\(g\.espn_id\)/);
  assert.match(src, /route: 'tdtargets'/);
});

test('loader: the poller loads after the rail, the version is busted, reduced motion is honoured', () => {
  const loader = read('page-loader.js');
  const rail = loader.indexOf("{css:'./pbe-breaking-v1.css',js:'./pbe-breaking-v1.js'}");
  const poller = loader.indexOf("{js:'./touchdown-hit-live-v1.js'}");
  assert.ok(rail > 0 && poller > rail);
  assert.match(loader, /const VERSION='20261003kalshi2'/);
  assert.match(read('index.html'), /page-loader\.js\?v=20261003kalshi2/);
  assert.match(read('pbe-breaking-v1.css'), /@media \(prefers-reduced-motion: reduce\) \{\s*\.pbeb-tdface \{ animation: none; \}/);
});

test('there is no free/locked TD hit card: non-Pro readers receive no live target signal', () => {
  assert.equal(typeof T.tdHitLockedBody, 'undefined');
  assert.equal(/tdHitLockedBody/.test(read('pbe-breaking-v1.js')), false);
});
