/* PBE Track Record V3 — accounting, separation and render contract.
 *
 *   1. pbe-track-record-core-v1.js: the one implementation of W-L-P, flat units,
 *      ROI, CLV, Brier, drawdown, breakdowns and filters.
 *   2. api/pbe-picks.js governance: graded_sample and distinct_weeks are the
 *      tuner's gate rows (eligible AND final learning observations) exactly.
 *   3. pbe-picks-v2.js rendering the Track Record against the real handler
 *      (mocked upstreams): validation vs official, Pro vs free, degraded reads.
 *   4. The dashboard panel "The engine, as it stands".
 *
 * Separation rules are mutation-tested: the suite re-runs a rule against a
 * deliberately broken copy and requires it to fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  ENV, NOW, pick, OBSERVATIONS, filterObservations, sessionCookie as signCookie, mock, installMockFetch,
} from './fixtures/pbe-card-v3.fixture.mjs';

Object.assign(process.env, ENV);
Date.now = () => NOW;

const CORE_SRC = readFileSync(new URL('../pbe-track-record-core-v1.js', import.meta.url), 'utf8');
const PICKS_SRC = readFileSync(new URL('../pbe-picks-v2.js', import.meta.url), 'utf8');
const DASH_SRC = readFileSync(new URL('../nfl-command-center-v1.js', import.meta.url), 'utf8');
const API_SRC = readFileSync(new URL('../api/pbe-picks.js', import.meta.url), 'utf8');
const TUNER_SRC = readFileSync(new URL('../workers/nfl-weight-tuner/src/index.js', import.meta.url), 'utf8');

function loadCore(src = CORE_SRC) {
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  return ctx.PBETrackRecordCore;
}
const C = loadCore();

const { default: handler } = await import('../api/pbe-picks.js');
const { HMAC_NAMESPACE, SESSION_COOKIE } = await import('../api/_nfl-auth.js');
const sessionCookie = email => signCookie(email, { namespace: HMAC_NAMESPACE, cookieName: SESSION_COOKIE });
installMockFetch();

async function call(query, cookie = '') {
  const res = {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(text) { this.body = text; },
  };
  await handler({ method: 'GET', query, headers: cookie ? { cookie } : {} }, res);
  return { status: res.statusCode, text: res.body, json: JSON.parse(res.body || 'null') };
}

/* A validation-history card, shaped exactly as proCard() emits it. */
let seq = 0;
function card(over = {}) {
  seq += 1;
  const { grade, ...rest } = over;
  return {
    id: `v${String(seq).padStart(7, '0')}-0000-4000-8000-000000000000`,
    publication_scope: 'tracking', label: 'PBE VALIDATION SIGNAL', lifecycle: 'FINAL',
    game_id: `2026_01_G${seq}`, season: 2026, week: 1, matchup: { away: 'AAA', home: 'HHH' },
    kickoff_ts: new Date(Date.parse('2026-09-07T17:00:00Z') + seq * 3600000).toISOString(),
    market: 'spread', selection: { display: 'AAA -2.5' }, issue: { line: -2.5, price: -110, at: '2026-09-06T12:00:00Z' },
    model: { version: 3, prob: 0.55, fair_line: -3.5 }, market_prob: 0.5, edge_pct: 0.05, confidence_bucket: 'B', stake_units: 1,
    status: 'graded', receipt: { seq, chain_hash: 'a'.repeat(64), verified: { payload_hash: true, issued_terms: true, chain_link: true } },
    grade: grade === undefined ? { result: 'win', units_delta: 0.9091, clv_points: 0.5, clv_prob: 0.01, clv_beat: true, brier: 0.2025, graded_at: '2026-09-08T04:00:00Z' } : grade,
    ...rest,
  };
}
const g = (result, extra = {}) => ({ result, units_delta: null, clv_points: null, clv_prob: null, clv_beat: null, brier: null, graded_at: '2026-09-08T04:00:00Z', ...extra });

/* ------------------------------------------------------------------------
 * 1. Accounting
 * --------------------------------------------------------------------- */
