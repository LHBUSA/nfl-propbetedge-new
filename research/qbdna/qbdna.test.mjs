/* QB DNA API + identity invariant tests.
 * node --test research/qbdna/qbdna.test.mjs
 *
 * The tests that matter most are the identity ones. If an ESPN live athlete id
 * ever resolves to the wrong historical quarterback, every number downstream is
 * wrong while still looking perfectly plausible — which is the worst failure
 * this product can have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from './call.mjs';
import { dataset, resolvePlayer, gamesFor, rate, ratio, baseline, splitRows,
         propThreshold, SAMPLE, CONDITIONS } from '../../api/_qbdna/engine.js';
import { gate, gateReport, STATUS, THRESHOLDS } from '../../api/_qbdna/gating.js';

const MAHOMES = '00-0033873', ALLEN = '00-0034857';
const MAHOMES_ESPN = '3139477', ALLEN_ESPN = '3918298';

/* ===================== IDENTITY INVARIANT ================================= */

test('a live ESPN athlete id resolves deterministically to a GSIS identity', () => {
  const r = resolvePlayer({ espn_id: MAHOMES_ESPN });
  assert.equal(r.player.gsis_id, MAHOMES);
  assert.equal(r.matched_by, 'espn_id');
});

test('ESPN id resolution is stable across repeated calls', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(resolvePlayer({ espn_id: ALLEN_ESPN }).player.gsis_id);
  assert.deepEqual([...seen], [ALLEN]);
});

test('every ESPN id in the dataset maps to exactly one GSIS id', () => {
  const D = dataset();
  const byEspn = new Map();
  for (const p of D.players) {
    if (!p.espn_id) continue;
    const k = String(p.espn_id);
    assert.equal(byEspn.has(k), false, `ESPN id ${k} claimed by two GSIS ids`);
    byEspn.set(k, p.gsis_id);
  }
  assert.ok(byEspn.size > 0);
});

test('a stable id match is never overridden by a name', () => {
  // ask for Mahomes' ESPN id while passing a DIFFERENT name; the id must win
  const r = resolvePlayer({ espn_id: MAHOMES_ESPN, name: 'Josh Allen' });
  assert.equal(r.player.gsis_id, MAHOMES);
  assert.equal(r.matched_by, 'espn_id');
});

test('a GSIS id outranks an ESPN id when both are supplied', () => {
  const r = resolvePlayer({ player_id: ALLEN, espn_id: MAHOMES_ESPN });
  assert.equal(r.player.gsis_id, ALLEN);
  assert.equal(r.matched_by, 'gsis_id');
});

test('an unknown stable id fails closed rather than falling back to a name', () => {
  const r = resolvePlayer({ espn_id: '999999999', name: 'Patrick Mahomes' });
  assert.equal(r.player, null);
  assert.match(r.reason, /stable id/);
});

test('name matching is exact only, never fuzzy', () => {
  assert.equal(resolvePlayer({ name: 'Patrick Mahomes' }).player.gsis_id, MAHOMES);
  for (const near of ['Pat Mahomes', 'P. Mahomes', 'Mahomes', 'patrick mahome']) {
    assert.equal(resolvePlayer({ name: near }).player, null, `"${near}" must not match`);
  }
  // case and surrounding space are normalisation, not fuzziness
  assert.equal(resolvePlayer({ name: '  patrick MAHOMES ' }).player.gsis_id, MAHOMES);
});

