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
  /* propbetedge-workers 8b73545 workers/propsports-markets/client/ (market history). Re-vendor
     the four files together and update these hashes; never edit them here. */
  const PINNED = {
    'README.md': 'a80e4ac5d8733bde8afc0c13c281242babff8b1acd083974741f677b7af5a480',
    'kalshi-market-client.js': '211be23bb9a5b2be0a1b4ed1a1c2c1b3b2dfc4ef45a040ae13c07d28a8ae8744',
    'kalshi-market-ui.css': 'fb046ada2b2e5450207e4301c0e41a193aa599e4661843fdcdb50d45ac7191ae',
    'kalshi-market-ui.js': '93a8f485e90633a1cd70e93ab4123c1dc2161d08b3a76e41ec3cc4a0279d74f4',
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
  const command = read('pbecast-command-v1.js').split('\r\n').join('\n');
  /* MLB PBEcast standard: ONE market host directly under the hero (scoreboard) in every
     phase; the pregame preview and the pick follow it; it never moves under the replay */
  assert.match(command, /const kalshi = hostFor\(root, 'kalshi', '\[data-cast6-hero\]'\);\n    place\(kalshi, hero\);\n    place\(preview, kalshi\);\n    window\.PBENflKalshi\?\.pbecast\?\.mount\?\.\(kalshi, v6\(\)\);/);
  assert.match(command, /place\(pick, pre \? preview : kalshi\);/);
  assert.doesNotMatch(command, /place\(kalshi, moments\)/);
  /* the sportsbook MARKET tile is untouched and Kalshi is not in it */
  assert.doesNotMatch(read('pbecast-preview-v1.js'), /kalshi/i);
  const games = read('games-v2.js');
  assert.match(games, /if\(!g\?\.espnEventId\)return'';\n    const final=gs\.kind==='FINAL';/);
  assert.match(games, /lineFor\?\.\(g\.espnEventId,\{final\}\)/, 'a FINAL card asks for the market-history line');
  assert.match(games, /K\.lineFor\(el\.dataset\.kxSlot,\{final:el\.dataset\.kxFinal==='1'\}\)/);
  assert.match(games, /const kalshi=loadKalshi\(\);\n      const \[games,scores\]=await Promise\.all/);
  const bridgeSrc = read('nfl-kalshi.js');
  assert.match(bridgeSrc, /import\(`\$\{VENDOR\}kalshi-market-ui\.js\$\{v\}`\)/);
  assert.match(bridgeSrc, /nextPollMs\(entry, cast\.phase, K\)/);
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
  assert.match(h.host.innerHTML, /^<div class="cast-mkt" data-phase="pre">/);
  assert.match(text(h.host.innerHTML), /^MARKET OPEN · PRE-MATCH Market Pulse/);
  assert.match(h.host.innerHTML, /data-kx-nfl="pbecast"/);
  assert.match(h.host.innerHTML, /class="ic kx kx--compact"/);
  assert.match(text(h.host.innerHTML), /A tie pays 50¢ per contract/);
  const live = h.timers.filter(t => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 45000);
});

test('PBEcast live: the full compact card under LIVE MARKET (never a collapsed strip), polled at 20 s; a game switch drops the old timer', async () => {
  const other = entry({ market_url: 'https://kalshi.com/markets/kxnflgame/nfl-game/kxnflgame-26oct04detbuf' }, { canonical_event_id: '401872932' });
  const h = castHarness({ 401872965: entry(), 401872932: other });
  h.n.pbecast.mount(h.host, v6('401872965', 'LIVE'));
  await settle(); await settle();
  h.n.pbecast.mount(h.host, v6('401872965', 'LIVE'));
  assert.match(h.host.innerHTML, /data-phase="live"/);
  assert.match(text(h.host.innerHTML), /^LIVE MARKET Market Pulse/);
  assert.match(h.host.innerHTML, /class="ic kx kx--compact"[^>]*data-kx-placement="pbecast"/);
  assert.match(text(h.host.innerHTML), /Mid-market/);
  assert.match(text(h.host.innerHTML), /View market on Kalshi/);
  assert.doesNotMatch(h.host.innerHTML, /<details/);
  const first = h.timers.filter(t => !t.cleared);
  assert.equal(first.length, 1);
  assert.equal(first[0].ms, 20000);
  h.n.pbecast.mount(h.host, v6('401872932', 'LIVE'));
  assert.ok(first[0].cleared, 'the previous game\'s poll is cleared on a switch');
  assert.doesNotMatch(h.host.innerHTML, /indwas/, 'never the previous game\'s market under the new game');
  await settle(); await settle();
  assert.deepEqual(h.calls, ['401872965', '401872932']);
});

