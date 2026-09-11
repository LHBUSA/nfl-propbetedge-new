/* Best Line: best available price, market consensus, PBE fair value and model
 * edge are four different numbers and are never merged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenEvent, bestQuote, summarizeEvent, bookLeaderboard, impliedProb, payout } from '../workers/nfl-intel/src/bestline-core.js';

const book = (key, title, markets) => ({ key, title, last_update: '2026-09-11T12:00:00Z', markets });
const EVENT = {
  id: 'evt1', commence_time: '2026-09-13T17:00:00Z', away_team: 'Atlanta Falcons', home_team: 'Pittsburgh Steelers',
  bookmakers: [
    book('dk', 'DraftKings', [
      { key: 'spreads', outcomes: [{ name: 'Atlanta Falcons', point: 5.5, price: -115 }, { name: 'Pittsburgh Steelers', point: -5.5, price: -105 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 41.5, price: -110 }, { name: 'Under', point: 41.5, price: -110 }] },
      { key: 'h2h', outcomes: [{ name: 'Atlanta Falcons', price: 190 }, { name: 'Pittsburgh Steelers', price: -230 }] }
    ]),
    book('fd', 'FanDuel', [
      { key: 'spreads', outcomes: [{ name: 'Atlanta Falcons', point: 5, price: -110 }, { name: 'Pittsburgh Steelers', point: -5, price: -110 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 41.5, price: -105 }, { name: 'Under', point: 41.5, price: -115 }] },
      { key: 'h2h', outcomes: [{ name: 'Atlanta Falcons', price: 185 }, { name: 'Pittsburgh Steelers', price: -225 }] }
    ]),
    book('bu', 'BetUS', [
      { key: 'spreads', outcomes: [{ name: 'Atlanta Falcons', point: 5, price: -108 }, { name: 'Pittsburgh Steelers', point: -4.5, price: -110 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 42, price: -110 }] },
      { key: 'h2h', outcomes: [{ name: 'Atlanta Falcons', price: 203 }, { name: 'Pittsburgh Steelers', price: -245 }] }
    ])
  ]
};

test('price arithmetic', () => {
  assert.equal(impliedProb(-110).toFixed(4), '0.5238');
  assert.equal(impliedProb(150), 0.4);
  assert.equal(impliedProb(0), null);
  assert.ok(payout(150) > payout(-110));
});

test('best available: the best NUMBER first, then the best price at it', () => {
  const quotes = flattenEvent(EVENT);
  const atl = bestQuote(quotes.filter(q => q.market === 'spread' && q.side === 'Atlanta Falcons'));
  assert.equal(atl.line, 5.5); assert.equal(atl.book, 'DraftKings');   // +5.5 beats +5 even at -115
  const pit = bestQuote(quotes.filter(q => q.market === 'spread' && q.side === 'Pittsburgh Steelers'));
  assert.equal(pit.line, -4.5); assert.equal(pit.book, 'BetUS');
  const over = bestQuote(quotes.filter(q => q.market === 'total' && q.side === 'OVER'));
  assert.equal(over.line, 41.5); assert.equal(over.price, -105);         // lower total, then price
  const ml = bestQuote(quotes.filter(q => q.market === 'moneyline' && q.side === 'Atlanta Falcons'));
  assert.equal(ml.price, 203);
});

test('consensus: median line, vig-free only from books quoting both sides at that line', () => {
  const e = summarizeEvent(EVENT, { now: Date.parse('2026-09-11T13:00:00Z') });
  const atl = e.markets.spread['Atlanta Falcons'];
  assert.equal(atl.consensus.line, 5);
  /* FanDuel quotes ATL +5 / PIT -5; BetUS quotes ATL +5 but PIT -4.5, so it
     is describing a different bet and is excluded. */
  assert.equal(atl.consensus.no_vig_books, 1);
  assert.equal(atl.consensus.no_vig_probability, 0.5);
  const over = e.markets.total.OVER;
  assert.equal(over.consensus.no_vig_books, 2, 'BetUS has no Under, so it cannot be de-vigged');
  assert.equal(e.started, false);
});

test('fair value and edge are never filled in from the market', () => {
  const e = summarizeEvent(EVENT);
  for (const m of ['spread', 'total', 'moneyline']) {
    for (const s of Object.values(e.markets[m])) {
      assert.equal(s.pbe_fair, null);
      assert.equal(s.model_edge, null);
    }
  }
});

test('a kicked-off game is flagged started: its quotes are history, not prices', () => {
  const e = summarizeEvent(EVENT, { now: Date.parse('2026-09-13T18:00:00Z') });
  assert.equal(e.started, true);
});

test('book leaderboard shares ties', () => {
  const e = summarizeEvent(EVENT);
  const board = Object.fromEntries(bookLeaderboard([e]).map(r => [r.book, r.best_count]));
  assert.ok(board.DraftKings >= 1 && board.BetUS >= 1 && board.FanDuel >= 1);
});
