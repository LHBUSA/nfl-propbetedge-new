/* Odds normalization tests, driven by a REAL captured provider response
 * (tests/fixtures/odds-real.json) plus synthetic edge cases.
 *
 * The launch-blocker this file exists to prevent: an away-team selection
 * being recorded as the home team.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TEAM_NAME_TO_CODE, teamCodeFromName, isOverUnder, canonicalSide,
  normalizeOutcome, normalizeEvent, consensusByside, pairOpposites,
  PROVIDER_MARKET_TO_CANONICAL,
} from '../odds-normalize.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/odds-real.json', import.meta.url), 'utf8'),
);

test('the fixture is a real provider response with the expected shape', () => {
  assert.ok(fixture.events.length >= 2);
  const e = fixture.events[0];
  assert.ok(e.home_team && e.away_team);
  assert.ok(Array.isArray(e.bookmakers) && e.bookmakers.length);
  const keys = new Set(e.bookmakers.flatMap(b => b.markets.map(m => m.key)));
  for (const k of ['h2h', 'spreads', 'totals']) assert.ok(keys.has(k), `missing ${k}`);
});

test('all 32 provider team names map to gateway codes, one to one', () => {
  const names = Object.keys(TEAM_NAME_TO_CODE);
  const codes = Object.values(TEAM_NAME_TO_CODE);
  assert.equal(names.length, 32);
  assert.equal(new Set(codes).size, 32);
  assert.equal(teamCodeFromName('Seattle Seahawks'), 'SEA');
  assert.equal(teamCodeFromName('Los Angeles Rams'), 'LA');
  assert.equal(teamCodeFromName('Los Angeles Chargers'), 'LAC');
});

test('an unknown team name returns null instead of guessing a side', () => {
  assert.equal(teamCodeFromName('San Antonio Ravens'), null);
  assert.equal(teamCodeFromName(''), null);
  assert.equal(teamCodeFromName(undefined), null);
});

test('every team name in the real fixture resolves', () => {
  for (const e of fixture.events) {
    assert.ok(teamCodeFromName(e.home_team), `home ${e.home_team}`);
    assert.ok(teamCodeFromName(e.away_team), `away ${e.away_team}`);
  }
});

test('provider markets map to the canonical names', () => {
  assert.equal(PROVIDER_MARKET_TO_CANONICAL.h2h, 'moneyline');
  assert.equal(PROVIDER_MARKET_TO_CANONICAL.spreads, 'spread');
  assert.equal(PROVIDER_MARKET_TO_CANONICAL.totals, 'total');
});

/* ------------------------------------------------------------------------
 * The launch blocker: home vs away attribution
 * --------------------------------------------------------------------- */

test('HOME and AWAY selections are attributed correctly from real data', () => {
  const event = fixture.events[0];
  const rows = normalizeEvent(event);
  const homeCode = teamCodeFromName(event.home_team);
  const awayCode = teamCodeFromName(event.away_team);

  const homeRows = rows.filter(r => r.team === homeCode);
  const awayRows = rows.filter(r => r.team === awayCode);
  assert.ok(homeRows.length, 'no home rows');
  assert.ok(awayRows.length, 'no away rows');

  for (const r of homeRows) assert.equal(r.is_home, true, `${r.side} should be home`);
  for (const r of awayRows) assert.equal(r.is_home, false, `${r.side} should be away`);

  // And the two are never confused.
  assert.equal(homeRows.some(r => r.is_home === false), false);
  assert.equal(awayRows.some(r => r.is_home === true), false);
});

test('is_home is derived per event, so the same team flips when it travels', () => {
  const homeEvent = {
    home_team: 'Seattle Seahawks', away_team: 'New England Patriots',
    bookmakers: [{ key: 'dk', title: 'DK', last_update: 'T', markets: [
      { key: 'h2h', outcomes: [
        { name: 'Seattle Seahawks', price: -180, point: null },
        { name: 'New England Patriots', price: 150, point: null },
      ] },
    ] }],
  };
  const awayEvent = {
    home_team: 'New England Patriots', away_team: 'Seattle Seahawks',
    bookmakers: homeEvent.bookmakers,
  };

  const sea1 = normalizeEvent(homeEvent).find(r => r.team === 'SEA');
  const sea2 = normalizeEvent(awayEvent).find(r => r.team === 'SEA');
  assert.equal(sea1.is_home, true);
  assert.equal(sea2.is_home, false);
  // Same canonical side string, opposite venue attribution.
  assert.equal(sea1.side, sea2.side);
});

test('an outcome naming a team not in the event is rejected, not mis-assigned', () => {
  const row = normalizeOutcome({
    event: { home_team: 'Seattle Seahawks', away_team: 'New England Patriots' },
    bookmaker: { key: 'dk' }, marketKey: 'h2h',
    outcome: { name: 'Green Bay Packers', price: -110, point: null },
  });
  assert.equal(row, null);
});

/* ------------------------------------------------------------------------
 * Canonical side strings
 * --------------------------------------------------------------------- */