test('PBEcast: detail for another game than the selection -> no read, nothing rendered', async () => {
  const h = castHarness({ 401872965: entry() });
  const g = v6('401872965', 'LIVE'); g.activeId = '401872932';
  h.n.pbecast.mount(h.host, g);
  await settle();
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.length, 0);
  assert.equal(h.host.innerHTML, '');
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

/* ---- Market history ("How the market closed") ---------------------------------
 * Fixture is the REAL settled tennis event from the live API
 * (GET /v1/market-intelligence/event/tennis/00a0f4e8-67cb-593c-a77b-65b62d709937,
 * 2026-10-03), reshaped here only in sport / ids / names so it reads as an NFL
 * game. Test-only; no production code path reads it. */
const TENNIS = JSON.parse(readFileSync(new URL('fixtures/market-history-settled-tennis.json', import.meta.url), 'utf8'));
const NFL_URL = 'https://kalshi.com/markets/kxnflgame/nfl-game/kxnflgame-26oct04indwas';
function settled(lifecycle = 'SETTLED') {
  const e = JSON.parse(JSON.stringify(TENNIS.event));
  const names = [['IND', 'Indianapolis'], ['WSH', 'Washington']];
  e.event = { ...e.event, sport: 'nfl', competition: 'nfl', canonical_event_id: '401872965', state: 'post' };
  e.kalshi = { ...e.kalshi, market_url: NFL_URL, event_ticker: 'KXNFLGAME-26OCT04INDWAS', proposition: 'team_wins_game_tie_half' };
  e.market = { ...e.market, lifecycle, market_url: NFL_URL, proposition: 'team_wins_game_tie_half', close: { ...e.market.close, lifecycle } };
  e.market.close.outcomes = e.market.close.outcomes.map((o, i) => ({ ...o, abbr: names[i][0], result: lifecycle === 'CLOSED' ? null : o.result }));
  const h = e.market_history;
  Object.assign(h, { lifecycle, market_url: NFL_URL, event_ticker: 'KXNFLGAME-26OCT04INDWAS', proposition: 'team_wins_game_tie_half', status_label: lifecycle === 'SETTLED' ? 'Market settled' : 'Market closed' });
  h.outcomes.forEach((o, i) => {
    o.abbr = names[i][0]; o.kalshi_name = names[i][1]; o.contract = `${names[i][1]} wins`;
    if (lifecycle === 'CLOSED') o.settlement = null;
  });
  if (lifecycle === 'CLOSED') h.markers = { ...h.markers, settlement: null };
  return e;
}

test('history card renders for a SETTLED NFL game (real settled JSON): stored values, venue settlement, rel sponsored', () => {
  const html = N.history(settled(), { K, id: '401872965' });
  const t = text(html);
  assert.match(t, /^How the market closed Market history · Kalshi Market settled/);
  assert.match(t, /IND Indianapolis wins First observed 94\.5¢ Final trade 1¢ Settled NO/);
  assert.match(t, /WSH Washington wins First observed 5\.5¢ Final trade 99¢ Settled YES/);
  assert.match(t, /Kalshi settlement: WSH — YES/);
  assert.match(t, /“First observed” is our first record, not the opening price/);
  assert.match(t, /not sportsbook odds and not a PropBetEdge model\. Settlement is the market venue's, not our result\./);
  assert.match(t, /NFL tie rule A tie pays 50¢ per contract\./);
  assert.doesNotMatch(t.replace('not the opening price', ''), /opening price|opened at|Kalshi intelligence/i);
  assert.doesNotMatch(t, /earlier than|more accurate|stale/i);
  assert.match(html, /<svg [^>]*aria-label="Observed market prices over time"/);
  assert.doesNotMatch(html, /style="/, 'no inline styles');
  const anchors = html.match(/<a [^>]*>/g) || [];
  assert.ok(anchors.length >= 1);
  for (const a of anchors) {
    assert.ok(a.includes(`href="${NFL_URL}"`), a);
    assert.match(a, /target="_blank"/);
    assert.match(a, /rel="noopener noreferrer sponsored"/);
  }
});

test('CLOSED market on a FINAL game: "Market closed · awaiting settlement", never settled', () => {
  const t = text(N.history(settled('CLOSED'), { K }));
  assert.match(t, /Market closed · awaiting settlement/);
  assert.match(t, /Awaiting settlement/);
  assert.doesNotMatch(t, /Settled (YES|NO)|settlement: /);
});

test('market history: no entry / no history / still trading -> nothing', () => {
  assert.equal(N.history(null, { K }), '');
  const noHist = settled(); delete noHist.market_history;
  assert.equal(N.history(noHist, { K }), '');
  const trading = settled(); trading.market.lifecycle = 'ACTIVE';
  assert.equal(N.history(trading, { K }), '');
  assert.equal(N.history(settled(), { K, id: '401872999' }), '', 'only for its own game');
  assert.equal(N.history(settled(), { K: null }), '');
  assert.equal(N.closeLine(null, { K }), '');
  const pre = entry(); pre.market = { venue: 'kalshi', lifecycle: 'UPCOMING', close: null };
  assert.equal(N.closeLine(pre, { K }), '', 'no close summary -> nothing on the card');
});

test('FINAL result card: restrained market-history line from the board entry', () => {
  const l = N.closeLine(settled(), { K, id: '401872965' });
  assert.match(text(l), /^MARKET WSH first 5\.5¢ · settled YES$/);
  assert.match(l, /class="kx-line kx-line--closed mono"/);
  assert.match(text(N.closeLine(settled('CLOSED'), { K })), /awaiting settlement/);
  /* the live line is still never drawn on a final card */
  assert.equal(N.line(entry(), { K, final: true }), '');
});

test('PBEcast FINAL game: history card from the event read; SETTLED -> no further reads', async () => {
  const h = castHarness({ 401872965: settled() });
  h.n.pbecast.mount(h.host, v6('401872965', 'FINAL'));
  assert.equal(h.host.innerHTML, '', 'no board seed for a final game, nothing before the read');
  await settle(); await settle();
  assert.deepEqual(h.calls, ['401872965']);
  h.n.pbecast.mount(h.host, v6('401872965', 'FINAL'));
  assert.match(h.host.innerHTML, /data-kx-nfl="pbecast-history"[\s\S]*data-kx-history/);
  assert.match(text(h.host.innerHTML), /^MARKET SETTLED How the market closed/);
  assert.equal(h.timers.filter(t => !t.cleared).length, 0, 'SETTLED is never polled');
});

test('PBEcast FINAL game, CLOSED market: awaiting settlement, re-read every 5 min', async () => {
  const h = castHarness({ 401872965: settled('CLOSED') });
  h.n.pbecast.mount(h.host, v6('401872965', 'FINAL'));
  await settle(); await settle();
  h.n.pbecast.mount(h.host, v6('401872965', 'FINAL'));
  assert.match(text(h.host.innerHTML), /^MARKET CLOSED · AWAITING SETTLEMENT How the market closed/);
  assert.match(text(h.host.innerHTML), /Market closed · awaiting settlement/);
  const live = h.timers.filter(t => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 5 * 60 * 1000);
});

test('PBEcast FINAL game with no market: one read, nothing rendered, no poll', async () => {
  const h = castHarness({});
  h.n.pbecast.mount(h.host, v6('401872965', 'FINAL'));
  await settle(); await settle();
  h.n.pbecast.mount(h.host, v6('401872965', 'FINAL'));
  assert.deepEqual(h.calls, ['401872965']);
  assert.equal(h.host.innerHTML, '');
  assert.equal(h.timers.filter(t => !t.cleared).length, 0);
});

test('poll cadence: live 20 s, pregame 45 s, CLOSED 5 min, SETTLED none', () => {
  const k = { client: CLIENT.createKalshiClient({ sport: 'nfl', fetchImpl: async () => ({ ok: false }) }) };
  assert.equal(N.nextPollMs(entry(), 'live', k), 20000);
  assert.equal(N.nextPollMs(entry(), 'pregame', k), 45000);
  assert.equal(N.nextPollMs(null, 'live', k), 120000);
  assert.equal(N.nextPollMs(settled('CLOSED'), 'final', k), 300000);
  assert.equal(N.nextPollMs(settled('CLOSED'), 'live', k), 300000);
  assert.equal(N.nextPollMs(settled(), 'final', k), null);
  assert.equal(N.nextPollMs(null, 'final', k), null);
});

test('completed entry with no live kalshi block (8b73545 loaders keep it): history + close line, no live surfaces', () => {
  const e = settled(); e.kalshi = null;
  assert.match(text(N.history(e, { K })), /How the market closed[\s\S]*NFL tie rule/);
  assert.match(text(N.closeLine(e, { K })), /^MARKET WSH/);
  assert.equal(N.card(e, { K }), '');
  assert.equal(N.strip(e, { K }), '');
  assert.equal(N.line(e, { K }), '');
});

test('8b73545 algoVsMarket exports are vendored but not mounted on NFL', () => {
  for (const f of ['nfl-kalshi.js', 'pbecast-command-v1.js', 'games-v2.js']) assert.doesNotMatch(read(f), /algoVsMarket/);
});

/* Mirrors propbetedge-workers a229028 (history-regression): a completed market with
   NO live quote (kalshi null) must survive the vendored board AND event loaders and
   render "How the market closed" through the NFL bridge — never a live card. */
test('regression a229028: completed kalshi:null entry survives both loaders and renders history on NFL', async () => {
  for (const lifecycle of ['SETTLED', 'CLOSED']) {
    const ev = settled(lifecycle); ev.kalshi = null;
    const { market_history, ...boardEntry } = ev;
    const fetchImpl = async url => ({
      ok: true,
      json: async () => (/\/sport\/nfl$/.test(url)
        ? { contract: 'market-intel/1', sport: 'nfl', enabled: true, events: [boardEntry] }
        : { contract: 'market-intel/1', sport: 'nfl', enabled: true, event: ev }),
    });
    const client = CLIENT.createKalshiClient({ sport: 'nfl', fetchImpl });
    await client.loadBoard();
    assert.ok(client.forEvent('401872965'), `${lifecycle}: board dropped the completed entry`);
    const got = await client.loadEvent('401872965');
    assert.ok(got?.market_history, `${lifecycle}: event read nulled the completed entry`);
    /* Games FINAL card, through the bridge's own lineFor + the real client */
    const { N: n } = bridge({ PBEKalshi: { ...UI, client } });
    const l = n.lineFor('401872965', { final: true });
    assert.match(text(l), lifecycle === 'SETTLED' ? /^MARKET WSH .*settled YES$/ : /awaiting settlement$/);
    assert.equal(n.lineFor('401872965'), '', 'no live line from a completed entry');
    /* PBEcast FINAL, through castFetch + the real client */
    const timers = [];
    const ctx = { PBEKalshi: { ...UI, client }, setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: () => {}, PBEcastCommand: { render() {} } };
    const { N: c } = bridge(ctx);
    const host = { dataset: {}, innerHTML: '' };
    c.pbecast.mount(host, v6('401872965', 'FINAL'));
    await settle(); await settle();
    c.pbecast.mount(host, v6('401872965', 'FINAL'));
    const t = text(host.innerHTML);
    assert.match(t, /^MARKET (SETTLED|CLOSED · AWAITING SETTLEMENT) How the market closed/);
    assert.match(t, lifecycle === 'SETTLED' ? /Kalshi settlement: WSH — YES/ : /Market closed · awaiting settlement/);
    assert.doesNotMatch(t, /Market Pulse|Live prediction market/i, 'a completed market is never labelled live');
  }
});

test('PBEcast lifecycle labels: final still trading, stale in-game quote never LIVE', () => {
  assert.equal(JSON.stringify(N.castPhase(entry(), 'final')), JSON.stringify(['final-open', 'GAME FINAL · MARKET STILL TRADING']));
  assert.match(text(N.castModule(entry(), 'final', { K })), /^GAME FINAL · MARKET STILL TRADING Market Pulse/);
  assert.equal(JSON.stringify(N.castPhase(entry({ freshness: 'stale', age_seconds: 900 }), 'live')), JSON.stringify(['stale', 'MARKET OPEN · QUOTE STALE']));
  assert.equal(N.castPhase(null, 'live'), null);
  assert.equal(N.castModule(null, 'live', { K }), '');
  assert.equal(N.castModule(entry({}, { canonical_event_id: '999' }), 'live', { K, id: '401872965' }), '', 'another game');
});

test('PBEcast rail footer: exact, displayable, fresh two-sided markets only; patched in place', () => {
  const game = (semantics, ids = ['11', '28']) => ({ id: '401872965', status: { semantics }, teams: { away: { id: ids[0], abbreviation: 'IND' }, home: { id: ids[1], abbreviation: 'WSH' } } });
  assert.equal(N.railText(entry(), game('SCHEDULE'), K), 'IND 65.5¢ · WSH 34.5¢');
  assert.equal(N.railText(entry(), game('LIVE'), K), 'IND 65.5¢ · WSH 34.5¢');
  assert.equal(N.railText(entry(), game('FINAL'), K), '', 'final: no footer');
  assert.equal(N.railText(entry(), game('SCHEDULE', ['28', '11']), K), '', 'team ids must match away / home');
  assert.equal(N.railText(entry({ freshness: 'stale', age_seconds: 900 }), game('LIVE'), K), '', 'stale');
  assert.equal(N.railText(entry({ outcomes: [out({ displayable: false }), wsh()] }), game('LIVE'), K), '', 'not displayable');
  assert.equal(N.railText(entry({}, { canonical_event_id: '1' }), game('LIVE'), K), '', 'other event');
  let inserted = '';
  N.patchRailChip({ querySelector: () => null, insertAdjacentHTML: (_, h) => { inserted = h; } }, 'IND 65.5¢ · WSH 34.5¢');
  assert.match(inserted, /^<em class="kx-nfl-rail"[^>]*><b>MKT<\/b><span>IND 65\.5¢ · WSH 34\.5¢<\/span><\/em>$/);
  const span = { textContent: 'IND 65.5¢ · WSH 34.5¢' };
  let removed = false;
  const el = { querySelector: () => span, remove: () => { removed = true; } };
  N.patchRailChip({ querySelector: () => el }, 'IND 66.0¢ · WSH 34.0¢');
  assert.equal(span.textContent, 'IND 66.0¢ · WSH 34.0¢');
  N.patchRailChip({ querySelector: () => el }, '');
  assert.ok(removed);
  const src = read('nfl-kalshi.js');
  assert.equal((src.match(/K\.client\.loadBoard\(\)/g) || []).length, 3, 'Games board, PBEcast rail refresh and its early prefetch: all the one shared-client board read (15 s TTL)');
});