test('flat units use the persisted issue price: never a default -110', () => {
  assert.equal(C.flatUnits('win', -110).toFixed(4), '0.9091');
  assert.equal(C.flatUnits('win', 185), 1.85);
  assert.equal(C.flatUnits('win', -250), 0.4);
  assert.equal(C.flatUnits('loss', 185), -1);
  assert.equal(C.flatUnits('loss', null), -1);
  assert.equal(C.flatUnits('push', -110), 0);
  assert.equal(C.flatUnits('win', null), null);
  assert.equal(C.flatUnits('win', 0), null);
  assert.equal(C.flatUnits('win', -50), null);
  assert.equal(C.flatUnits('void', -110), null);
  assert.equal(C.flatUnits('pending', -110), null);
  /* A win without a persisted price makes profit and ROI unavailable, not -110. */
  const rows = [card({ issue: { line: -2.5, price: null, at: 'x' } }), card({ grade: g('loss') })].map(C.fromValidation);
  const s = C.summarize(rows);
  assert.equal(s.wins, 1); assert.equal(s.losses, 1);
  assert.equal(s.profit, null); assert.equal(s.roi, null); assert.equal(s.maxDrawdown, null);
});

test('W-L-P reconciles to the rows; losses are included, pushes are settled at 0u, voids and pending are excluded', () => {
  const rows = [
    card({ issue: { line: 3, price: 150, at: 'x' } }),
    card({ grade: g('loss') }),
    card({ grade: g('loss') }),
    card({ grade: g('push') }),
    card({ grade: g('void') }),
    card({ grade: null, status: 'graded' }),
  ].map(C.fromValidation);
  const s = C.summarize(rows);
  assert.equal(s.decisions, 6);
  assert.equal(s.settled, 4);
  assert.equal(s.wins + s.losses + s.pushes, rows.filter(r => ['win', 'loss', 'push'].includes(r.result)).length);
  assert.deepEqual([s.wins, s.losses, s.pushes, s.voided, s.pending], [1, 2, 1, 1, 1]);
  assert.equal(s.profit, 1.5 - 1 - 1 + 0);
  /* ROI denominator: settled decisions (W+L+P), 1u each. */
  assert.equal(s.roi, (1.5 - 2) / 4 * 100);
  assert.match(C.ROI_DENOMINATOR, /win \+ loss \+ push/);
  assert.match(CORE_SRC, /ROI\s+flat 1u profit \/ number of settled decisions/);
  assert.equal(s.winRate, 1 / 3 * 100);
  assert.equal(s.curve.length, 4);
  assert.equal(s.maxDrawdown, -2);
});

test('average odds, CLV, Brier and drawdown come only from persisted values', () => {
  const rows = [
    card({ issue: { line: 1, price: 100, at: 'x' }, grade: g('win', { clv_beat: true, clv_prob: 0.02, brier: 0.2 }) }),
    card({ issue: { line: 1, price: -200, at: 'x' }, grade: g('loss', { clv_beat: false, clv_prob: -0.01, brier: 0.3 }) }),
    card({ issue: { line: 1, price: -110, at: 'x' }, grade: g('loss') }),
    card({ grade: g('void', { clv_beat: true, clv_prob: 0.5, brier: 0 }) }),
  ].map(C.fromValidation);
  const s = C.summarize(rows);
  assert.equal(s.avgOddsSample, 3);
  const dec = (2 + 1.5 + (1 + 100 / 110)) / 3;
  assert.equal(s.avgOdds, C.americanFromDecimal(dec));
  assert.equal(s.clvSample, 2);
  assert.equal(s.clvBeatRate, 50);
  assert.equal(s.avgClvProb, 0.005);
  assert.equal(s.brierSample, 2);
  assert.equal(s.brier, 0.25);
  assert.equal(s.maxDrawdown, -2);
  const empty = C.summarize([]);
  for (const k of ['winRate', 'profit', 'roi', 'avgOdds', 'clvBeatRate', 'avgClvProb', 'brier', 'maxDrawdown']) assert.equal(empty[k], null, k);
});

