import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePropGrade, propClvPoints, passingYards,
} from '../workers/nfl-prop-picks-grader/src/index.js';
import { exactClosingQuote } from '../workers/nfl-prop-picks-orchestrator/src/index.js';

const basePick = {
  id: '00000000-0000-0000-0000-000000000001',
  status: 'open',
  side: 'OVER',
  market_line: 250.5,
  market_price: -110,
  stake_units: 1,
  model_prob: 0.60,
  market_prob: 0.50,
};

test('passing yards extracts the labeled YDS field for the exact player', () => {
  const stats = [{
    groups: [{
      name: 'passing',
      labels: ['C/ATT', 'YDS', 'TD'],
      athletes: [
        { athlete: { name: 'Drake Maye' }, did_not_play: false, stats: ['23/31', '287', '2'] },
        { athlete: { name: 'Other QB' }, did_not_play: false, stats: ['10/15', '104', '0'] },
      ],
    }],
  }];
  assert.deepEqual(passingYards(stats, 'drake maye'), { did_not_play: false, yards: 287 });
});

test('passing yards preserves explicit did-not-play as a void signal', () => {
  const stats = [{ groups: [{ name: 'passing', labels: ['YDS'], athletes: [
    { athlete: { name: 'Drake Maye' }, did_not_play: true, stats: ['0'] },
  ] }] }];
  assert.deepEqual(passingYards(stats, 'drake maye'), { did_not_play: true, yards: null });
});

test('missing player never becomes zero passing yards', () => {
  const stats = [{ groups: [{ name: 'passing', labels: ['YDS'], athletes: [
    { athlete: { name: 'Other QB' }, did_not_play: false, stats: ['0'] },
  ] }] }];
  assert.equal(passingYards(stats, 'drake maye'), null);
});

test('OVER settles from authoritative final value and actual issue price', () => {
  const grade = computePropGrade(basePick, { final_value: 287, source: 'fixture' }, null);
  assert.equal(grade.result, 'win');
  assert.ok(Math.abs(grade.units_delta - 0.9091) < 0.0001);
  assert.equal(grade.final_value, 287);
});

test('UNDER settles correctly', () => {
  const pick = { ...basePick, side: 'UNDER' };
  const grade = computePropGrade(pick, { final_value: 240, source: 'fixture' }, null);
  assert.equal(grade.result, 'win');
});

test('exactly equal final value is a push', () => {
  const pick = { ...basePick, market_line: 250 };
  const grade = computePropGrade(pick, { final_value: 250, source: 'fixture' }, null);
  assert.equal(grade.result, 'push');
  assert.equal(grade.units_delta, 0);
});

test('killed prop is void for P&L while preserving available CLV', () => {
  const pick = { ...basePick, status: 'killed' };
  const grade = computePropGrade(
    pick,
    { final_value: 287, source: 'fixture' },
    { line: 255.5, price: -115, opposite_price: -105 },
  );
  assert.equal(grade.result, 'void');
  assert.equal(grade.units_delta, 0);
  assert.equal(grade.brier, null);
  assert.equal(grade.clv_points, 5);
  assert.notEqual(grade.clv_prob, null);
});

test('prop CLV direction is positive when market moves toward our side', () => {
  assert.equal(propClvPoints('OVER', 250.5, 257.5), 7);
  assert.equal(propClvPoints('UNDER', 250.5, 243.5), 7);
  assert.equal(propClvPoints('OVER', 250.5, 245.5), -5);
});

test('closing tape requires same book, side and exact current line for opposite quote', () => {
  const rows = [
    { book: 'Book A', side: 'OVER', current: { point: 255.5, price: -115, captured_at: '2026-09-10T00:00:00Z' } },
    { book: 'Book A', side: 'UNDER', current: { point: 255.5, price: -105, captured_at: '2026-09-10T00:00:00Z' } },
    { book: 'Book B', side: 'UNDER', current: { point: 255.5, price: -120, captured_at: '2026-09-10T00:00:00Z' } },
  ];
  assert.deepEqual(exactClosingQuote(rows, { book: 'Book A', side: 'OVER' }), {
    point: 255.5,
    price: -115,
    opposite_price: -105,
    observed_at: '2026-09-10T00:00:00Z',
  });
});

test('closing tape refuses mismatched two-way lines', () => {
  const rows = [
    { book: 'Book A', side: 'OVER', current: { point: 255.5, price: -115, captured_at: '2026-09-10T00:00:00Z' } },
    { book: 'Book A', side: 'UNDER', current: { point: 256.5, price: -105, captured_at: '2026-09-10T00:00:00Z' } },
  ];
  assert.equal(exactClosingQuote(rows, { book: 'Book A', side: 'OVER' }), null);
});
