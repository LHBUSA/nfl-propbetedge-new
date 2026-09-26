/* nfl-touchdown-targets-api: the TD read contract on Cloudflare.
 *
 * 1. PARITY with the Vercel function it was ported from (api/pbe-touchdown-
 *    targets.js), run side by side on the same data: every view, including the
 *    Pro views through a real signed session on the Vercel side and the
 *    equivalent session-authority verdict on the Worker side.
 * 2. The Worker's own boundary: auth before any proprietary read, 401/403/503
 *    exactly as before, GET only, no-store on gated views, graded-only record,
 *    and a failed backend never becomes an empty slate.
 * Only the network edge is faked: Supabase REST, the engine run ledger and
 * nfl-current. When the Vercel function is retired the parity half is skipped
 * and the boundary half keeps guarding the Worker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const SB = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const SECRET = 'td-parity-signing-secret';
Object.assign(process.env, { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'td-parity-service-role', NFL_SESSION_SIGNING_SECRET: SECRET, NFL_OWNER_EMAILS: 'owner@td.test', PICKS_ENGINE_URL: 'https://engine.test', NFL_GATEWAY: 'https://gateway.test' });
const { handle, default: worker } = await import('../workers/nfl-touchdown-targets-api/src/contract.js');
const VERCEL = new URL('../api/pbe-touchdown-targets.js', import.meta.url);
const hasVercel = existsSync(VERCEL);
const vercelHandler = hasVercel ? (await import(VERCEL.href)).default : null;
const { SESSION_COOKIE, HMAC_NAMESPACE } = await import('../api/_nfl-auth.js');

/* ---- one shared fake of the data ------------------------------------------- */
const KICK = '2026-09-27T17:00:00.000Z';
const snap = (name, espn, prob) => ({ player: { name, espn_id: espn, gsis_id: '00-0040715', position: 'RB', team: 'NYG', opponent: 'TEN', at_home: true }, event: { espn_id: '401872956' }, probability: { model: prob, components: { role: { available: true, delta: 0.05 }, script: { available: true, delta: 0.03, bucket: 'favored' }, weather: { available: false } } } });
const PICKS = [
  { id: '11111111-1111-4111-8111-111111111111', event_id: 'e1', season: 2026, week: 3, kickoff_ts: KICK, player_name: 'Cam Skattebo', player_key: 'cam skattebo', market: 'player_anytime_td', side: 'YES', book: 'DraftKings', book_key: 'draftkings', market_price: 120, opposite_price: -150, model_prob: 0.4041, market_prob: 0.43, edge_pct: -2.6, ev_pct: -4, confidence_bucket: 'tracking', target_rank: 'primary', projection_model_version: 'pbe-td-hazard-v1', selector_version: 2, phase: 'early_bird', publication_scope: 'tracking', status: 'open', created_at: '2026-09-26T00:30:05Z', closed_at: null, model_snapshot: snap('Cam Skattebo', '4696981', 0.4041) },
  { id: '22222222-2222-4222-8222-222222222222', event_id: 'e0', season: 2026, week: 2, kickoff_ts: '2026-09-20T17:00:00Z', player_name: 'Graded Guy', player_key: 'graded guy', market: 'player_anytime_td', side: 'YES', book: 'FanDuel', book_key: 'fanduel', market_price: 150, opposite_price: -190, model_prob: 0.36, market_prob: 0.38, edge_pct: -2, ev_pct: -1, confidence_bucket: 'tracking', target_rank: 'primary', projection_model_version: 'pbe-td-hazard-v1', selector_version: 2, phase: 'locked', publication_scope: 'tracking', status: 'graded', created_at: '2026-09-19T12:00:00Z', closed_at: '2026-09-21T00:00:00Z', model_snapshot: snap('Graded Guy', '1', 0.36) },
];
const EVALS = [{ id: 1, market: 'player_anytime_td', event_id: 'e1', game_id: '2026_03_TEN_NYG', espn_id: '401872956', season: 2026, week: 3, kickoff_ts: KICK, away_team: 'TEN', home_team: 'NYG', outcome: 'target_issued', reason: null, primary_pick_id: PICKS[0].id, secondary_pick_id: null, market_selections: 23, eligible_pool: 23, top_probability: 0.4041, selector_version: 2, publication_scope: 'tracking', detail: {}, decided_at: '2026-09-26T00:30:05Z' }];
const RECEIPTS = PICKS.map((p, i) => ({ seq: 50 + i, pick_id: p.id, issued_at: p.created_at, receipt_version: 'pbe-td-target-issuance-v1', payload_sha256: 'a'.repeat(64), previous_chain_hash: 'b'.repeat(64), chain_hash: 'c'.repeat(64) }));
const GRADES = [{ pick_id: PICKS[1].id, final_value: 1, result: 'win', units_delta: 1.5, clv_prob: 0.01, clv_beat: true, brier: 0.41, source: 'espn_box', graded_at: '2026-09-21T01:00:00Z', result_definition: 'pbe_offensive_td_from_final_box_score', non_offensive_td: false, settlement_note: null }];
const SELECTOR = [{ version: 2, market: 'player_anytime_td', projection_model: 'pbe-td-hazard-v1', config: { primary_min_prob: 0.22 }, trained: false, promoted: true, training_rows: 0, trained_through_week: null, backtest_brier: null, backtest_units: null, notes: 'seed', created_at: '2026-09-26T00:00:00Z', promoted_at: null }];
const RUNS = { generated_at: '2026-09-26T01:00:00Z', lanes: ['nfl-touchdown-targets-orchestrator', 'nfl-odds-snapshot', 'nfl-touchdown-targets-grader'].map(lane => ({ lane, label: lane, critical: true, state: 'HEALTHY', reason: null, last_tick: null, last_work: null, last_ok_at: null, last_error: null })) };
const SEASON = { season: 2026, current_week: 3, season_type: 'REG', next_game: { name: 'LAC @ BUF', kickoff: KICK, semantics: 'SCHEDULE' } };