test('an ambiguous name resolves to nothing and names its candidates', () => {
  const D = dataset();
  const counts = new Map();
  for (const p of D.players) {
    const k = p.display_name.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const dupe = [...counts].find(([, n]) => n > 1);
  if (!dupe) return; // no duplicate names in this snapshot
  const r = resolvePlayer({ name: dupe[0] });
  assert.equal(r.player, null);
  assert.equal(r.reason, 'ambiguous name');
  assert.ok(r.candidates.length > 1);
});

test('the live to historical join holds for the ESPN ids in the dataset', async () => {
  const D = dataset();
  const withEspn = D.players.filter(p => p.espn_id);
  let checked = 0;
  for (const p of withEspn) {
    const viaEspn = await call('qb-dna', `espn_id=${p.espn_id}`);
    assert.equal(viaEspn.status, 200);
    assert.equal(viaEspn.body.player.gsis_id, p.gsis_id);
    if (++checked >= 25) break;
  }
  assert.ok(checked >= 10, 'expected a meaningful number of crosswalked players');
});

/* ===================== TRUTH RULES ======================================== */

test('a zero denominator is never reported as 0%', () => {
  const r = rate(0, 0);
  assert.equal(r.pct, null);
  assert.equal(r.denominator, 0);
  assert.equal(r.note, 'no denominator');
  assert.equal(ratio(5, 0, 'yards per attempt').value, null);
});

test('every rate carries numerator and denominator', () => {
  const b = baseline(gamesFor(MAHOMES));
  for (const k of ['completion_pct', 'td_rate', 'int_rate', 'sack_rate']) {
    assert.equal(typeof b[k].numerator, 'number', `${k} numerator`);
    assert.equal(typeof b[k].denominator, 'number', `${k} denominator`);
  }
  assert.equal(b.ypa.unit, 'yards per attempt');
  assert.ok(b.ypa.value > 4 && b.ypa.value < 12, `ypa ${b.ypa.value} must be in yards, not percent`);
});

test('sample labels are exactly the documented size bands', () => {
  assert.equal(SAMPLE(20), 'STRONG SAMPLE');
  assert.equal(SAMPLE(19), 'MODERATE SAMPLE');
  assert.equal(SAMPLE(10), 'MODERATE SAMPLE');
  assert.equal(SAMPLE(9), 'SMALL SAMPLE');
  assert.equal(SAMPLE(5), 'SMALL SAMPLE');
  assert.equal(SAMPLE(4), 'VERY SMALL SAMPLE');
  assert.equal(SAMPLE(0), 'VERY SMALL SAMPLE');
});

test('a roofed game can never enter an outdoor weather split', () => {
  const D = dataset();
  const weatherKeys = Object.keys(CONDITIONS).filter(k => CONDITIONS[k].weather);
  for (const p of D.players.slice(0, 20)) {
    const rows = gamesFor(p.gsis_id);
    for (const k of weatherKeys) {
      for (const r of splitRows(rows, k).rows) {
        assert.notEqual(r.ind, 1, `${p.display_name} ${k} contains an indoor game ${r.g}`);
        assert.equal(r.ws, 'ok', `${p.display_name} ${k} contains an unresolved environment ${r.g}`);
        assert.equal(typeof r.tf, 'number');
      }
    }
  }
});

test('an unresolved environment is excluded, and the exclusion is disclosed', () => {
  const rows = gamesFor(MAHOMES);
  const s = splitRows(rows, 'below_freezing');
  assert.ok(s.coverage);
  assert.equal(typeof s.coverage.outdoor_games, 'number');
  assert.ok(s.coverage.environment_resolved <= s.coverage.outdoor_games);
});

test('a split with no games reports unavailable, not zero', async () => {
  // a quarterback with no snow games at all
  const D = dataset();
  const target = D.players.find(p => splitRows(gamesFor(p.gsis_id), 'snow').rows.length === 0);
  assert.ok(target, 'expected at least one QB with no snow game');
  const r = await call('qb-dna', `player_id=${target.gsis_id}`);
  const snow = r.body.conditions.snow;
  assert.equal(snow.games, 0);
  assert.notEqual(snow.passing_yards_avg, 0);
  assert.equal(snow.passing_yards_avg, undefined);
});

test('dome and outdoor splits are disjoint and cover every game', () => {
  const rows = gamesFor(MAHOMES);
  const dome = new Set(splitRows(rows, 'dome').rows.map(r => r.g));
  const out = new Set(splitRows(rows, 'outdoor').rows.map(r => r.g));
  for (const g of dome) assert.equal(out.has(g), false, `${g} counted as both`);
  assert.equal(dome.size + out.size, rows.length);
});

test('home and road splits partition the games exactly', () => {
  const rows = gamesFor(ALLEN);
  const h = splitRows(rows, 'home').rows.length, a = splitRows(rows, 'road').rows.length;
  assert.equal(h + a, rows.length);
});

/* ===================== DETERMINISM ======================================== */

test('the same request returns byte-identical output', async () => {
  const a = await call('qb-dna', `player_id=${MAHOMES}`);
  const b = await call('qb-dna', `player_id=${MAHOMES}`);
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
});

test('resolving by GSIS, by ESPN id and by exact name give the same body', async () => {
  const byGsis = await call('qb-dna', `player_id=${MAHOMES}`);
  const byEspn = await call('qb-dna', `espn_id=${MAHOMES_ESPN}`);
  const byName = await call('qb-dna', 'name=Patrick%20Mahomes');
  const strip = b => { const c = structuredClone(b); delete c.player.matched_by; return JSON.stringify(c); };
  assert.equal(strip(byGsis.body), strip(byEspn.body));
  assert.equal(strip(byGsis.body), strip(byName.body));
});

/* ===================== /api/qb-dna ======================================== */

test('qb-dna returns a coherent baseline for Mahomes', async () => {
  const r = await call('qb-dna', `player_id=${MAHOMES}`);
  assert.equal(r.status, 200);
  const b = r.body.baseline;
  assert.equal(b.games, gamesFor(MAHOMES).length);
  assert.equal(b.wins + b.losses, b.games_with_result);
  assert.equal(b.completion_pct.numerator, b.completions);
  assert.equal(b.completion_pct.denominator, b.attempts);
  assert.ok(b.completion_pct.pct > 55 && b.completion_pct.pct < 75);
  assert.equal(b.sample_label, 'STRONG SAMPLE');
});

test('an unknown player is a 404, never an empty success', async () => {
  const r = await call('qb-dna', 'player_id=00-9999999');
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test('an unsupported metric is refused with the supported list', async () => {
  const r = await call('qb-dna', `player_id=${MAHOMES}&metric=rushing_yards`);
  assert.equal(r.status, 400);
  assert.ok(r.body.supported.includes('passing_yards'));
});

test('every response carries provenance, sources and the sample scale', async () => {
  for (const [route, qs] of [
    ['qb-dna', `player_id=${MAHOMES}`],
    ['prop-history', `player_id=${MAHOMES}&market=passing_yards&line=274.5`],
    ['compare', `player_a=${MAHOMES}&player_b=${ALLEN}`]
  ]) {
    const r = await call(route, qs);
    assert.equal(r.status, 200, route);
    assert.ok(r.body.provenance.sources.length, `${route} sources`);
    assert.ok(r.body.provenance.field_availability_by_season, `${route} availability`);
    assert.ok(r.body.provenance.notes.some(n => /SIZE ONLY/.test(n)), `${route} sample note`);
  }
});

/* ===================== /api/qb-dna/prop-history =========================== */

test('a threshold splits over, under and push exactly', async () => {
  const r = await call('prop-history', `player_id=${MAHOMES}&market=passing_yards&line=274.5`);
  const f = r.body.full_history;
  assert.equal(f.over + f.under + f.push, f.total);
  assert.equal(f.over_pct, +(100 * f.over / f.total).toFixed(1));
  assert.match(f.statement, new RegExp(`^${f.over}/${f.total} over 274.5 = `));
});

test('an integer line produces real pushes and they are not counted as overs', async () => {
  const r = await call('prop-history', `player_id=${MAHOMES}&market=passing_touchdowns&line=2`);
  const f = r.body.full_history;
  assert.equal(f.over + f.under + f.push, f.total);
  assert.ok(f.push > 0, 'a whole-number TD line must produce pushes');
  const log = r.body.game_log.filter(g => g.value === 2);
  for (const g of log) assert.equal(g.outcome, 'PUSH');
});

test('a line is required', async () => {
  const r = await call('prop-history', `player_id=${MAHOMES}&market=passing_yards`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'line_required');
});

test('a condition window with no games is unavailable, not 0%', async () => {
  const D = dataset();
  const target = D.players.find(p => splitRows(gamesFor(p.gsis_id), 'snow').rows.length === 0);
  const r = await call('prop-history',
    `player_id=${target.gsis_id}&market=passing_yards&line=250&condition=snow`);
  assert.equal(r.body.windowed.available, false);
  assert.equal(r.body.windowed.over_pct, undefined);
});

test('the windowed count never exceeds the full history', async () => {
  for (const c of ['below_freezing', 'road', 'primetime', 'snow']) {
    const r = await call('prop-history',
      `player_id=${MAHOMES}&market=passing_yards&line=250&condition=${c}`);
    if (!r.body.windowed.available) continue;
    assert.ok(r.body.windowed.total <= r.body.full_history.total, c);
  }
});

test('an unknown condition is refused', async () => {
  const r = await call('prop-history',
    `player_id=${MAHOMES}&market=passing_yards&line=250&condition=full_moon`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown_condition');
});

/* ===================== /api/qb-dna/compare ================================ */

test('head-to-head is a real intersection of game ids', async () => {
  const r = await call('compare', `player_a=${MAHOMES}&player_b=${ALLEN}`);
  assert.equal(r.body.mode, 'players');
  const h = r.body.head_to_head;
  assert.equal(h.available, true);
  const idsA = new Set(gamesFor(MAHOMES).map(g => g.g));
  const idsB = new Set(gamesFor(ALLEN).map(g => g.g));
  const expected = [...idsA].filter(g => idsB.has(g)).length;
  assert.equal(h.games, expected);
  for (const m of h.meetings) {
    assert.ok(m.b, 'both sides of a meeting must be present');
    assert.notEqual(m.a.team, m.b.team, 'a meeting is two different teams');
  }
});

test('two quarterbacks who never met report unavailable, not 0-0', async () => {
  const D = dataset();
  // find a genuine non-overlapping pair
  let pair = null;
  outer: for (const a of D.players.slice(0, 40)) {
    const ids = new Set(gamesFor(a.gsis_id).map(g => g.g));
    for (const b of D.players.slice(0, 40)) {
      if (a.gsis_id === b.gsis_id) continue;
      if (!gamesFor(b.gsis_id).some(g => ids.has(g.g))) { pair = [a, b]; break outer; }
    }
  }
  assert.ok(pair, 'expected a non-overlapping pair');
  const r = await call('compare', `player_a=${pair[0].gsis_id}&player_b=${pair[1].gsis_id}`);
  assert.equal(r.body.head_to_head.available, false);
  assert.equal(r.body.head_to_head.games, 0);
  assert.ok(r.body.head_to_head.reason);
});

test('comparing a player with himself is refused', async () => {
  const r = await call('compare', `player_a=${MAHOMES}&player_b=${MAHOMES}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'same_player');
});

test('ypa differences in yards, never in percentage points', async () => {
  const r = await call('compare', `player_a=${MAHOMES}&player_b=${ALLEN}`);
  const y = r.body.baseline.deltas.ypa;
  assert.equal(y.available, true);
  assert.equal(y.unit, 'yards per attempt');
  assert.ok(Math.abs(y.diff) < 4, `ypa diff ${y.diff} is not in yards`);
});

test('every available delta states both sample sizes', async () => {
  const r = await call('compare', `player_a=${MAHOMES}&player_b=${ALLEN}`);
  for (const [k, d] of Object.entries(r.body.baseline.deltas)) {
    if (!d.available) continue;
    assert.equal(typeof d.n_a, 'number', `${k} n_a`);
    assert.equal(typeof d.n_b, 'number', `${k} n_b`);
  }
});

test('context mode reports what it could NOT evaluate', async () => {
  // deliberately withhold wind and precipitation
  const r = await call('compare',
    `player_id=${MAHOMES}&roof=outdoors&temp_f=24&home=false&opponent=BUF&divisional=false`);
  assert.equal(r.body.mode, 'context');
  const missed = r.body.unevaluated.map(u => u.condition);
  assert.ok(missed.includes('wind'));
  assert.ok(missed.includes('precipitation'));
  assert.ok(missed.includes('primetime'));
  assert.ok(r.body.matched_windows.includes('below_freezing'));
  assert.ok(r.body.matched_windows.includes('road'));
});

test('a roofed game context never matches a weather window', async () => {
  const r = await call('compare',
    `player_id=${MAHOMES}&roof=dome&temp_f=20&wind_mph=30&precip=snow&home=true`);
  for (const k of ['below_freezing', 'snow', 'wind_20_plus', 'rain', 'dry']) {
    assert.equal(r.body.matched_windows.includes(k), false, `${k} must not apply indoors`);
  }
  assert.ok(r.body.matched_windows.includes('dome'));
  assert.ok(r.body.unevaluated.some(u => u.condition === 'weather'));
});

test('the printable statement always carries the N and the sample label', async () => {
  const r = await call('compare',
    `player_id=${MAHOMES}&roof=outdoors&temp_f=24&wind_mph=12&precip=snow&home=true&primetime=false&divisional=true`);
  for (const [k, w] of Object.entries(r.body.windows)) {
    if (!w.available) continue;
    assert.match(w.statement, /N=\d+/, `${k} statement must state N`);
    assert.match(w.statement, /SAMPLE/, `${k} statement must carry its size label`);
    assert.match(w.statement, /baseline/, `${k} statement must be relative to the baseline`);
  }
});

test('an opponent with no history is unavailable, not a zero line', async () => {
  const r = await call('compare', `player_id=${MAHOMES}&opponent=ZZZ`);
  assert.equal(r.body.vs_opponent.available, false);
  assert.equal(r.body.vs_opponent.games, 0);
});

test('vs_opponent counts only games actually played against that team', async () => {
  const r = await call('compare', `player_id=${MAHOMES}&opponent=BUF`);
  const rows = gamesFor(MAHOMES).filter(g => (g.ha === 1 ? g.a : g.h) === 'BUF');
  assert.equal(r.body.vs_opponent.games, rows.length);
  assert.equal(r.body.vs_opponent.game_log.length, rows.length);
});

/* ===================== SEASON GATING ===================================== */

test('the availability matrix is coverage percentages, and the gate reads them as such', () => {
  const avail = dataset().meta.field_availability_by_season;
  assert.ok(avail, 'the dataset must publish an availability matrix');
  let numeric = 0, nulls = 0;
  for (const row of Object.values(avail)) {
    for (const v of Object.values(row)) {
      if (v === null) { nulls++; continue; }
      assert.equal(typeof v, 'number');
      assert.ok(v >= 0 && v <= 100, `coverage ${v} is not a percentage`);
      numeric++;
    }
  }
  assert.ok(numeric > 0 && nulls > 0,
    'the matrix must contain both measured coverage and unpublished seasons');
});

test('a thinly covered field is WITHHELD, not served as a smaller sample', () => {
  // measured: ngs_air_yards is ~37% covered in 2019-2022
  const g = gate(2021, 'ngs_air_yards');
  assert.equal(g.status, STATUS.WITHHELD);
  assert.equal(g.served, false);
  assert.ok(g.coverage_pct < THRESHOLDS.retain);
  assert.match(g.reason, /charted subset, not the season/);
});

test('a partially covered field is retained internally, never exposed', () => {
  // measured: offense_personnel is ~76% covered in 2019-2022
  const g = gate(2021, 'offense_personnel');
  assert.equal(g.status, STATUS.INTERNAL_ONLY);
  assert.equal(g.served, false);
  assert.ok(g.coverage_pct >= THRESHOLDS.retain && g.coverage_pct < THRESHOLDS.serve);
});

test('an unpublished season is NOT_PUBLISHED, never zero coverage', () => {
  const g = gate(2024, 'defenders_in_box');
  assert.equal(g.status, STATUS.NOT_PUBLISHED);
  assert.equal(g.coverage_pct, null);
  assert.notEqual(g.coverage_pct, 0);
});

test('0% coverage is withheld even when the column exists', () => {
  // measured: ngs_air_yards collapses to 0% in 2023 while the column is still present
  const g = gate(2023, 'ngs_air_yards');
  assert.equal(g.coverage_pct, 0);
  assert.equal(g.status, STATUS.WITHHELD);
  assert.equal(g.served, false);
});

test('adequate coverage still does not serve a field this prototype has not aggregated', () => {
  const g = gate(2023, 'defenders_in_box');   // measured 100%
  assert.equal(g.status, STATUS.AVAILABLE);
  assert.equal(g.served, false, 'AVAILABLE must not be mistaken for served');
  assert.match(g.reason, /not yet aggregated/);
});

test('an unknown field or season fails closed rather than defaulting open', () => {
  for (const g of [gate(2021, 'completion_probability_over_expected'), gate(1994, 'route')]) {
    assert.equal(g.status, STATUS.NOT_PUBLISHED);
    assert.equal(g.served, false);
  }
});

test('no advanced field is served in any response, and each says why', async () => {
  const r = await call('qb-dna', `player_id=${MAHOMES}`);
  const rep = r.body.advanced_availability;
  assert.equal(rep.policy.serve_threshold_pct, THRESHOLDS.serve);
  assert.ok(Object.keys(rep.by_field).length >= 10);
  for (const [field, v] of Object.entries(rep.by_field)) {
    assert.equal(v.served_in_this_response, false, `${field} claims to be served`);
    for (const [season, g] of Object.entries(v.seasons)) {
      assert.equal(g.served, false, `${field} ${season}`);
      assert.ok(g.reason, `${field} ${season} must state a reason`);
      assert.ok(Object.values(STATUS).includes(g.status));
    }
  }
  assert.ok(rep.unavailable_fields.includes('ngs_air_yards'));
  assert.ok(rep.unavailable_fields.includes('route'));
});

test('every served field names its source', async () => {
  const r = await call('qb-dna', `player_id=${MAHOMES}`);
  const served = r.body.served_fields;
  const sources = new Set(['nflverse_pbp', 'nflverse_schedules', 'open_meteo_archive',
                           'derived_from_venue_tz', 'espn_teams']);
  for (const [f, src] of Object.entries(served)) {
    assert.ok(sources.has(src), `${f} has an undeclared source ${src}`);
  }
  // nothing may appear as both served and gated
  const gated = new Set(Object.keys(r.body.advanced_availability.by_field));
  for (const f of Object.keys(served)) assert.equal(gated.has(f), false, `${f} is both served and gated`);
});
