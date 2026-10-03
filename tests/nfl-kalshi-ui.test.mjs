/* Kalshi Market Intelligence on NFL: the shared component (vendor/kalshi/,
 * unchanged) through the NFL bridge (nfl-kalshi.js).
 *
 * No entry -> nothing. Every Kalshi value links to the verified market, new
 * tab, rel sponsored. An NFL entry renders both teams. NFL game contracts pay
 * 50¢ per contract on a tie, and the card says so. The browser never calls a
 * Kalshi API host. PBEcast reads one game, polls at the client's cadence for
 * that game's phase, and drops the previous game's timer on a switch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const REPO = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, REPO), 'utf8');
const UI = await import(new URL('vendor/kalshi/kalshi-market-ui.js', REPO));
const CLIENT = await import(new URL('vendor/kalshi/kalshi-market-client.js', REPO));

/* the bridge, evaluated as the page does (UMD; module.exports in this sandbox) */
function bridge(extra = {}) {
  const sandbox = { module: { exports: {} }, console, ...extra };
  vm.runInNewContext(read('nfl-kalshi.js'), sandbox);
  return { N: sandbox.module.exports, sandbox };
}
const { N } = bridge();
const K = { ...UI };   // what window.PBEKalshi carries, minus the client

/* the live API's NFL shape (GET /v1/market-intelligence/sport/nfl, 2026-10-03) */
const URL_ = 'https://kalshi.com/markets/kxnflgame/nfl-game/kxnflgame-26oct04indwas';
const out = (over = {}) => ({
  role: 'away', team_id: '11', abbr: 'IND', kalshi_name: 'Indianapolis', contract: 'Indianapolis wins', market_ticker: 'KXNFLGAME-26OCT04INDWAS-IND',
  state: 'open', result: null, yes_bid_bp: 6500, yes_ask_bp: 6600, best_yes_bid_bp: 6500, best_yes_ask_bp: 6600,
  last_price_bp: 6600, mid_bp: 6550, volume: 135745.69, open_interest: 116250.99, spread_bp: 100, displayable: true, ...over,
});
const wsh = (over = {}) => out({ role: 'home', team_id: '28', abbr: 'WSH', kalshi_name: 'Washington', contract: 'Washington wins', market_ticker: 'KXNFLGAME-26OCT04INDWAS-WAS', best_yes_bid_bp: 3400, best_yes_ask_bp: 3500, mid_bp: 3450, last_price_bp: 3500, ...over });
const entry = (k = {}, ev = {}) => ({
  event: { sport: 'nfl', competition: 'nfl', canonical_event_id: '401872965', start_at: '2026-10-04T13:30:00+00:00', state: 'pre', ...ev },
  kalshi: { source: 'kalshi', source_type: 'prediction_market', market_url: URL_, event_ticker: 'KXNFLGAME-26OCT04INDWAS', proposition: 'team_wins_game_tie_half', state: 'open', freshness: 'live', age_seconds: 40, outcomes: [out(), wsh()], ...k },
  sportsbooks: null, pbe: null, comparisons: [],
});
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

test('no entry -> nothing at every NFL placement', () => {
  assert.equal(N.card(null, { K }), '');
  assert.equal(N.strip(null, { K }), '');
  assert.equal(N.line(null, { K }), '');
  assert.equal(N.card(entry({ market_url: '' }), { K }), '', 'no link, no card');
  assert.equal(N.card(entry({ state: 'closed' }), { K }), '');
  assert.equal(N.card(entry(), { K: null }), '', 'component not loaded yet -> nothing, never a placeholder');
  assert.equal(N.lineFor('401872965'), '', 'no board read -> no line');
  assert.equal(N.tieNote(null), '');
});

test('an entry is shown only for the ESPN event it belongs to', () => {
  assert.equal(N.card(entry(), { K, id: '401872999' }), '');
  assert.equal(N.strip(entry(), { K, id: '401872999' }), '');
  assert.equal(N.line(entry(), { K, id: '401872999' }), '');
  assert.notEqual(N.card(entry(), { K, id: '401872965' }), '');
});

