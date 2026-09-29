// Official vs Tracking TD Target records: split ONLY by the persisted publication_scope. Record-view fix (2026-09-27).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tdRecordsByScope, scopeOf } from '../api/_td-record-scope.js';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let n = 0;
const row = (scope, result, extra = {}) => ({
  id: `t${++n}`, publication_scope: scope, target_rank: 'primary', status: result ? 'graded' : 'open',
  grade: result ? { result } : null, week: 3, season: 2026, player: { name: `P${n}` }, model: {}, ...extra,
});
const settledOf = rows => rows.filter(r => r.status !== 'open');
const openOf = rows => rows.filter(r => r.status === 'open').map(({ id, publication_scope, target_rank }) => ({ id, publication_scope, target_rank }));
const rec = rows => tdRecordsByScope({ settled: settledOf(rows), open: openOf(rows) });
const wl = b => `${b.all.wins}-${b.all.losses}`;

test('A. tracking win only -> tracking 1-0, official 0-0', () => {
  const r = rec([row('tracking', 'win')]);
  assert.equal(wl(r.tracking), '1-0'); assert.equal(wl(r.official), '0-0');
});
test('B. tracking loss only -> tracking 0-1, official 0-0', () => {
  const r = rec([row('tracking', 'loss')]);
  assert.equal(wl(r.tracking), '0-1'); assert.equal(wl(r.official), '0-0');
});
test('C. official win only -> official 1-0, tracking unchanged', () => {
  const base = [row('tracking', 'loss')];
  const r = rec([...base, row('official', 'win')]);
  assert.equal(wl(r.official), '1-0'); assert.deepEqual(r.tracking, rec(base).tracking);
});
test('D. official loss only -> official 0-1, tracking unchanged', () => {
  const base = [row('tracking', 'win')];
  const r = rec([...base, row('official', 'loss')]);
  assert.equal(wl(r.official), '0-1'); assert.deepEqual(r.tracking, rec(base).tracking);
});
test('E. mixed: 3 tracking W, 2 tracking L, 2 official W, 1 official L -> official 2-1, tracking 3-2, internal 5-3', () => {
  const rows = [
    ...['win', 'win', 'win', 'loss', 'loss'].map(x => row('tracking', x)),
    ...['win', 'win', 'loss'].map(x => row('official', x)),
  ];
  const r = rec(rows);
  assert.equal(wl(r.official), '2-1');
  assert.equal(wl(r.tracking), '3-2');
  assert.equal(wl(r.combined_internal), '5-3');
  assert.equal(r.official.all.wins + r.tracking.all.wins, r.combined_internal.all.wins, 'no cross-contamination');
  assert.equal(r.official.all.losses + r.tracking.all.losses, r.combined_internal.all.losses);
});
test('F. pending tracking target never appears in the official pending count', () => {
  const r = rec([row('tracking', null), row('tracking', null)]);
  assert.equal(r.official.all.pending, 0); assert.equal(r.official.primary.pending, 0);
  assert.equal(r.tracking.all.pending, 2);
});
test('G. pending official target appears in the official pending count', () => {
  const r = rec([row('official', null), row('tracking', null)]);
  assert.equal(r.official.all.pending, 1); assert.equal(r.tracking.all.pending, 1);
});
test('H. historical tracking rows stay tracking: scope is read, never inferred, never rewritten', () => {
  const hist = row('tracking', 'win', { week: 1, displayed_free: true, target_rank: 'primary', model: { version: 'x' } });
  const snapshot = JSON.stringify(hist);
  const r = rec([hist, row('official', 'win', { week: 9 })]);
  assert.equal(JSON.stringify(hist), snapshot, 'input rows are not mutated');
  assert.equal(scopeOf(hist), 'tracking');
  assert.equal(r.tracking.all.wins, 1);
  assert.equal(r.official.all.wins, 1);
  // Nothing but publication_scope decides: rank/grade/free/gate/date/model never make a row official.
  for (const extra of [{ official: true }, { free: true }, { gate_open: true }, { target_rank: 'primary', grade: { result: 'win' } }]) {
    assert.equal(scopeOf({ publication_scope: 'tracking', ...extra }), 'tracking');
  }
  for (const other of ['validation', 'shadow', 'research', '', null, undefined]) {
    const r2 = tdRecordsByScope({ settled: [{ publication_scope: other, grade: { result: 'win' } }] });
    assert.equal(r2.official.all.wins + r2.tracking.all.wins, 0, `scope ${other} is in neither record`);
    assert.equal(r2.unscoped_excluded, 1);
  }
});
test('I. free product is untouched: the free sample and the free-picks tracker contract are not part of this change', () => {
  // The overall Free Picks record lives in the propbetedge.ai tracker (tests/free-products-v4.test.mjs there proves a
  // tracking free TD result moves it). Here: the free-sample module does not import or depend on the record split.
  assert.doesNotMatch(read('api/_td-free-sample.js'), /_td-record-scope/);
});