const reads = [];
let supabaseDown = false;
function answer(url) {
  const u = new URL(url);
  if (u.pathname.endsWith('/v1/engine/runs')) return RUNS;
  if (u.pathname.endsWith('/api/season')) return SEASON;
  if (u.origin !== SB) throw new Error(`unexpected fetch ${url}`);
  const table = u.pathname.split('/').pop();
  reads.push(table);
  if (supabaseDown) return { __status: 503 };
  const q = decodeURIComponent(u.search);
  if (table === 'nfl_prop_selector_models') return SELECTOR;
  if (table === 'nfl_prop_learning_observations') return [];
  if (table === 'nfl_prop_pick_audit_events') return [];
  if (table === 'nfl_td_final_pregame_evaluation') return EVALS;
  if (table === 'nfl_prop_pick_grades') return GRADES;
  if (table === 'nfl_prop_pick_receipts') return RECEIPTS;
  if (table === 'nfl_prop_picks') {
    const m = /status=in\.\(([^)]*)\)/.exec(q);
    const allowed = m ? m[1].split(',') : null;
    return PICKS.filter(p => !allowed || allowed.includes(p.status));
  }
  return [];
}
const respond = body => (body?.__status ? new Response('{}', { status: body.__status }) : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
globalThis.fetch = async (url) => respond(answer(String(url instanceof Request ? url.url : url)));
const binding = { fetch: async req => respond(answer(req.url)) };

/* The Worker's session authority, answering as the auth Worker would. */
let verdict = { valid: false, pro: false, signed_in: false, access: 'anonymous', degraded: false, stage: 'no_cookie' };
const authCalls = [];
const AUTH = { fetch: async req => { authCalls.push(await req.json()); return new Response(JSON.stringify(verdict), { status: 200 }); } };
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'td-parity-service-role', NFL_AUTH_INTERNAL_TOKEN: 'i'.repeat(40), AUTH, NFL_CURRENT: binding, PICKS_ENGINE: binding };