test('every Kalshi value links to the verified market: new tab, rel sponsored', () => {
  for (const html of [N.card(entry(), { K }), N.strip(entry(), { K }), N.strip(entry(), { K, open: true })]) {
    const anchors = html.match(/<a [^>]*>/g) || [];
    assert.ok(anchors.length >= 3);
    for (const a of anchors) {
      assert.ok(a.includes(`href="${URL_}"`), a);
      assert.match(a, /target="_blank"/);
      assert.match(a, /rel="noopener noreferrer sponsored"/);
    }
  }
  assert.match(text(N.card(entry(), { K })), /View market on Kalshi ↗/);
});

test('an NFL entry renders both teams with labelled Mid-market, bid and ask', () => {
  const t = text(N.card(entry(), { K, placement: 'pbecast-preview' }));
  assert.match(t, /IND Indianapolis wins · YES 65\.5¢ Mid-market/);
  assert.match(t, /WSH Washington wins · YES 34\.5¢ Mid-market/);
  assert.match(t, /Bid 65¢ Ask 66¢ Last 66¢/);
  assert.match(t, /not sportsbook odds and not a PropBetEdge model/);
  assert.doesNotMatch(t, /win probability|chance to win|implied|PBE prediction/i);
  const s = text(N.strip(entry(), { K }));
  assert.match(s, /^Market Pulse IND 65\.5¢ \| WSH 34\.5¢/);
  assert.match(s, /Live prediction-market expectations — no sportsbook line required · Kalshi/);
  assert.match(t, /^Market Pulse Live prediction market · Kalshi/);
  assert.match(t, /Live prediction-market pricing — no sportsbook line required\. Traded contract prices on Kalshi/);
  const l = N.line(entry(), { K });
  assert.match(text(l), /KALSHI IND 65\.5¢ · WSH 34\.5¢/);
  assert.match(l, /prediction market, not sportsbook odds/);
});

test('NFL tie rule: "A tie pays 50¢ per contract" beside the card and inside the expanded strip', () => {
  const card = N.card(entry(), { K });
  assert.match(text(card), /NFL tie rule A tie pays 50¢ per contract\./);
  assert.ok(card.indexOf('kx-nfl-tie') > card.indexOf('</section>'), 'the note sits next to the vendored card, not inside it');
  const strip = N.strip(entry(), { K });
  assert.match(strip, /<p class="kx-nfl-tie">[\s\S]*<\/p><\/details>/);
  /* only where the API says the contract is the tie-half proposition */
  assert.doesNotMatch(N.card(entry({ proposition: 'team_wins_game' }), { K }), /tie pays/);
  assert.equal(N.TIE_NOTE, 'A tie pays 50¢ per contract.');
});

test('game-card line: never on a final game; stale is withheld by the component', () => {
  assert.equal(N.line(entry(), { K, final: true }), '');
  assert.equal(N.line(entry({}, { state: 'post' }), { K }), '');
  assert.equal(N.line(entry({ freshness: 'stale', age_seconds: 900 }), { K }), '');
  assert.match(N.line(entry({ freshness: 'delayed', age_seconds: 250 }), { K }), /KALSHI/);
});

test('strip keeps a reader-opened state across repaints', () => {
  assert.match(N.strip(entry(), { K, open: true }), /<details open class="kx-strip"/);
  assert.doesNotMatch(N.strip(entry(), { K }), /<details open/);
});

test('team colours come from the game or the team table and are validated hex', () => {
  const { N: n } = bridge({ NFL_TEAMS: { IND: { color: '#002C5F' }, WSH: { color: 'red' } } });
  const c = n.colorsFor({ away: { abbreviation: 'IND' }, home: { abbreviation: 'WSH', color: '5a1414' } });
  assert.equal(c.away, '#002C5F');
  assert.equal(c.home, '#5a1414');
  const none = n.colorsFor({ away: { abbreviation: 'XXX' }, home: { color: 'javascript:alert(1)' } });
  assert.equal(Object.keys(none).length, 0);
});

