/* Owner P0 2026-10-04 (network-wide): a matched, OPEN, traded Kalshi market whose book is one-sided at the $0/$1
   boundary keeps the full Market Pulse card (vendored shared client, propbetedge-workers 64ca257): Bid / Ask / Last
   shown truthfully, "—" for the missing side, no Mid-market value, link kept; the compact line and strip need a valid
   Mid-market and stay absent; settled cards unchanged; an old API block without `renderable` fails closed. */
import test from 'node:test';
import assert from 'node:assert/strict';

const UI = await import(new URL('../vendor/kalshi/kalshi-market-ui.js', import.meta.url));
const URL_ = 'https://kalshi.com/markets/kxnflgame/professional-football-game/kxnflgame-26oct04kcbuf';
const o = (role, abbr, ticker, bid, ask, last, over = {}) => ({
  role, abbr, kalshi_name: abbr, contract: `${abbr} wins`, market_ticker: ticker, state: 'open', result: null,
  best_yes_bid_bp: bid, best_yes_ask_bp: ask, last_price_bp: last, mid_bp: null, volume: 1840211, open_interest: 902114,
  spread_bp: null, displayable: false, renderable: true, one_sided: true, ...over,
});
const entry = (k) => ({ event: { sport: 'nfl', canonical_event_id: '401772900' }, kalshi: k });
const oneSided = () => ({
  source: 'kalshi', market_url: URL_, event_ticker: 'KXNFLGAME-26OCT04KCBUF', state: 'open', freshness: 'live', age_seconds: 20,
  mid_available: false, book: 'one_sided',
  outcomes: [o('away', 'KC', 'KXNFLGAME-26OCT04KCBUF-KC', 9900, null, 9900), o('home', 'BUF', 'KXNFLGAME-26OCT04KCBUF-BUF', null, 100, 100)],
});

test('99/1 one-sided open traded market: full card, truthful Bid/Ask/Last, "—" for the missing side, no Mid-market, link kept', () => {
  const html = UI.kalshiCard(entry(oneSided()), { placement: 'nfl-pbecast' });
  assert.ok(html.includes('Market Pulse') && html.includes(URL_));
  const panels = html.split('class="kx__panel"').slice(1);
  assert.equal(panels.length, 2);
  assert.match(panels[0], /<dt>Bid<\/dt><dd>99¢<\/dd>[\s\S]*<dt>Ask<\/dt><dd>—<\/dd>[\s\S]*<dt>Last<\/dt><dd>99¢<\/dd>/);
  assert.match(panels[1], /<dt>Bid<\/dt><dd>—<\/dd>[\s\S]*<dt>Ask<\/dt><dd>1¢<\/dd>[\s\S]*<dt>Last<\/dt><dd>1¢<\/dd>/);
  assert.ok(html.includes('Mid-market unavailable at this observation · one-sided book'));
  assert.ok(!/kx__pxl">Mid-market</.test(html), 'no Mid-market label/value');
  assert.ok(!/99\.5¢|0\.5¢/.test(html), 'no invented midpoint');
});

test('compact line and strip stay suppressed without a valid Mid-market', () => {
  assert.equal(UI.kalshiLine(entry(oneSided())), '');
  assert.ok(!String(UI.kalshiStrip(entry(oneSided()), {})).includes('kx__sp'));
});

test('settled behaviour unchanged; an old API block without `renderable` fails closed', () => {
  const settled = { ...oneSided(), state: 'settled', freshness: 'settled', outcomes: oneSided().outcomes.map((x, i) => ({ ...x, state: 'settled', result: i ? 'no' : 'yes', renderable: false })) };
  const s = UI.kalshiCard(entry(settled), { placement: 't' });
  assert.ok(s.includes('Settled YES') && s.includes('Settled NO'));
  const old = { ...oneSided(), outcomes: oneSided().outcomes.map(({ renderable, ...x }) => x) };
  assert.equal(UI.kalshiCard(entry(old), { placement: 't' }), '');
});

test('two-sided markets unchanged: Mid-market headline, no "unavailable" note', () => {
  const two = { ...oneSided(), mid_available: true, book: 'two_sided', outcomes: [
    o('away', 'KC', 'A', 6400, 6500, 6450, { mid_bp: 6450, displayable: true, one_sided: false }),
    o('home', 'BUF', 'B', 3500, 3600, 3550, { mid_bp: 3550, displayable: true, one_sided: false })] };
  const html = UI.kalshiCard(entry(two), { placement: 't' });
  assert.ok(/kx__pxl">Mid-market</.test(html) && !html.includes('Mid-market unavailable'));
  assert.ok(UI.kalshiLine(entry(two)).includes('64.5¢'));
});