const b64u = v => Buffer.from(v).toString('base64url');
const ownerCookie = () => { const now = Math.floor(Date.now() / 1000); const d = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ type: 'session', email: 'owner@td.test', iat: now, exp: now + 3600 }))}`; return `${SESSION_COOKIE}=${d}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${SECRET}`).update(d).digest())}`; };

async function viaVercel(view, { cookie = null, query = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await vercelHandler({ method: 'GET', query: { view, ...query }, headers: cookie ? { cookie } : {} }, res);
  return { status: res.statusCode, body: JSON.parse(res.body), cache: res.headers['cache-control'] };
}
async function viaWorker(view, { cookie = null, query = {}, method = 'GET', env = ENV } = {}) {
  const u = new URL('https://nfl.propbetedge.ai/api/pbe-touchdown-targets');
  u.searchParams.set('view', view);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const r = await handle(new Request(u, { method, headers: cookie ? { cookie } : {} }), env);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, cache: r.headers.get('cache-control'), servedBy: r.headers.get('x-pbe-served-by') };
}
/* Timestamps that legitimately differ between two calls. */
const normalize = body => JSON.parse(JSON.stringify(body, (k, v) => (['checked_at', 'generated_at', 'served_at'].includes(k) ? '<time>' : v)));

for (const [view, opts] of [['state', {}], ['trackrecord', {}], ['model', {}], ['current', { owner: true }], ['week', { owner: true, query: { season: '2026', week: '3' } }]]) {
  test(`parity · view=${view}${opts.owner ? ' (owner session)' : ''}`, { skip: !hasVercel && 'Vercel function retired' }, async () => {
    verdict = opts.owner ? { valid: true, pro: true, signed_in: true, role: 'owner', access: 'granted', degraded: false, stage: 'owner_verified' } : verdict;
    const cookie = opts.owner ? ownerCookie() : null;
    const [old, neu] = [await viaVercel(view, { cookie, query: opts.query || {} }), await viaWorker(view, { cookie, query: opts.query || {} })];
    assert.equal(neu.status, old.status);
    assert.deepEqual(normalize(neu.body), normalize(old.body));
    assert.equal(neu.cache, old.cache);
    if (opts.owner) {
      /* The fake serves both fixture targets for any week: one open, one graded. */
      assert.equal(neu.body.games.length, 1);
      assert.equal(neu.body.games[0].outcome, 'target_issued');
      assert.equal(neu.body.games[0].primary.player.name, 'Cam Skattebo');
      assert.deepEqual([neu.body.counts.primary_targets, neu.body.counts.pending, neu.body.counts.hit], [2, 1, 1]);
    }
  });
}

test('parity · anonymous current/week are 401 on both, with no games payload', { skip: !hasVercel && 'Vercel function retired' }, async () => {
  for (const view of ['current', 'week']) {
    verdict = { valid: false, pro: false, signed_in: false, access: 'anonymous', degraded: false, stage: 'no_cookie' };
    const [old, neu] = [await viaVercel(view), await viaWorker(view)];
    assert.deepEqual([neu.status, neu.body], [old.status, old.body]);
    assert.equal(neu.status, 401);
  }
});

/* ---- the Worker's own boundary -------------------------------------------------- */

const noRowRead = () => !reads.some(t => ['nfl_prop_picks', 'nfl_td_final_pregame_evaluation', 'nfl_prop_pick_receipts', 'nfl_prop_pick_grades'].includes(t));