test('the browser never calls Kalshi: no Kalshi API host in any shipped browser file', () => {
  const KALSHI_API = /(?:api\.elections\.kalshi\.com|trading-api\.kalshi\.com|demo-api\.kalshi\.co|external-api\.kalshi\.com|kalshi\.com\/trade-api)/i;
  const files = [
    ...readdirSync(new URL('./', REPO)).filter(f => f.endsWith('.js')),
    ...readdirSync(new URL('vendor/kalshi/', REPO)).filter(f => f.endsWith('.js')).map(f => `vendor/kalshi/${f}`),
  ];
  assert.ok(files.includes('nfl-kalshi.js') && files.includes('vendor/kalshi/kalshi-market-client.js'));
  for (const f of files) assert.doesNotMatch(read(f), KALSHI_API, `${f} must not reference a Kalshi API host`);
  /* the only market host is our propsports-markets Worker */
  assert.match(read('vendor/kalshi/kalshi-market-client.js'), /base = 'https:\/\/propsports-markets\.sales-fd3\.workers\.dev'/);
  assert.doesNotMatch(read('nfl-kalshi.js'), /base\s*:/, 'the bridge does not override the client base');
});

test('vendored component is byte-identical to the canonical shared client', () => {
  /* propbetedge-workers 9352ec6 workers/propsports-markets/client/. Re-vendor
     the four files together and update these hashes; never edit them here. */
  const PINNED = {
    'README.md': 'a80e4ac5d8733bde8afc0c13c281242babff8b1acd083974741f677b7af5a480',
    'kalshi-market-client.js': '653cb0fc2673f909552453052560bfd6194e0e4d045c51b1eb73483957d4c049',
    'kalshi-market-ui.css': '572d18127bf6ce357e50b4320e0d98d83b07aa3d6bfb1e1c04c43bee4f009f98',
    'kalshi-market-ui.js': '0f03224b086e11967329e2a4666ef5327e335fbb32ae251a31a2a543b30e1952',
  };
  for (const [f, sha] of Object.entries(PINNED)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`vendor/kalshi/${f}`, REPO))).digest('hex'), sha, `vendor/kalshi/${f} was edited`);
  }
});

test('wiring: loader order, PBEcast placement, Games line', () => {
  const loader = read('page-loader.js');
  const css = loader.indexOf("{css:'./vendor/kalshi/kalshi-market-ui.css'}");
  const nfl = loader.indexOf("{css:'./nfl-kalshi.css',js:'./nfl-kalshi.js'}");
  const cmd = loader.indexOf("{css:'./pbecast-command-v1.css',js:'./pbecast-command-v1.js'}");
  assert.ok(css > 0 && nfl > css && cmd > nfl, 'component CSS, then the bridge, then the PBEcast command layer that mounts it');
  const command = read('pbecast-command-v1.js');
  assert.match(command, /const kalshi = hostFor\(root, 'kalshi', '\[data-cast6-hero\]'\);\n    place\(kalshi, pre \? preview : hero\);\n    window\.PBENflKalshi\?\.pbecast\?\.mount\?\.\(kalshi, v6\(\)\);/);
  assert.match(command, /place\(pick, kalshi\);/);
  /* the sportsbook MARKET tile is untouched and Kalshi is not in it */
  assert.doesNotMatch(read('pbecast-preview-v1.js'), /kalshi/i);
  const games = read('games-v2.js');
  assert.match(games, /if\(!g\?\.espnEventId\|\|gs\.kind==='FINAL'\)return'';/);
  assert.match(games, /const kalshi=loadKalshi\(\);\n      const \[games,scores\]=await Promise\.all/);
  const bridgeSrc = read('nfl-kalshi.js');
  assert.match(bridgeSrc, /import\(`\$\{VENDOR\}kalshi-market-ui\.js\$\{v\}`\)/);
  assert.match(bridgeSrc, /K\.client\.pollMsFor\(cast\.phase\)/);
});