test('canonical sides are formatted per market', () => {
  assert.equal(canonicalSide({ market: 'moneyline', teamCode: 'GB' }), 'GB ML');
  assert.equal(canonicalSide({ market: 'spread', teamCode: 'MIN', point: -2.5 }), 'MIN -2.5');
  assert.equal(canonicalSide({ market: 'spread', teamCode: 'MIN', point: 2.5 }), 'MIN +2.5');
  assert.equal(canonicalSide({ market: 'total', overUnder: 'OVER', point: 44.5 }), 'OVER 44.5');
  assert.equal(canonicalSide({ market: 'total', overUnder: 'UNDER', point: 44.5 }), 'UNDER 44.5');
});

test('a spread without a point cannot produce a side', () => {
  assert.equal(canonicalSide({ market: 'spread', teamCode: 'MIN', point: null }), null);
  assert.equal(canonicalSide({ market: 'total', overUnder: 'OVER', point: null }), null);
  assert.equal(canonicalSide({ market: 'moneyline', teamCode: null }), null);
});

test('spread sign is preserved from the provider point, per team', () => {
  const event = fixture.events[0];
  const rows = normalizeEvent(event).filter(r => r.market === 'spread');
  const homeCode = teamCodeFromName(event.home_team);
  const awayCode = teamCodeFromName(event.away_team);
  const home = rows.find(r => r.team === homeCode);
  const away = rows.find(r => r.team === awayCode);
  assert.ok(home && away);
  // Exactly one side is the favourite; the two points are mirror images.
  assert.ok(Math.abs(home.line + away.line) < 1e-9, `${home.line} / ${away.line}`);
  assert.ok(home.side.includes(homeCode));
  assert.ok(away.side.includes(awayCode));
});

/* ------------------------------------------------------------------------
 * Over / Under
 * --------------------------------------------------------------------- */

test('OVER and UNDER are recognised and carry no team identity', () => {
  assert.equal(isOverUnder('Over'), 'OVER');
  assert.equal(isOverUnder('under'), 'UNDER');
  assert.equal(isOverUnder('Seattle Seahawks'), null);

  const rows = normalizeEvent(fixture.events[0]).filter(r => r.market === 'total');
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.equal(r.team, null);
    assert.equal(r.is_home, null);
    assert.ok(['OVER', 'UNDER'].includes(r.over_under));
    assert.ok(Number.isFinite(r.line));
  }
  assert.ok(rows.some(r => r.over_under === 'OVER'));
  assert.ok(rows.some(r => r.over_under === 'UNDER'));
});

/* ------------------------------------------------------------------------
 * Preserved provenance
 * --------------------------------------------------------------------- */

test('every required provenance field survives normalization', () => {
  const row = normalizeEvent(fixture.events[0])[0];
  for (const field of [
    'provider_outcome_name', 'side', 'line', 'price', 'book', 'captured_at',
    'market', 'provider_market', 'home_team', 'away_team',
  ]) {
    assert.ok(field in row, `missing ${field}`);
  }
  assert.ok(row.provider_outcome_name.length > 0);
  assert.ok(row.book.length > 0);
});

test('a zero or non-numeric price is rejected rather than stored', () => {
  const base = {
    event: { home_team: 'Seattle Seahawks', away_team: 'New England Patriots' },
    bookmaker: { key: 'dk' }, marketKey: 'h2h',
  };
  assert.equal(normalizeOutcome({ ...base, outcome: { name: 'Seattle Seahawks', price: 0 } }), null);
  assert.equal(normalizeOutcome({ ...base, outcome: { name: 'Seattle Seahawks', price: 'x' } }), null);
});

/* ------------------------------------------------------------------------
 * Consensus + opposite pairing
 * --------------------------------------------------------------------- */

test('consensus keeps the book column honest', () => {
  const rows = consensusByside(normalizeEvent(fixture.events[0]));
  for (const r of rows) {
    if (r.book_count > 1) assert.match(r.book, /^consensus:\d+$/);
    else assert.ok(!/^consensus/.test(r.book));
  }
});

test('consensus never merges two different sides together', () => {
  const rows = consensusByside(normalizeEvent(fixture.events[0]));
  const keys = rows.map(r => `${r.market}|${r.side}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('opposites pair correctly for all three markets', () => {
  const rows = pairOpposites(consensusByside(normalizeEvent(fixture.events[0])));

  const ml = rows.filter(r => r.market === 'moneyline');
  for (const r of ml) assert.ok(Number.isFinite(r.opposite_price), `${r.side} unpaired`);

  const totals = rows.filter(r => r.market === 'total');
  for (const r of totals) assert.ok(Number.isFinite(r.opposite_price), `${r.side} unpaired`);

  const spreads = rows.filter(r => r.market === 'spread');
  for (const r of spreads) assert.ok(Number.isFinite(r.opposite_price), `${r.side} unpaired`);
});

test('a one-sided market yields a null opposite and must not be de-vigged', () => {
  const rows = pairOpposites([{ market: 'total', side: 'OVER 44.5', over_under: 'OVER', price: -110, line: 44.5 }]);
  assert.equal(rows[0].opposite_price, null);
});

test('both real fixture events normalize without losing a single side', () => {
  for (const event of fixture.events) {
    const rows = consensusByside(normalizeEvent(event));
    const markets = new Set(rows.map(r => r.market));
    assert.equal(markets.size, 3, `${event.away_team} @ ${event.home_team}`);
    for (const market of ['moneyline', 'spread', 'total']) {
      const sides = rows.filter(r => r.market === market);
      assert.equal(sides.length, 2, `${market} should have exactly two sides`);
    }
  }
});