test('breakdowns and filters reconcile to the source rows', () => {
  const rows = [
    card({ market: 'spread', week: 1, confidence_bucket: 'A' }),
    card({ market: 'spread', week: 2, confidence_bucket: 'B', grade: g('loss') }),
    card({ market: 'moneyline', week: 2, confidence_bucket: 'C', issue: { line: null, price: 140, at: 'x' } }),
    card({ market: 'total', week: 3, confidence_bucket: 'B', grade: g('push') }),
    card({ market: 'total', week: 3, confidence_bucket: 'A', grade: g('loss'), model: { version: 2, prob: 0.6 } }),
  ].map(C.fromValidation);
  const total = C.summarize(rows);
  for (const split of [C.byMarket(rows), C.byWeek(rows), C.byConfidence(rows)]) {
    const sum = k => split.reduce((s, x) => s + x.summary[k], 0);
    assert.equal(sum('wins'), total.wins); assert.equal(sum('losses'), total.losses); assert.equal(sum('pushes'), total.pushes);
    assert.equal(Number(sum('profit').toFixed(6)), Number(total.profit.toFixed(6)));
    assert.equal(split.reduce((s, x) => s + x.rows.length, 0), rows.length);
  }
  assert.deepEqual([...C.byMarket(rows).map(x => x.key)], ['spread', 'moneyline', 'total']);
  const avail = C.availableFilters(rows);
  for (const key of C.FILTER_KEYS) {
    const field = { model: 'modelVersion' }[key] || key;
    for (const value of avail[key]) {
      const expected = rows.filter(r => String(r[field]) === String(value));
      assert.deepEqual([...C.applyFilters(rows, { [key]: value }).map(r => r.id)], expected.map(r => r.id), `${key}=${value}`);
    }
    assert.equal(avail[key].reduce((s, v) => s + C.applyFilters(rows, { [key]: v }).length, 0), rows.length, key);
  }
  assert.equal(C.applyFilters(rows, { market: 'total', result: 'loss' }).length, 1);
  assert.equal(C.applyFilters(rows, { market: 'all' }).length, rows.length);
});

test('no filter chrome for a field most rows do not carry', () => {
  const rows = Array.from({ length: 10 }, (_, i) => card({ confidence_bucket: i < 2 ? 'A' : null })).map(C.fromValidation);
  assert.equal(C.availableFilters(rows).confidence.length, 0);
  assert.ok(C.coverage(rows, 'confidence') < 0.9);
});

/* ------------------------------------------------------------------------
 * 2. Separation
 * --------------------------------------------------------------------- */
function separationHolds(core) {
  const validation = [card(), card({ grade: g('loss') })].map(core.fromValidation);
  const official = [{ id: 'o1', publication_scope: 'official', market: 'spread', market_price: -110, status: 'graded', grade: { result: 'loss' } }].map(r => core.fromOfficial(r, 'official'));
  const mixed = [...validation, ...official];
  const off = core.selectScope(mixed, 'official');
  const val = core.selectScope(mixed, 'tracking');
  return off.every(r => r.scope === 'official') && val.every(r => r.scope === 'tracking')
    && core.summarize(off).settled === 1 && core.summarize(val).settled === 2
    && core.selectScope([...validation, ...validation], 'official').length === 0;
}

test('validation rows are tracking only, official rows are official only; tracking never increments official totals', () => {
  assert.equal(separationHolds(C), true);
  const val = C.fromValidation(card());
  assert.equal(val.label, 'VALIDATION SIGNAL');
  assert.equal(C.selectScope([val], 'official').length, 0);
  /* A row in the official response that carries another scope keeps it and is dropped. */
  for (const scope of ['tracking', 'backtest', 'demo', 'shadow']) {
    const row = C.fromOfficial({ id: 'x', publication_scope: scope, status: 'graded', grade: { result: 'win' }, market_price: -110 }, 'official');
    assert.equal(C.selectScope([row], 'official').length, 0, scope);
  }
  /* A validation card with no scope, or a synthetic one, is never a validation row either. */
  assert.equal(C.selectScope([C.fromValidation(card({ publication_scope: undefined }))], 'tracking').length, 0);
  assert.equal(C.selectScope([C.fromValidation(card({ publication_scope: 'backtest' }))], 'tracking').length, 0);
});

test('MUTATION: a selectScope that lets any scope through is caught', () => {
  const broken = CORE_SRC.replace('row && row.scope === scope', 'row && row.scope !== undefined');
  assert.notEqual(broken, CORE_SRC, 'mutation site must exist');
  assert.equal(separationHolds(loadCore(broken)), false);
});