/* ---- PBEcast lifecycle against a fake client and a fake host ----------------- */
function castHarness(responses) {
  const timers = [];
  const calls = [];
  let rendered = 0;
  const client = {
    async loadEvent(id) { calls.push(id); return responses[id] ?? null; },
    forEvent() { return null; },
    pollMsFor: CLIENT.createKalshiClient({ sport: 'nfl', fetchImpl: async () => ({ ok: false }) }).pollMsFor,
  };
  const ctx = {
    PBEKalshi: { ...UI, client },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.cleared = true; },
    PBEcastCommand: { render: () => { rendered += 1; } },
  };
  const { N: n } = bridge(ctx);
  const host = { dataset: {}, innerHTML: '' };
  return { n, host, timers, calls, rendered: () => rendered };
}
const v6 = (id, semantics) => ({ activeId: id, detail: { game: { id, status: { semantics }, teams: { away: { abbreviation: 'IND' }, home: { abbreviation: 'WSH' } } } } });
const settle = () => new Promise(r => setImmediate(r));

test('PBEcast pregame: one read for the selected game, full card + tie note, next read at 45 s', async () => {
  const h = castHarness({ 401872965: entry() });
  h.n.pbecast.mount(h.host, v6('401872965', 'SCHEDULE'));
  assert.equal(h.host.innerHTML, '', 'nothing painted before the read lands; PBEcast is not held');
  await settle(); await settle();
  assert.deepEqual(h.calls, ['401872965']);
  h.n.pbecast.mount(h.host, v6('401872965', 'SCHEDULE'));
  assert.match(h.host.innerHTML, /data-kx-nfl="pbecast-preview"/);
  assert.match(text(h.host.innerHTML), /A tie pays 50¢ per contract/);
  const live = h.timers.filter(t => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 45000);
});

test('PBEcast live: the strip with placement "pbecast", polled at 20 s; a game switch drops the old timer', async () => {
  const other = entry({ market_url: 'https://kalshi.com/markets/kxnflgame/nfl-game/kxnflgame-26oct04detbuf' }, { canonical_event_id: '401872932' });
  const h = castHarness({ 401872965: entry(), 401872932: other });
  h.n.pbecast.mount(h.host, v6('401872965', 'LIVE'));
  await settle(); await settle();
  h.n.pbecast.mount(h.host, v6('401872965', 'LIVE'));
  assert.match(h.host.innerHTML, /<details class="kx-strip"[^>]*data-kx-placement="pbecast"/);
  const first = h.timers.filter(t => !t.cleared);
  assert.equal(first.length, 1);
  assert.equal(first[0].ms, 20000);
  h.n.pbecast.mount(h.host, v6('401872932', 'LIVE'));
  assert.ok(first[0].cleared, 'the previous game\'s poll is cleared on a switch');
  assert.doesNotMatch(h.host.innerHTML, /indwas/, 'never the previous game\'s market under the new game');
  await settle(); await settle();
  assert.deepEqual(h.calls, ['401872965', '401872932']);
});

test('PBEcast final or unknown game: no read, no timer, nothing rendered', async () => {
  const h = castHarness({ 401872965: entry() });
  h.n.pbecast.mount(h.host, v6('401872965', 'FINAL'));
  await settle();
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.length, 0);
  assert.equal(h.host.innerHTML, '');
  /* detail for another game than the selection renders nothing */
  const g = v6('401872965', 'LIVE'); g.activeId = '401872932';
  h.n.pbecast.mount(h.host, g);
  await settle();
  assert.deepEqual(h.calls, []);
});

test('PBEcast with no market: nothing rendered, looked at again only at the idle cadence', async () => {
  const h = castHarness({});
  h.n.pbecast.mount(h.host, v6('401872965', 'LIVE'));
  await settle(); await settle();
  h.n.pbecast.mount(h.host, v6('401872965', 'LIVE'));
  assert.equal(h.host.innerHTML, '');
  const live = h.timers.filter(t => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 120000);
});
