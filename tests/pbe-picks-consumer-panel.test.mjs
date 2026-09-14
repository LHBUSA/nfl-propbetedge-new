/* Dashboard PBE Picks / Track Record panel — consumer presentation contract.
 *
 * The panel (nfl-command-center-v1.js picksHtml) is customer UI. It used to
 * print the engine's observability verbatim: "The engine, as it stands",
 * "ENGINE DEGRADED — source unavailable", "Runtime UNKNOWN · Champion v1",
 * three 0 KPI boxes, two progress bars and a paragraph about the publication
 * gate. This suite pins the consumer contract instead:
 *
 *   - no runtime-health, run-ledger, lane or champion wording, ever
 *   - runtime health never changes what the consumer sees
 *   - an unread or malformed record fails closed; nothing unread renders as 0
 *   - validation is never called official
 *   - an official record that exists is always shown, gated or not
 *
 * The state payloads come from the REAL api/pbe-picks.js state view
 * (tests/fixtures/pbe-picks-panel.fixture.mjs); the real module renders them
 * in a VM. Engine truth itself is asserted unchanged on the payload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { panelScenarios } from './fixtures/pbe-picks-panel.fixture.mjs';

const SRC = readFileSync(new URL('../nfl-command-center-v1.js', import.meta.url), 'utf8');
const S = await panelScenarios();

function panel() {
  const logs = [];
  const log = level => (...args) => logs.push([level, args.join(' ')]);
  const win = { addEventListener() {} };
  const doc = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible' };
  const ctx = { window: win, document: doc, console: { info: log('info'), warn: log('warn'), log: log('log'), error: log('error') }, Date, JSON, Math, Number, String, Array, Object, Set, Map, Promise, setTimeout, clearTimeout };
  vm.runInNewContext(SRC, ctx);
  const cc = win.PBECommandCenter;
  return {
    logs,
    render({ data, error }) {
      Object.assign(cc.store.picks, { data, error });
      return cc.picksHtml();
    },
  };
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const stateOf = html => /data-picks-state="([^"]+)"/.exec(html)?.[1];

const FORBIDDEN = [
  /as it stands/i, /ENGINE DEGRADED/i, /SOURCE UNAVAILABLE/i, /\bRuntime\b/i, /Champion/i, /run[ _-]?ledger/i, /\blanes?\b/i,
  /ENGINE (GATED|LIVE|STATE)/i, /MODEL VALIDATION IN PROGRESS/i, /\b(HEALTHY|UNKNOWN|STALE|DEGRADED)\b/, /publication stays gated/i,
  /publication gate/i, /picks_backend_unavailable|run_ledger_unreachable|offline|official_counts_missing|publication_state/i,
  /pbecc-kpis|pbecc-engine|pbecc-gate|pbecc-bar|is-error/,
];
function assertConsumerSafe(name, html) {
  for (const re of FORBIDDEN) assert.equal(re.test(html), false, `${name}: consumer output matches ${re}\n${text(html)}`);
}

test('every state is consumer-safe: no ops telemetry, reasons, lane or champion wording', () => {
  const p = panel();
  for (const [name, scenario] of Object.entries(S)) assertConsumerSafe(name, p.render(scenario));
  assertConsumerSafe('loading', p.render({ data: null, error: null }));
});

test('1. validation underway, no official picks: one compact neutral state, never three zeros', () => {
  const html = panel().render(S['1-validation-no-official']);
  const t = text(html);
  assert.equal(stateOf(html), 'validation');
  assert.match(t, /^PBE PICKS · TRACK RECORD Official Track Record PBE Picks Validation is underway\. Official track-record publication begins once the qualification window is complete\. 14 \/ 100 graded · Week 1 \/ 4 PBE Picks → Verified track record →$/);
  assert.equal(/\b0\b/.test(t), false, 'no zero is rendered');
  assert.equal(/official picks?\b/i.test(t), false, 'validation is never called an official pick');
  assert.equal(/<dl|<dd/.test(html), false, 'no KPI grid');
});

test('2. official picks exist: the official graded record and open official picks are shown', () => {
  const html = panel().render(S['2-official-picks-exist']);
  const t = text(html);
  assert.equal(stateOf(html), 'record');
  assert.match(t, /Official picks graded 3/);
  assert.match(t, /Open official picks 1/);
  assert.equal(/validation/i.test(t), false, 'a live engine with a record says nothing about validation');
  assert.equal(/win rate|units|ROI|\d+-\d+/i.test(t), false, 'no metric the state payload does not carry');
  assert.match(t, /PBE Picks → Verified track record →$/);
});

test('3. runtime health unavailable but the record payload is valid: the consumer state is unchanged', () => {
  /* engine truth is untouched: the API still reports the degradation */
  const down = S['3a-runtime-unavailable-validation-record'].data;
  assert.equal(down.engine_health, 'UNKNOWN');
  assert.equal(down.engine_state, 'ENGINE DEGRADED — source unavailable');
  assert.match(down.engine_runtime.unavailable_reason, /run_ledger_unreachable/);

  const p = panel();
  assert.equal(p.render(S['3a-runtime-unavailable-validation-record']), p.render(S['1-validation-no-official']));
  assert.equal(p.render(S['3b-runtime-unavailable-official-record']), p.render(S['2-official-picks-exist']));
  /* a later refresh that failed keeps the last valid record */
  assert.equal(p.render(S['3c-refresh-failed-last-valid-record-kept']), p.render(S['2-official-picks-exist']));

  /* the diagnostic detail is still available — in the console, not the UI */
  const q = panel();
  q.render(S['3a-runtime-unavailable-validation-record']);
  assert.ok(q.logs.some(([level, msg]) => level === 'info' && /runtime UNKNOWN/.test(msg) && /ENGINE DEGRADED/.test(msg)), JSON.stringify(q.logs));
  const before = q.logs.length;
  for (let i = 0; i < 5; i++) q.render(S['3a-runtime-unavailable-validation-record']);
  assert.equal(q.logs.length, before, 'one diagnostic per condition, not per paint');
});

