/* QB DNA v2 — DNA signals, condition groups and the prop lab.
 * node --test research/qbdna/qbdna-v2.test.mjs
 *
 * The signal classifier is the piece most able to mislead: it turns a matrix
 * into a headline, and a headline built on three games is exactly the
 * mythology this product exists to avoid. Most of what follows guards that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from './call.mjs';
import { dataset, gamesFor, conditionProfile, dnaSignals, splitRows,
         CONDITIONS, CONDITION_GROUPS, SIGNAL_TIERS } from '../../api/_qbdna/engine.js';
import { MARKET_UNAVAILABLE } from '../../api/_qbdna/markets.js';

const MAHOMES = '00-0033873', ALLEN = '00-0034857';
const profileFor = id => conditionProfile(gamesFor(id), 'py', 1);

/* ===================== CONDITION GROUPS ================================== */

test('every condition belongs to a declared group', () => {
  for (const [key, c] of Object.entries(CONDITIONS)) {
    assert.ok(c.group, `${key} has no group`);
    assert.ok(CONDITION_GROUPS[c.group], `${key} has unknown group ${c.group}`);
  }
});

test('temperature bands are exclusive and cover every resolved outdoor game', () => {
  const rows = gamesFor(MAHOMES);
  const bands = ['arctic_sub20', 'freezing_20_32', 'cold_33_50', 'mild_51_70', 'warm_70_plus'];
  const seen = new Map();
  let total = 0;
  for (const b of bands) {
    for (const r of splitRows(rows, b).rows) {
      assert.equal(seen.has(r.g), false, `${r.g} counted in two temperature bands`);
      seen.set(r.g, b);
      total++;
    }
  }
  // the bands must account for exactly the outdoor games with a resolved reading
  const resolvable = rows.filter(r => r.ind !== 1 && r.ws === 'ok' && typeof r.tf === 'number');
  assert.equal(total, resolvable.length);
});

test('below_freezing is a rollup of the two coldest bands, and is marked as one', () => {
  assert.equal(CONDITIONS.below_freezing.rollup, true);
  const rows = gamesFor(MAHOMES);
  const roll = splitRows(rows, 'below_freezing').rows.length;
  const fine = splitRows(rows, 'arctic_sub20').rows.length
             + splitRows(rows, 'freezing_20_32').rows.length;
  assert.equal(roll, fine);
});

test('a rollup band never appears as its own signal', () => {
  const g = dnaSignals(profileFor(MAHOMES));
  const all = [...g.strengths, ...g.watchouts, ...g.signals, ...g.insufficient];
  assert.equal(all.some(x => x.key === 'below_freezing'), false);
});

/* ===================== WIN / LOSS ======================================== */

test('every populated condition carries a record and a win rate with its N', () => {
  const p = profileFor(MAHOMES);
  for (const [key, c] of Object.entries(p.conditions)) {
    if (!c.available || !c.games) continue;
    assert.equal(typeof c.games, 'number', key);
    assert.ok(c.win_pct, `${key} has no win_pct`);
    // a rate is never bare: numerator and denominator always travel with it
    assert.equal(typeof c.win_pct.numerator, 'number', `${key} numerator`);
    assert.equal(typeof c.win_pct.denominator, 'number', `${key} denominator`);
    if (c.win_pct.denominator > 0) {
      assert.equal(c.win_pct.numerator, c.wins);
      assert.equal(c.wins + c.losses, c.games_with_result);
      assert.match(c.record, /^\d+-\d+$/);
    } else {
      assert.equal(c.win_pct.pct, null, `${key} must not report 0% with no decided games`);
    }
  }
});

test('a condition with no decided games reports no win rate rather than zero', () => {
  const p = profileFor(MAHOMES);
  for (const c of Object.values(p.conditions)) {
    if (!c.available || !c.games) continue;
    if (c.games_with_result === 0) assert.equal(c.win_pct.pct, null);
  }
});

/* ===================== SIGNAL SAMPLE DISCIPLINE ========================== */

test('nothing under the qualifying N is ever called a strength or a watchout', () => {
  for (const id of [MAHOMES, ALLEN]) {
    const g = dnaSignals(profileFor(id));
    for (const x of [...g.strengths, ...g.watchouts]) {
      assert.ok(x.games >= SIGNAL_TIERS.qualifying_n,
        `${x.label} labelled ${x.tier} on only ${x.games} games`);
    }
  }
});

test('a signal sits between the two thresholds and carries its sample label', () => {
  const g = dnaSignals(profileFor(MAHOMES));
  for (const x of g.signals) {
    assert.ok(x.games >= SIGNAL_TIERS.signal_n && x.games < SIGNAL_TIERS.qualifying_n,
      `${x.label} has ${x.games} games`);
    assert.equal(x.sample_label, 'SMALL SAMPLE');
  }
});

test('an extreme movement on a tiny sample is refused promotion', () => {
  const g = dnaSignals(profileFor(MAHOMES));
  // the largest movements in this dataset sit on 1-4 games; they must be
  // reported as insufficient no matter how dramatic the number is
  const biggest = [...g.strengths, ...g.watchouts, ...g.signals, ...g.insufficient]
    .sort((a, b) => Math.abs(b.baseline_delta_pct) - Math.abs(a.baseline_delta_pct))[0];
  assert.ok(biggest);
  if (biggest.games < SIGNAL_TIERS.signal_n) {
    assert.equal(biggest.tier, 'INSUFFICIENT');
    assert.equal(g.strengths.includes(biggest), false);
    assert.equal(g.watchouts.includes(biggest), false);
  }
});