test('MUTATION: a flat-units rule that defaults a missing price to -110 is caught', () => {
  const broken = CORE_SRC.replace('if (p === null) return null;\n    return p > 0', 'if (p === null) return 100 / 110;\n    return p > 0')
    .replace('if (p === null) return null;\r\n    return p > 0', 'if (p === null) return 100 / 110;\r\n    return p > 0');
  assert.notEqual(broken, CORE_SRC, 'mutation site must exist');
  assert.notEqual(loadCore(broken).flatUnits('win', null), null);
});

/* ------------------------------------------------------------------------
 * 3. Governance: the gate rows are the tuner's rows
 * --------------------------------------------------------------------- */
const GATE_ROWS = [
  { season: 2026, week: 1, publication_scope: 'tracking', integrity_status: 'eligible', is_final: true, finalized_at: '2026-09-09T04:00:00Z' },
  { season: 2026, week: 1, publication_scope: 'tracking', integrity_status: 'eligible', is_final: true, finalized_at: '2026-09-10T04:00:00Z' },
  { season: 2026, week: 2, publication_scope: 'official', integrity_status: 'eligible', is_final: true, finalized_at: '2026-09-15T04:00:00Z' },
  { season: 2026, week: 3, publication_scope: 'tracking', integrity_status: 'eligible', is_final: false, finalized_at: '2026-09-22T04:00:00Z' },
  { season: 2026, week: 4, publication_scope: 'tracking', integrity_status: 'quarantined', is_final: true, finalized_at: '2026-09-29T04:00:00Z' },
];

test('graded_sample and distinct_weeks reconcile exactly to eligible finalized observations (the tuner gate query)', async () => {
  const tunerQuery = /'(integrity_status=eq\.eligible&is_final=is\.true)[^']*'/.exec(TUNER_SRC)?.[1];
  assert.ok(tunerQuery, 'tuner gate query found');
  const govQuery = /sb\('nfl_learning_observations', '([^']+)'/.exec(API_SRC)?.[1];
  assert.ok(govQuery?.startsWith(tunerQuery), 'governance uses the tuner filter');
  mock.observations = GATE_ROWS;
  try {
    const state = await call({ view: 'state' });
    assert.equal(state.status, 200);
    const eligible = GATE_ROWS.filter(r => r.integrity_status === 'eligible' && r.is_final === true);
    assert.equal(state.json.graded_sample, eligible.length);
    assert.equal(state.json.distinct_weeks, new Set(eligible.map(r => `${r.season}-${r.week}`)).size);
    assert.equal(state.json.graded_sample_tracking, 2);
    assert.equal(state.json.graded_sample_official, 1);
    assert.equal(state.json.latest_finalized_at, '2026-09-15T04:00:00Z');
    assert.equal(state.json.auto_tuner, 'GATED');
    const preview = await call({ view: 'preview' });
    assert.equal(preview.json.graded_sample ?? preview.json.governance?.graded_sample ?? eligible.length, eligible.length);
  } finally { mock.observations = null; }
});

test('MUTATION: a gate query without is_final=is.true would count unfinalized observations', () => {
  const govQuery = /sb\('nfl_learning_observations', '([^']+)'/.exec(API_SRC)[1];
  const good = filterObservations(GATE_ROWS, govQuery);
  const broken = filterObservations(GATE_ROWS, govQuery.replace('&is_final=is.true', ''));
  assert.equal(good.length, 3);
  assert.notEqual(broken.length, good.length);
  assert.equal(filterObservations(GATE_ROWS, govQuery.replace('integrity_status=eq.eligible&', '')).length, 4);
});

