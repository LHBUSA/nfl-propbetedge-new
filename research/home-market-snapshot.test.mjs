/* LAST VERIFIED MARKET — the Dashboard-only fallback that summarises one
   stored nfl_odds_snapshots batch when the live provider path is down.
   These tests pin the contract: it is labelled as a stale snapshot, it
   carries its capture time, it never claims to be live, and it only ever
   produces spread / total / moneyline (no player props). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSnapshot } from '../api/home-market.js';

const T = '2026-09-06T12:00:00.000Z';
const row = (o) => ({ book: 'consensus:7', captured_at: T, is_closing: false, ...o });
const batch = [
  row({ market: 'spread', side: 'NE', team: 'NE', is_home: false, line: 3.5, price: -110 }),
  row({ market: 'spread', side: 'SEA', team: 'SEA', is_home: true, line: -3.5, price: -110 }),
  row({ market: 'total', side: 'over', over_under: 'over', line: 43.5, price: -108 }),
  row({ market: 'total', side: 'under', over_under: 'under', line: 43.5, price: -112 }),
  row({ market: 'moneyline', side: 'NE', team: 'NE', is_home: false, price: 150 }),
  row({ market: 'moneyline', side: 'SEA', team: 'SEA', is_home: true, price: -175 }),
];
const event = { id: '2026_01_NE_SEA', away: 'New England Patriots', home: 'Seattle Seahawks' };

test('a stored batch is summarised under its own stale semantics, never LIVE', () => {
  const m = summarizeSnapshot(batch, event, 'Odds provider request failed (502)');
  assert.equal(m.ok, true);
  assert.equal(m.semantics, 'LAST_VERIFIED_SNAPSHOT');
  assert.equal(m.stale, true);
  assert.equal(m.live_feed.status, 'UNAVAILABLE');
  assert.equal(m.captured_at, T);
  assert.equal(m.provider_last_update, T);
  assert.ok(m.age_minutes >= 0);
  assert.ok(!/\blive\b/i.test(m.source.semantics.replace(/not the live feed/i, '')), 'source text must not call the data live');
  assert.notEqual(m.semantics, 'CURRENT_CROSS_BOOK_CONSENSUS');
});

test('spread, total and moneyline come straight from the stored rows', () => {
  const m = summarizeSnapshot(batch, event, '');
  assert.deepEqual(m.spread, { away: 3.5, home: -3.5 });
  assert.equal(m.total.line, 43.5);
  assert.equal(m.total.over_price, -108);
  assert.equal(m.total.under_price, -112);
  assert.deepEqual(m.moneyline, { away: 150, home: -175 });
  assert.equal(m.books, 7);
  assert.equal(m.quote_count, 6);
  assert.deepEqual(m.coverage, { h2h_quotes: 2, spread_quotes: 2, total_quotes: 2 });
});

test('vig-free probability is derived from the stored moneyline and sums to one', () => {
  const m = summarizeSnapshot(batch, event, '');
  assert.ok(Math.abs(m.vig_free_probability.away + m.vig_free_probability.home - 1) < 1e-9);
  assert.ok(m.vig_free_probability.home > m.vig_free_probability.away);
});

test('missing markets are null, never invented', () => {
  const m = summarizeSnapshot(batch.filter((r) => r.market === 'spread'), event, '');
  assert.deepEqual(m.spread, { away: 3.5, home: -3.5 });
  assert.equal(m.total.line, null);
  assert.deepEqual(m.moneyline, { away: null, home: null });
  assert.deepEqual(m.vig_free_probability, { away: null, home: null });
});

test('the summary never carries player props, whatever the store holds', () => {
  const polluted = [...batch, row({ market: 'player_pass_yds', side: 'over', line: 250.5, price: -115 })];
  const m = summarizeSnapshot(polluted, event, '');
  assert.equal(JSON.stringify(m).includes('player_pass_yds'), false);
  assert.ok(!('props' in m) && !('players' in m));
});

test('an empty batch yields nothing (the endpoint stays 503)', () => {
  assert.equal(summarizeSnapshot([], event, ''), null);
  assert.equal(summarizeSnapshot(null, event, ''), null);
});