/* ---------------------------------------------------------------- the API */
test('the Vercel function and the Worker compute the record with the one shared module, by persisted scope', () => {
  for (const path of ['api/pbe-touchdown-targets.js', 'workers/nfl-touchdown-targets-api/src/contract.js']) {
    const src = read(path);
    assert.match(src, /import \{ tdRecordsByScope, splitCanonical, settledEventIds, publicSettledTarget \} from '[./]+(api\/)?_td-record-scope\.js';/);
    /* 2026-09-29: only the canonical locked set counts; exclusions are listed, never deleted */
    assert.match(src, /const \{ locked: shaped, excluded \} = splitCanonical\(\{ rows: every, evaluations: finals \}\);/);
    assert.match(src, /const records = tdRecordsByScope\(\{ settled: shaped, open: openLocked \}\);/);
    assert.match(src, /status=eq\.open\$\{filter\}&select=id,event_id,publication_scope,target_rank/);
  }
});

/* ----------------------------------------------------------------- the UI */
function loadPage() {
  const noop = () => {};
  const el = () => ({ addEventListener: noop, classList: { toggle: noop, add: noop, remove: noop }, insertBefore: noop, querySelector: () => null });
  const window = { addEventListener: noop, dispatchEvent: noop, App: null };
  const document = { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: el };
  window.window = window;
  const context = vm.createContext({ window, document, sessionStorage: { getItem: () => null, setItem: noop }, setTimeout: noop, CustomEvent: class {}, Intl, Date, Math, JSON, Number, String, Array, Set, Map, Object, Promise, console });
  vm.runInContext(read('touchdown-targets-v1.js'), context);
  return window.PBETouchdownTargets;
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const panel = (html, scope) => {
  const i = html.indexOf(`data-pbetd-record-scope="${scope}"`);
  const j = html.indexOf('data-pbetd-record-scope=', i + 10);
  return text(html.slice(i, j > i ? j : undefined));
};

test('UI: the OFFICIAL record panel is official-only; tracking is a separate, labelled validation panel; nothing combined', () => {
  const page = loadPage();
  const rows = [
    ...['win', 'win', 'win', 'loss', 'loss'].map(x => row('tracking', x)),
    ...['win', 'win', 'loss'].map(x => row('official', x)),
  ];
  const body = { targets: settledOf(rows), records: rec([...rows, row('tracking', null), row('official', null)]), coverage: {}, grading: {} };
  const html = page.recordHtml(body);
  const off = panel(html, 'official');
  const trk = panel(html, 'tracking');
  assert.match(off, /Official TD Target record/);
  assert.match(off, /official targets only/);
  assert.match(off, /Record 2-1/);
  assert.match(off, /Pending 1 open official targets/);
  assert.match(trk, /Tracking TD Target record/);
  assert.match(trk, /Validation phase/);
  assert.match(trk, /not the official record/);
  assert.match(trk, /Record 3-2/);
  assert.match(trk, /Pending 1 open tracking targets/);
  assert.doesNotMatch(html, /Record 5-3/, 'the combined internal total is never rendered as a record');
});

test('UI today (every target tracking): official panel shows 0-0 and says why; tracking panel carries the results', () => {
  const page = loadPage();
  const rows = [row('tracking', 'win'), row('tracking', 'loss'), row('tracking', 'loss')];
  const html = page.recordHtml({ targets: rows, records: rec([...rows, row('tracking', null)]), coverage: {}, grading: {} });
  const off = panel(html, 'official');
  assert.match(off, /Record 0-0/);
  assert.match(off, /Pending 0/);
  assert.match(off, /No official Touchdown Targets have been graded yet/);
  assert.match(panel(html, 'tracking'), /Record 1-2/);
});

test('hero: the learning-gate sample is labelled as the validation sample (all scopes), never as an official record', () => {
  const src = read('touchdown-targets-v1.js');
  assert.doesNotMatch(src, /Season primary record/);
  assert.match(src, /'Validation sample'/);
});