test('insufficient rows are reported, not silently dropped', () => {
  const g = dnaSignals(profileFor(MAHOMES));
  for (const x of g.insufficient) {
    assert.ok(x.games < SIGNAL_TIERS.signal_n || Math.abs(x.baseline_delta_pct) >= SIGNAL_TIERS.min_move_pct);
    assert.ok(x.sample_label);
    assert.match(x.statement, /N=\d+/);
  }
});

test('a movement smaller than the noise floor is neutral, not a signal', () => {
  const g = dnaSignals(profileFor(MAHOMES));
  for (const x of [...g.strengths, ...g.watchouts, ...g.signals]) {
    assert.ok(Math.abs(x.baseline_delta_pct) >= SIGNAL_TIERS.min_move_pct,
      `${x.label} promoted on a ${x.baseline_delta_pct}% move`);
  }
  assert.equal(typeof g.neutral_count, 'number');
});

test('every signal statement carries its N and its sample label', () => {
  for (const id of [MAHOMES, ALLEN]) {
    const g = dnaSignals(profileFor(id));
    for (const x of [...g.strengths, ...g.watchouts, ...g.signals, ...g.insufficient]) {
      assert.match(x.statement, /N=\d+/);
      assert.match(x.statement, /SAMPLE/);
      assert.match(x.statement, /vs own baseline/);
    }
  }
});

test('signals are ranked by size of movement', () => {
  const g = dnaSignals(profileFor(MAHOMES));
  for (const list of [g.strengths, g.watchouts, g.signals]) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(Math.abs(list[i - 1].baseline_delta_pct) >= Math.abs(list[i].baseline_delta_pct));
    }
  }
});

test('the API exposes the signals and the policy that produced them', async () => {
  const r = await call('qb-dna', `player_id=${MAHOMES}`);
  assert.equal(r.status, 200);
  const g = r.body.dna_signals;
  assert.ok(g.policy.qualifying_n >= 10);
  assert.match(g.policy.rule, /strength or a watchout/);
  assert.ok(r.body.condition_groups);
  assert.equal(g.baseline_n, r.body.baseline.games);
});

/* ===================== FORM SERIES ======================================= */

test('the form series is computed by the API, ordered, and never longer than history', async () => {
  const r = await call('qb-dna', `player_id=${MAHOMES}`);
  const fs = r.body.form_series;
  assert.ok(fs.games.length <= 20);
  assert.equal(fs.games.length, Math.min(20, gamesFor(MAHOMES).length));
  for (let i = 1; i < fs.games.length; i++) {
    assert.ok(fs.games[i].date >= fs.games[i - 1].date, 'series must run oldest to newest');
  }
  assert.equal(fs.mean, r.body.baseline.passing_yards.mean);
  assert.equal(fs.median, r.body.baseline.passing_yards.median);
});

/* ===================== PROP LAB ========================================== */

test('the prop lab refuses to work without an event', async () => {
  const r = await call('prop-lab', `player_id=${MAHOMES}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'event_id_required');
});

test('LIVE: every supported market gets a card, offered or not', async () => {
  let slate;
  try { slate = await call('game-context', ''); } catch { return; }
  if (slate.status !== 200) return;
  const g = slate.body.games.find(x => x.market_event_id);
  if (!g) return;
  const r = await call('prop-lab', `player_id=${MAHOMES}&event_id=${g.market_event_id}`);
  if (r.status !== 200 || !r.body.history_available) return;
  assert.equal(r.body.markets.length, 5, 'all five supported markets must be represented');
  for (const c of r.body.markets) {
    if (c.available) {
      assert.ok(Number.isFinite(c.line));
      assert.equal(c.line_source.source, 'current_market');
      // every window is either a real count or an explicit unavailable
      for (const w of Object.values(c.windows)) {
        if (w.available) {
          assert.equal(w.over + w.under + w.push, w.total);
          assert.ok(w.sample_label);
        } else {
          assert.ok(w.reason, 'an unavailable window must say why');
          assert.equal(w.over_pct, undefined);
        }
      }
      assert.ok(c.distribution.length > 0);
      for (const d of c.distribution) {
        assert.ok(['OVER', 'UNDER', 'PUSH'].includes(d.outcome));
        assert.equal(d.outcome, d.value > c.line ? 'OVER' : d.value < c.line ? 'UNDER' : 'PUSH');
      }
    } else {
      // a market nobody offers is a stated absence, never a card of zeros
      assert.equal(c.state, MARKET_UNAVAILABLE);
      assert.equal(c.line, undefined);
      assert.equal(c.windows, undefined);
      assert.ok(c.reason);
    }
  }
});

test('LIVE: the prop lab says clear rate, never chance', async () => {
  let slate;
  try { slate = await call('game-context', ''); } catch { return; }
  if (slate.status !== 200) return;
  const g = slate.body.games.find(x => x.market_event_id);
  if (!g) return;
  const r = await call('prop-lab', `player_id=${MAHOMES}&event_id=${g.market_event_id}`);
  if (r.status !== 200 || !r.body.history_available) return;
  assert.equal(r.body.disclosure.wording, 'Historical clear rate');
  assert.match(r.body.disclosure.caveat, /not a probability/i);
  assert.equal(/chance/i.test(JSON.stringify(r.body.disclosure)), false);
});

test('a no-history quarterback gets no prop cards at all', async () => {
  const rookie = dataset().players.find(p => p.active_2026 && !gamesFor(p.gsis_id).length);
  const r = await call('prop-lab', `player_id=${rookie.gsis_id}&event_id=anything`);
  assert.equal(r.status, 200);
  assert.equal(r.body.history_available, false);
  assert.equal(r.body.sample_state, 'NFL SAMPLE UNAVAILABLE');
  assert.deepEqual(r.body.markets, []);
});