test('gated views: 401 anonymous, 403 signed-in non-Pro, 503 authority unavailable — each before any target row is read', async () => {
  for (const [v, status, error, cookie] of [
    [{ valid: false, pro: false, signed_in: false, access: 'anonymous', degraded: false, stage: 'cookie_present_invalid' }, 401, 'sign_in_required', 'pbe_nfl_session_v2=forged'],
    [{ valid: true, pro: false, signed_in: true, access: 'no_entitlement', degraded: false, stage: 'entitlement_missing' }, 403, 'nfl_pro_required', 'pbe_nfl_session_v2=free'],
    [{ valid: true, pro: false, signed_in: true, access: 'unavailable', degraded: true, stage: 'entitlement_lookup_failed' }, 503, 'entitlement_unavailable', 'pbe_nfl_session_v2=x'],
  ]) {
    for (const view of ['current', 'week']) {
      verdict = v; reads.length = 0;
      const r = await viaWorker(view, { cookie });
      assert.equal(r.status, status, `${view} ${v.access}`);
      assert.equal(r.body.error, error);
      assert.ok(!('games' in r.body));
      assert.equal(r.cache, 'private, no-store, max-age=0');
      assert.ok(noRowRead(), `${view} ${v.access}: no proprietary row was read`);
    }
  }
});

test('only the session cookie values reach the authority, current cookie first; no cookie asks nobody', async () => {
  authCalls.length = 0;
  verdict = { valid: true, pro: true, signed_in: true, role: 'owner', access: 'granted', degraded: false, stage: 'owner_verified' };
  await viaWorker('current', { cookie: 'other=1; pbe_nfl_session=legacy-t; pbe_nfl_session_v2=current-t; ga=2' });
  assert.deepEqual(authCalls.at(-1), { tokens: ['current-t', 'legacy-t'] });
  authCalls.length = 0;
  await viaWorker('current');
  assert.equal(authCalls.length, 0);
});

test('a session authority that cannot answer is 503, never a grant', async () => {
  reads.length = 0;
  const down = { ...ENV, AUTH: { fetch: async () => new Response('boom', { status: 500 }) } };
  const r = await viaWorker('current', { cookie: 'pbe_nfl_session_v2=t', env: down });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'entitlement_unavailable');
  assert.ok(noRowRead());
  const unconfigured = await viaWorker('current', { cookie: 'pbe_nfl_session_v2=t', env: { ...ENV, NFL_AUTH_INTERNAL_TOKEN: '' } });
  assert.equal(unconfigured.status, 503);
});

test('public views stay public and the record stays graded-only', async () => {
  verdict = { valid: false, pro: false, signed_in: false, access: 'anonymous', degraded: false, stage: 'no_cookie' };
  const state = await viaWorker('state');
  assert.equal(state.status, 200); assert.equal(state.body.engine_health, 'HEALTHY');
  assert.ok(!JSON.stringify(state.body).includes('Cam Skattebo'), 'state carries no player');
  const record = await viaWorker('trackrecord');
  assert.equal(record.status, 200);
  assert.deepEqual(record.body.targets.map(t => t.player?.name ?? t.player_name), ['Graded Guy'], 'the open target never leaves through the record');
  assert.match(record.cache, /public/);
  assert.equal((await viaWorker('model')).status, 200);
  assert.equal(state.servedBy, 'nfl-touchdown-targets-api/v1.0.0');
});

test('a failed backend is 503 ENGINE DEGRADED, never an empty slate', async () => {
  supabaseDown = true;
  try {
    const r = await viaWorker('trackrecord');
    assert.equal(r.status, 503); assert.equal(r.body.engine_state, 'ENGINE DEGRADED — SOURCE UNAVAILABLE');
    assert.ok(!('targets' in r.body));
  } finally { supabaseDown = false; }
  const noSecret = await viaWorker('state', { env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' } });
  assert.equal(noSecret.status, 503);
});

test('GET and HEAD only; other paths 404; health reports configuration, never values', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await viaWorker('state', { method })).status, 405);
  const head = await handle(new Request('https://nfl.propbetedge.ai/api/pbe-touchdown-targets?view=model', { method: 'HEAD' }), ENV);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await worker.fetch(new Request('https://nfl.propbetedge.ai/api/other'), ENV)).status, 404);
  const health = await (await worker.fetch(new Request('https://x/health'), ENV)).json();
  assert.equal(health.requirements.SUPABASE_SERVICE_ROLE_KEY, true);
  assert.ok(!JSON.stringify(health).includes('td-parity-service-role'));
});