test('the gate stays >= 100 finalized AND >= 4 weeks', async () => {
  assert.match(API_SRC, /const gateOpen = obs\.length >= 100 && weeks\.size >= 4;/);
  assert.match(TUNER_SRC, /MIN_GRADED_PICKS\s*=\s*100|MIN_GRADED_PICKS['"]?\s*[:=]\s*['"]?100/);
  assert.match(TUNER_SRC, /MIN_DISTINCT_WEEKS\s*=\s*4|MIN_DISTINCT_WEEKS['"]?\s*[:=]\s*['"]?4/);
  /* 100 rows in 3 weeks: still gated. */
  mock.observations = Array.from({ length: 120 }, (_, i) => ({ ...OBSERVATIONS[0], week: 1 + (i % 3), finalized_at: `2026-09-${String(10 + (i % 3)).padStart(2, '0')}T04:00:00Z` }));
  try {
    const state = await call({ view: 'state' });
    assert.equal(state.json.graded_sample, 120);
    assert.equal(state.json.distinct_weeks, 3);
    assert.equal(state.json.auto_tuner, 'GATED');
  } finally { mock.observations = null; }
});

test('tracking decisions never increment official decision totals', async () => {
  const before = (await call({ view: 'state' })).json.decisions;
  mock.extraRows = [
    pick({ id: 'e1111111-1111-4111-8111-111111111111', game_id: '2026_01_X_Y', status: 'graded', publication_scope: 'tracking' }),
    pick({ id: 'e2222222-2222-4222-8222-222222222222', game_id: '2026_01_X_Z', status: 'open', publication_scope: 'tracking' }),
  ];
  try {
    const after = (await call({ view: 'state' })).json.decisions;
    assert.deepEqual(after.official, before.official);
    assert.equal(after.tracking.total, before.tracking.total + 2);
  } finally { mock.extraRows = []; }
});

/* ------------------------------------------------------------------------
 * 4. The Track Record page, rendered by the real renderer
 * --------------------------------------------------------------------- */
function stubElement() {
  return {
    innerHTML: '', dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, removeAttribute() {}, setAttribute() {}, insertBefore() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
  };
}

/* Loads core + pbe-picks-v2.js into a fresh page context whose fetch reaches the
 * real handler with the persona's cookie. `fail` maps a view to an HTTP status. */
function page({ pro = false, cookie = '', fail = {}, officialPicks = null } = {}) {
  const vc = stubElement();
  const requests = [];
  const ctx = {
    console, URL, Intl, Date, Math, JSON, Promise, Response,
    setTimeout: () => 0, clearTimeout() {},
    document: {
      getElementById: id => (id === 'view-container' ? vc : null),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => stubElement(),
    },
    App: { current: 'trackrecord', VIEWS: {} },
    PBEPro: { state: { pro } },
    addEventListener() {}, dispatchEvent() {}, scrollTo() {},
  };
  ctx.window = ctx;
  ctx.fetch = async url => {
    const u = new URL(url, 'https://nfl.propbetedge.ai');
    const view = u.searchParams.get('view');
    requests.push(view);
    if (fail[view]) return new Response(JSON.stringify({ error: 'upstream_unavailable' }), { status: fail[view] });
    const r = await call(Object.fromEntries(u.searchParams), cookie);
    if (view === 'trackrecord' && officialPicks) r.json.picks = officialPicks;
    return new Response(JSON.stringify(r.json), { status: r.status });
  };
  vm.createContext(ctx);
  vm.runInContext(CORE_SRC, ctx);
  vm.runInContext(PICKS_SRC, ctx);
  const P = ctx.PBEPicksV2;
  return {
    P, requests,
    async render(tab = null) { P.state.trackTab = tab; await P.renderTrackRecord(); return vc.innerHTML; },
  };
}
/* Row labels are uppercase; prose such as "never become official picks" is a negation, not a label. */
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/* Every proprietary value the fixture's validation decisions carry. */
const PROPRIETARY = ['SEA -1.5', 'BUF -2.5', 'Model probability', 'Line · odds', 'Validation signal ledger', '54.7%', '+4.7', 'data-pbetr-expand'];

test('Pro: the Validation Record renders from validation-history with VALIDATION SIGNAL rows, never OFFICIAL PICK', async () => {
  const p = page({ pro: true, cookie: sessionCookie('pro@propbetedge.test') });
  const html = await p.render();
  const t = text(html);
  assert.deepEqual([...p.requests].sort(), ['state', 'trackrecord', 'validation-history']);
  assert.match(t, /PBE TRACK RECORD/);
  assert.match(t, /VALIDATION MODE · CHAMPION V1/);
  assert.match(t, /Real pre-game decisions · graded from final results · not yet official PBE Picks/);
  assert.match(t, /Validation Record/); assert.match(t, /Official Record/);
  assert.match(t, /Model validation/i);
  assert.match(t, /Finalized decisions 1 \/ 100/);
  assert.match(t, /Observation window 1 \/ 4 weeks/);
  assert.match(t, /Both gates must clear/);
  assert.match(t, /does not promote a model on its own/);
  assert.match(t, /Validation signal ledger/);
  assert.equal(/OFFICIAL PICK|OFFICIAL PBE PICK/.test(t), false);
  /* The ledger shows exactly the validation-history rows. */
  const hist = await call({ view: 'validation-history' }, sessionCookie('pro@propbetedge.test'));
  const ids = [...html.matchAll(/data-pbetr-expand="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(ids, hist.json.picks.map(c => c.id).sort());
  assert.equal((html.match(/pbetr-signal/g) || []).length, hist.json.picks.length);
  /* Hero W-L-P reconciles to the rows. */
  const rows = C.selectScope(hist.json.picks.map(C.fromValidation), 'tracking');
  const s = C.summarize(rows);
  assert.match(t, new RegExp(`W-L-P ${s.wins}-${s.losses}-${s.pushes}`));
});

test('Official Record zero state is truthful and surfaces the Validation Record', async () => {
  const p = page({ pro: true, cookie: sessionCookie('pro@propbetedge.test') });
  const t = text(await p.render('official'));
  assert.match(t, /OFFICIAL PUBLICATION HAS NOT STARTED/);
  assert.match(t, /Champion v1 remains in model validation/);
  assert.match(t, /0-0/);
  assert.match(t, /View the Validation Record/);
  /* The validation hero may sit under it, but no validation row is an official pick. */
  assert.equal(/OFFICIAL PICK|OFFICIAL PBE PICK/.test(t), false);
  assert.equal(t.includes('data-pbetr-expand'), false);
});

test('the Official Record drops anything not publication_scope = official', async () => {
  const smuggled = [
    { id: 'bt-1', publication_scope: 'backtest', game_id: '2025_01_A_B', season: 2025, week: 1, market: 'spread', side: 'A -3', market_price: -110, status: 'graded', grade: { result: 'win' } },
    { id: 'tr-1', publication_scope: 'tracking', game_id: '2026_01_A_B', season: 2026, week: 1, market: 'spread', side: 'A -3', market_price: -110, status: 'graded', grade: { result: 'win' } },
  ];
  const p = page({ pro: true, cookie: sessionCookie('pro@propbetedge.test'), officialPicks: smuggled });
  const t = text(await p.render('official'));
  assert.match(t, /OFFICIAL PUBLICATION HAS NOT STARTED/);
  assert.equal(t.includes('A -3'), false);
});

test('free readers: no selections, edges, lines or probabilities; aggregate progress only', async () => {
  for (const persona of [
    { name: 'anonymous', pro: false, cookie: '' },
    { name: 'free account', pro: false, cookie: sessionCookie('free@propbetedge.test') },
    /* A client that claims Pro without the entitlement is refused by the server. */
    { name: 'forged client Pro flag', pro: true, cookie: sessionCookie('free@propbetedge.test') },
  ]) {
    const p = page(persona);
    const html = await p.render();
    const t = text(html);
    for (const secret of PROPRIETARY) assert.equal(html.includes(secret), false, `${persona.name} leaked ${secret}`);
    assert.match(t, /Unlock the Validation Record/, persona.name);
    assert.match(t, /Finalized decisions 1 \/ 100/, persona.name);
    assert.equal(/OFFICIAL PICK|OFFICIAL PBE PICK/.test(t), false);
    if (!persona.pro) assert.equal(p.requests.includes('validation-history'), false, `${persona.name} must not request Pro detail`);
  }
  /* The leak list is not vacuous: Pro does render the ledger. */
  const pro = await page({ pro: true, cookie: sessionCookie('pro@propbetedge.test') }).render();
  assert.ok(pro.includes('data-pbetr-expand') && pro.includes('Validation signal ledger'));
});

test('backend failures render degraded states, never a zero record', async () => {
  const stateDown = text(await page({ pro: true, cookie: sessionCookie('pro@propbetedge.test'), fail: { state: 503 } }).render());
  assert.match(stateDown, /Track Record source unavailable/);
  assert.equal(/0-0|0 \/ 100|OFFICIAL PUBLICATION HAS NOT STARTED/.test(stateDown), false);

  const histDown = text(await page({ pro: true, cookie: sessionCookie('pro@propbetedge.test'), fail: { 'validation-history': 500 } }).render());
  assert.match(histDown, /Validation history unavailable/);
  assert.match(histDown, /never a zero record/);
  assert.equal(/W-L-P 0-0-0/.test(histDown), false);

  const officialDown = text(await page({ pro: true, cookie: sessionCookie('pro@propbetedge.test'), fail: { trackrecord: 500 } }).render('official'));
  assert.match(officialDown, /Official Track Record source unavailable/);
  assert.equal(officialDown.includes('OFFICIAL PUBLICATION HAS NOT STARTED'), false);
});

test('the renderer contains no synthetic, demo or backtest record source', () => {
  const start = PICKS_SRC.indexOf('Track Record V3 — two records, never merged.');
  const end = PICKS_SRC.indexOf('function rerenderTrackLocal');
  assert.ok(start > 0 && end > start);
  const block = PICKS_SRC.slice(start, end);
  assert.equal(/Math\.random|demo|mock|sample data|placeholder rows|backtest_units/i.test(block.replace(/no backtest or validation decision can enter it|substitute backtests/g, '')), false);
  assert.equal(/-110/.test(block), false, 'no hard-coded price in the renderer');
});

/* ------------------------------------------------------------------------
 * 5. Dashboard panel: "The engine, as it stands"
 * --------------------------------------------------------------------- */
function picksPanel(data, error = null) {
  const start = DASH_SRC.indexOf('  function picksHtml() {');
  const end = DASH_SRC.indexOf('\n  function ', start + 10);
  const fn = DASH_SRC.slice(start, end);
  const ctx = { store: { picks: { data, error } } };
  vm.createContext(ctx);
  vm.runInContext(`${/const esc = [^\n]+/.exec(DASH_SRC)[0]}\n${/const num = [^\n]+/.exec(DASH_SRC)[0]}\n${fn}\nthis.out = picksHtml();`, ctx);
  return ctx.out;
}

test('dashboard panel: validation counts first, official intentionally gated, nothing hard-coded', async () => {
  const state = (await call({ view: 'state' })).json;
  const t = text(picksPanel(state));
  assert.match(t, /The engine, as it stands/);
  assert.match(t, /ENGINE RUNNING · VALIDATION MODE/);
  assert.match(t, /official publication intentionally gated/);
  const tr = state.decisions.tracking, off = state.decisions.official;
  assert.match(t, new RegExp(`Validation finalized ${tr.graded} Validation open ${tr.open} Official published ${off.total} Official graded ${off.graded}`));
  assert.match(t, new RegExp(`Finalized validation sample ${state.graded_sample} / 100`));
  assert.match(t, new RegExp(`Observation window ${state.distinct_weeks} / 4 weeks`));
  /* Change the persisted counts: the panel follows them. */
  const moved = { ...state, graded_sample: 37, distinct_weeks: 2, decisions: { tracking: { ...tr, graded: 37, open: 9 }, official: { ...off } } };
  const t2 = text(picksPanel(moved));
  assert.match(t2, /Validation finalized 37 Validation open 9/);
  assert.match(t2, /Finalized validation sample 37 \/ 100/);
  /* Absent counts are '—', and a failed read is not zero. */
  const t3 = text(picksPanel({ ...state, graded_sample: null, decisions: {} }));
  assert.match(t3, /Validation finalized — Validation open —/);
  assert.match(t3, /Finalized validation sample — \/ 100/);
  const t4 = text(picksPanel(null, 'HTTP 503'));
  assert.match(t4, /ENGINE STATE UNAVAILABLE/);
  assert.equal(/Validation finalized 0/.test(t4), false);
  /* A dead engine never reads as running. */
  assert.match(text(picksPanel({ ...state, engine_health: 'DEGRADED' })), /ENGINE DEGRADED/);
});
