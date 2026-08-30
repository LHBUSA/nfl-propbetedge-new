import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalCdf, modelSideProbability, pairCurrentQuotes, evaluatePropQuote,
  issuancePhase, kellyUnits, playerKey,
} from '../workers/nfl-prop-picks-shared/prop-math.mjs';

const selector = {
  config: {
    min_edge: 0.04,
    min_ev_pct: 5,
    min_books: 4,
    confidence_a_edge: 0.075,
    confidence_b_edge: 0.055,
    stake_floor_units: 0.5,
    stake_cap_units: 2,
    kelly_fraction: 0.25,
    early_bird_min_hours: 12,
    locked_max_hours: 4,
  },
};

test('normal CDF is centered at 0.5', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
});

test('fair line is a 50/50 threshold under the supplied normal distribution', () => {
  const over = modelSideProbability({ fairLine: 250, predictiveSd: 50, line: 250, side: 'OVER' });
  const under = modelSideProbability({ fairLine: 250, predictiveSd: 50, line: 250, side: 'UNDER' });
  assert.ok(Math.abs(over - 0.5) < 1e-7);
  assert.ok(Math.abs(under - 0.5) < 1e-7);
});

test('lower passing line increases model Over probability', () => {
  const low = modelSideProbability({ fairLine: 250, predictiveSd: 50, line: 220, side: 'OVER' });
  const high = modelSideProbability({ fairLine: 250, predictiveSd: 50, line: 270, side: 'OVER' });
  assert.ok(low > 0.5);
  assert.ok(low > high);
});

test('quote pairing requires exact same player, book and line', () => {
  const rows = [
    { player: 'Drake Maye', book: 'Book A', side: 'OVER', current: { point: 225.5, price: -110 } },
    { player: 'Drake Maye', book: 'Book A', side: 'UNDER', current: { point: 225.5, price: -110 } },
    { player: 'Drake Maye', book: 'Book B', side: 'OVER', current: { point: 226.5, price: -105 } },
    { player: 'Drake Maye', book: 'Book B', side: 'UNDER', current: { point: 227.5, price: -115 } },
  ];
  const paired = pairCurrentQuotes(rows);
  assert.equal(paired.length, 2);
  assert.equal(paired[0].book, 'Book A');
  assert.equal(paired[0].point, 225.5);
  assert.ok(paired.every(row => row.opposite_price === -110));
});

test('selector qualifies a sufficiently mispriced executable Over', () => {
  const kickoff = new Date(Date.now() + 24 * 3600000).toISOString();
  const projection = { player: 'Drake Maye', fair_line: 260, predictive_sd: 50, available: true };
  const quote = {
    player: 'Drake Maye', player_key: playerKey('Drake Maye'), book: 'Book A',
    side: 'OVER', point: 225.5, price: -105, opposite_price: -115,
  };
  const out = evaluatePropQuote({ projection, quote, bookCount: 6, selector, kickoffTs: kickoff });
  assert.equal(out.available, true);
  assert.equal(out.phase, 'early_bird');
  assert.equal(out.qualifies, true);
  assert.ok(out.edge_pct >= 0.04);
  assert.ok(out.ev_pct >= 5);
  assert.ok(out.stake_units >= 0.5 && out.stake_units <= 2);
});

test('selector fails closed when book depth is below the configured floor', () => {
  const kickoff = new Date(Date.now() + 24 * 3600000).toISOString();
  const out = evaluatePropQuote({
    projection: { player: 'Drake Maye', fair_line: 280, predictive_sd: 45, available: true },
    quote: { player: 'Drake Maye', player_key: 'drake maye', book: 'A', side: 'OVER', point: 225.5, price: +100, opposite_price: -120 },
    bookCount: 2, selector, kickoffTs: kickoff,
  });
  assert.equal(out.qualifies, false);
});

test('selector makes no issuance decision in the intentional transition window', () => {
  const phase = issuancePhase(new Date(Date.now() + 8 * 3600000).toISOString(), Date.now(), selector.config);
  assert.equal(phase.phase, null);
});

test('locked phase begins inside four hours', () => {
  const phase = issuancePhase(new Date(Date.now() + 3 * 3600000).toISOString(), Date.now(), selector.config);
  assert.equal(phase.phase, 'locked');
});

test('quarter Kelly sizing respects the 2u cap', () => {
  assert.equal(kellyUnits(0.8, -110, selector.config), 2);
});

test('player identity normalization is accent and punctuation safe', () => {
  assert.equal(playerKey("D'Andre Swift"), 'd andre swift');
  assert.equal(playerKey('José Núñez'), 'jose nunez');
});