test('4. record payload unavailable or untrustworthy: small neutral fail-closed state, no zeros, no reason', () => {
  const v = S['1-validation-no-official'].data;
  const broken = {
    '4a-record-payload-unavailable': S['4a-record-payload-unavailable'],
    '4b-record-payload-malformed': S['4b-record-payload-malformed'],
    'official counts null': { data: { ...v, decisions: { ...v.decisions, official: { total: null, open: null, graded: null } } }, error: null },
    'official count not a number': { data: { ...v, decisions: { ...v.decisions, official: { ...v.decisions.official, graded: 'n/a' } } }, error: null },
    'negative count': { data: { ...v, decisions: { ...v.decisions, official: { ...v.decisions.official, open: -1 } } }, error: null },
    'publication state missing': { data: { ...v, publication: undefined }, error: null },
    'not an object': { data: 'upstream error page', error: null },
  };
  for (const [name, scenario] of Object.entries(broken)) {
    const p = panel();
    const html = p.render(scenario);
    const t = text(html);
    assert.equal(stateOf(html), 'unavailable', name);
    assert.equal(t, 'PBE PICKS · TRACK RECORD Official Track Record PBE Picks Track record temporarily unavailable. PBE Picks → Verified track record →', name);
    assert.equal(/\d/.test(t), false, `${name}: no number is rendered for unread data`);
    assertConsumerSafe(name, html);
    assert.ok(p.logs.some(([level]) => level === 'warn'), `${name}: the reason is logged for diagnosis`);
  }
  const p = panel();
  p.render(S['4a-record-payload-unavailable']);
  assert.match(p.logs.at(-1)[1], /picks_backend_unavailable/, 'the underlying reason stays in the console');
});

test('5. gated engine: validation is shown as validation, and a prior official record is never hidden', () => {
  const gated = panel().render(S['1-validation-no-official']);
  assert.equal(stateOf(gated), 'validation');
  const withRecord = panel().render(S['5-gated-engine-with-prior-official-record']);
  const t = text(withRecord);
  assert.equal(stateOf(withRecord), 'record');
  assert.match(t, /Official picks graded 3/);
  assert.match(t, /Open official picks 1/);
  assert.match(t, /Validation underway · 14 \/ 100 graded · Week 1 \/ 4/);
});

test('6. live engine: no official picks yet is said plainly, with no zero boxes and no validation claim', () => {
  const html = panel().render(S['6-live-engine-no-official-yet']);
  const t = text(html);
  assert.equal(stateOf(html), 'live-empty');
  assert.match(t, /No official picks yet\./);
  assert.equal(/\d/.test(t), false);
  assert.equal(/validation/i.test(t), false);
});

test('loading is its own state, not an error and not zeros', () => {
  const html = panel().render({ data: null, error: null });
  assert.equal(stateOf(html), 'loading');
  assert.equal(/\d/.test(text(html)), false);
});

test('other consumer surfaces no longer print the leaked ops strings', () => {
  const files = ['nfl-command-center-v1.js', 'pbe-card-v3.js', 'pbe-picks-v2.js', 'pbe-prop-engine-v1.js', 'pbe-engine-story-v1.js'];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const re of [/ENGINE DEGRADED/, /SOURCE UNAVAILABLE/, /as it stands/i, /Champion v\$\{/i, /champion v\$\{/, /Runtime \$\{/, /Run ledger/, /live run ledger/, /publication stays gated/i, /VALIDATION CHAMPION|PRODUCTION CHAMPION/]) {
      assert.equal(re.test(src), false, `${f} still renders ${re}`);
    }
  }
});
