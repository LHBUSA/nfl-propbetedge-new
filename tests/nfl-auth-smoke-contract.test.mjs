/* The post-deploy access contract (scripts/nfl-access-contract.mjs) must fail
 * exactly when production drifts from Access V2, and must not pass on the
 * removed site-wide wall.
 *
 *   1. judgeShell: the old wall (workspace never booted), an unresolved
 *      verdict, a hidden shell or a self-opening modal all fail; the open
 *      public shell passes for every reader verdict.
 *   2. judgeRefusal: only the expected refusal status, with no premium body and
 *      no public caching, passes.
 *   3. The forged owner session the live smoke sends reads as signed out in the
 *      real handlers (401), never as a signed-in reader.
 *   4. judgeTrackRecord passes on the real handler's public payloads and fails
 *      on every drift it names: gate thresholds, gate/tuner/publication
 *      disagreement, merged or non-count totals, decision content in public
 *      views, non-official rows in the official record.
 *   5. The removed wall harness is gone and every browser smoke uses the
 *      contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ENV, NOW, mock, installMockFetch } from './fixtures/pbe-card-v3.fixture.mjs';

Object.assign(process.env, ENV);
Date.now = () => NOW;

const C = await import('../scripts/nfl-access-contract.mjs');
const { default: picks } = await import('../api/pbe-picks.js');
const { SESSION_COOKIE } = await import('../api/_nfl-auth.js');
installMockFetch();

async function call(query, cookie = '') {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.body = t; } };
  await picks({ method: 'GET', query, headers: cookie ? { cookie } : {} }, res);
  return { status: res.statusCode, text: res.body, json: JSON.parse(res.body || 'null'), cacheControl: res.headers['cache-control'] || '' };
}

const OPEN_SHELL = Object.freeze({ verdict: 'anonymous', app: true, views: 37, shell: true, viewChars: 8276, bodyHidden: false, modalOpen: false, gateScript: false });

test('shell: the open public app passes for every resolved reader verdict', () => {
  assert.equal(C.judgeShell(OPEN_SHELL), null);
  for (const verdict of C.ACCESS_VERDICTS) assert.equal(C.judgeShell({ ...OPEN_SHELL, verdict }, { expect: null }), null, verdict);
});

test('shell: the removed site-wide wall fails, in each of the ways it could come back', () => {
  /* 224d20d: html[data-pbe-access="anonymous"], workspace never loaded, only a status line */
  const wall = { verdict: 'anonymous', app: false, views: 0, shell: false, viewChars: 40, bodyHidden: false, modalOpen: false, gateScript: true };
  assert.match(C.judgeShell(wall), /access gate script|site-wide wall/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, gateScript: true }), /access gate script/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, app: false, views: 0 }), /did not boot/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, shell: false }), /shell hidden/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, bodyHidden: true }), /shell hidden/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, viewChars: 12 }), /did not render/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, modalOpen: true }), /modal opened/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, verdict: 'checking' }), /unresolved/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, verdict: null }), /unresolved/);
  assert.match(C.judgeShell({ ...OPEN_SHELL, verdict: 'granted' }), /expected a anonymous reader/);
  assert.match(C.judgeShell('<WEDGED>'), /probe failed/);
});

test('refusal: only the expected status, without premium content or public caching', () => {
  const ok = { status: 401, text: '{"error":"sign_in_required","entitlement":"nfl_pro"}', cacheControl: 'no-store' };
  assert.equal(C.judgeRefusal(ok, { label: 'x' }), null);
  assert.match(C.judgeRefusal({ ...ok, status: 200 }, { label: 'x' }), /expected 401 got 200/);
  assert.match(C.judgeRefusal({ ...ok, status: 403 }, { label: 'x' }), /expected 401 got 403/);
  assert.match(C.judgeRefusal({ ...ok, text: '{"error":"x","picks":[{"model_prob":0.55}]}' }, { label: 'x' }), /premium fields/);
  assert.match(C.judgeRefusal({ ...ok, cacheControl: 'public, s-maxage=30' }, { label: 'x' }), /publicly cacheable/);
  assert.match(C.judgeRefusal(null, { label: 'x' }), /no response/);
  assert.equal(C.judgeRefusal({ ...ok, status: 403 }, { status: [403], label: 'x' }), null);
});

test('the forged owner session the live smoke sends is signed out in the real handler', async () => {
  const forged = C.forgedSessionCookie();
  assert.ok(forged.startsWith(`${C.SESSION_COOKIE}=`));
  assert.equal(C.SESSION_COOKIE, SESSION_COOKIE);
  for (const view of ['current', 'validation-history']) {
    const r = await call({ view }, forged);
    assert.equal(r.status, 401, view);
    assert.equal(C.judgeRefusal(r, { label: view }), null, view);
  }
});

test('track record: the real handler public payloads satisfy the live contract', async () => {
  const [state, preview, trackrecord] = await Promise.all(['state', 'preview', 'trackrecord'].map(view => call({ view })));
  assert.deepEqual([state.status, preview.status, trackrecord.status], [200, 200, 200]);
  assert.deepEqual(C.judgeTrackRecord({ state: state.json, preview: preview.json, trackrecord: trackrecord.json }), []);
});

test('track record: every drift the contract names is caught', async () => {
  const [s, pv, tr] = (await Promise.all(['state', 'preview', 'trackrecord'].map(view => call({ view })))).map(r => r.json);
  const judge = (over = {}) => C.judgeTrackRecord({ state: s, preview: pv, trackrecord: tr, ...over });
  const withState = patch => judge({ state: { ...s, ...patch } });
  assert.match(withState({ graded_sample_required: 50 }).join(), /gate is 100/);
  assert.match(withState({ distinct_weeks_required: 2 }).join(), /gate is 4/);
  assert.match(withState({ graded_sample: '19' }).join(), /pair of counts/);
  assert.match(withState({ graded_sample: s.graded_sample + 1 }).join(), /tracking \+ official/);
  assert.match(withState({ auto_tuner: 'ELIGIBLE' }).join(), /auto_tuner/);
  /* 120 finalized in 3 weeks is still GATED: both thresholds, never one */
  assert.deepEqual(withState({ graded_sample: 120, graded_sample_tracking: 120, graded_sample_official: 0, distinct_weeks: 3, auto_tuner: 'GATED' }), []);
  assert.match(withState({ graded_sample: 120, graded_sample_tracking: 120, graded_sample_official: 0, distinct_weeks: 3, auto_tuner: 'ELIGIBLE' }).join(), /auto_tuner/);
  assert.match(withState({ publication: s.champion_trained ? 'GATED' : 'ALLOWED' }).join(), /publication/);
  const merged = { ...s.decisions.tracking };
  assert.match(withState({ decisions: { tracking: merged, official: merged } }).join(), /merged/);
  assert.match(withState({ decisions: { ...s.decisions, official: { ...s.decisions.official, total: 1.5 } } }).join(), /not a count/);
  assert.match(withState({ decisions: { ...s.decisions, official: { total: 0, open: 0, graded: 2 } } }).join(), /graded exceeds total/);
  assert.match(withState({ engine_runtime: { lanes: { x: { detail: { selection_team: 'BUF' } } } } }).join(), /view=state exposes decision content/);
  assert.match(judge({ preview: { ...pv, previews: [{ market_price: -110 }] } }).join(), /view=preview exposes decision content/);
  assert.match(judge({ trackrecord: { ...tr, publication_scope: 'tracking' } }).join(), /publication_scope tracking/);
  assert.match(judge({ trackrecord: { ...tr, picks: [{ publication_scope: 'tracking' }] } }).join(), /non-official row/);
  assert.match(judge({ trackrecord: { ...tr, picks: [{ label: 'PBE VALIDATION SIGNAL' }] } }).join(), /official total is 0 but|validation signal/);
  assert.match(judge({ trackrecord: null }).join(), /unreadable/);
  assert.deepEqual(C.judgeTrackRecord({ state: null }), ['view=state unreadable']);
});

test('the removed wall harness is gone; every browser smoke uses the Access V2 contract', () => {
  assert.equal(existsSync(new URL('../scripts/qa-entitled-api.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../scripts/nfl-access-local-server.mjs', import.meta.url)), false);
  for (const f of ['scripts/recovery-browser-smoke.mjs', 'scripts/injury-layout-smoke.mjs']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /from '\.\/nfl-access-contract\.mjs'/, f);
    assert.match(src, /judgeShell\(/, f);
    assert.equal(/qa-entitled-api|startEntitledApi|accessProblem/.test(src), false, f);
  }
  const smoke = readFileSync(new URL('../scripts/recovery-browser-smoke.mjs', import.meta.url), 'utf8');
  for (const needle of ['trackSurfaces(\'desktop\')', 'trackSurfaces(\'mobile\')', 'upgrade-boundary-', 'requestedHistory']) assert.ok(smoke.includes(needle), needle);
  const wf = readFileSync(new URL('../.github/workflows/post-deploy-smoke.yml', import.meta.url), 'utf8');
  assert.match(wf, /node scripts\/nfl-access-boundary-smoke\.mjs/);
  assert.match(wf, /tests\/nfl-auth-access-v2\.test\.mjs/);
  assert.equal(mock.engineDown, false);
});
