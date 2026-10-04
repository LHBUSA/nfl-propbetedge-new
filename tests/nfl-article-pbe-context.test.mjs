/* view=game on /api/pbe-picks and the cross-origin read for the propbetedge.ai
 * news Article Market module (propbetedge-workers propsports-markets
 * client/article-market-ui.js pbeContext).
 *
 * The REAL handler, the REAL session verifier and the REAL publication rules;
 * fakes only at the network edge (nfl-current, the run ledger, PostgREST).
 *
 * The game is JAX @ CIN (2026_04_JAX_CIN, ESPN 401872969) but the decision
 * rows are SYNTHETIC: this repository is public and the real rows are NFL Pro
 * data. Their receipts are built here with the production receipt scheme
 * (payload::text digest + chain link), so verifyReceipt() runs for real. The
 * exact production numbers are pinned in the private propbetedge-workers
 * fixture instead. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

const SECRET = 'article-pbe-signing-secret';
const SUPABASE = 'https://supabase.article-pbe.test';
const GATEWAY = 'https://gateway.article-pbe.test';
const ENGINE = 'https://engine.article-pbe.test';
Object.assign(process.env, {
  SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'article-pbe-service-role', NFL_SESSION_SIGNING_SECRET: SECRET,
  NFL_OWNER_EMAILS: 'owner@article-pbe.test', NFL_GATEWAY: GATEWAY, PICKS_ENGINE_URL: ENGINE,
});
const { HMAC_NAMESPACE, SESSION_COOKIE } = await import('../api/_nfl-auth.js');
const { default: handler } = await import('../api/pbe-picks.js');
const { default: tdHandler } = await import('../api/pbe-touchdown-targets.js');
const { SELECTION_FIELDS, LABELS } = await import('../workers/nfl-picks-engine-shared/publication.mjs');

const ESPN = '401872969';
const GAME = '2026_04_JAX_CIN';
const KICK = '2026-10-04T17:00:00+00:00';
const sha = text => createHash('sha256').update(text).digest('hex');

function decision({ id, market, side, team, line, price, prob, created }) {
  return {
    id, game_id: GAME, season: 2026, week: 4, kickoff_ts: KICK, market, side, market_line: line, market_price: price,
    model_line: null, model_prob: prob, market_prob: 0.5, edge_pct: 0.04, stake_units: 1, confidence_bucket: 'medium',
    model_version: 7, selection_team: team, selection_over_under: null, side_is_home: true, status: 'open', superseded_by: null,
    created_at: created, created_text: created.replace('T', ' ').replace('Z', '+00'), publication_scope: 'tracking',
    integrity_status: 'eligible', integrity_reason: null, features: {},
  };
}
const TERMS = [
  ['pick_id', 'id'], ['game_id', 'game_id'], ['season', 'season'], ['week', 'week'], ['kickoff_ts', 'kickoff_ts'],
  ['issued_at', 'created_at'], ['market', 'market'], ['side', 'side'], ['market_line', 'market_line'],
  ['market_price', 'market_price'], ['model_line', 'model_line'], ['model_prob', 'model_prob'], ['market_prob', 'market_prob'],
  ['edge_pct', 'edge_pct'], ['stake_units', 'stake_units'], ['confidence_bucket', 'confidence_bucket'],
  ['model_version', 'model_version'], ['publication_scope', 'publication_scope'], ['selection_team', 'selection_team'],
  ['selection_over_under', 'selection_over_under'], ['side_is_home', 'side_is_home'],
];
function receiptFor(row, seq) {
  const payload_text = JSON.stringify(Object.fromEntries(TERMS.map(([k, r]) => [k, row[r]])));
  const payload_sha256 = sha(payload_text);
  const previous_chain_hash = null;
  return {
    seq, pick_id: row.id, issued_at: row.created_at, publication_scope: row.publication_scope, receipt_version: 1,
    payload_sha256, previous_chain_hash, chain_hash: sha(`GENESIS:${payload_sha256}:${row.created_text}:${row.id}`), payload_text,
  };
}
const ML = decision({ id: '00000000-0000-4000-8000-0000000000a1', market: 'moneyline', side: 'CIN ML', team: 'CIN', line: null, price: -120, prob: 0.6, created: '2026-09-30T09:00:47.000Z' });
const SPREAD = decision({ id: '00000000-0000-4000-8000-0000000000a2', market: 'spread', side: 'CIN -1.5', team: 'CIN', line: -1.5, price: -110, prob: 0.55, created: '2026-09-30T09:00:46.000Z' });
const ROWS = [ML, SPREAD];
const RECEIPTS = [receiptFor(ML, 1), receiptFor(SPREAD, 2)];

const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  seen.push(decodeURIComponent(u.pathname + u.search));
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (u.origin === GATEWAY && u.pathname === '/api/season') return json({ season: 2026, current_week: 4 });
  if (u.origin === GATEWAY && u.pathname === '/api/scores') return json({ games: [{ game_id: ESPN, season: 2026, game_type: 'REG', week: 4, kickoff: '2026-10-04T17:00Z', away_team: 'JAX', home_team: 'CIN', away_score: 22, home_score: 10, semantics: 'LIVE', detail: '6:35 - 4th Quarter' }] });
  if (u.origin === ENGINE) return json({ lanes: [{ lane: 'nfl-game-picks-orchestrator', critical: true, state: 'HEALTHY' }, { lane: 'nfl-odds-snapshot', critical: true, state: 'HEALTHY' }, { lane: 'nfl-game-grader', critical: true, state: 'HEALTHY' }] });
  if (u.origin === SUPABASE) {
    const table = u.pathname.split('/').pop();
    if (table === 'nfl_game_picks') return json(u.search.includes(`game_id=eq.${GAME}`) ? ROWS : []);
    if (table === 'nfl_pick_receipts') return json(RECEIPTS);
    if (table === 'nfl_pick_audit_events') return json([]);
    if (table === 'nfl_pick_grades') return json([]);
    if (table === 'nfl_customers' || table === 'nfl_entitlements') return json([]);
    return json([]);
  }
  return realFetch(url);
};
test.after(() => { globalThis.fetch = realFetch; });

const b64u = v => Buffer.from(v).toString('base64url');
function mint(email) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ type: 'session', email, exp: Math.floor(Date.now() / 1000) + 3600 }))}`;
  return `${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${SECRET}`).update(data).digest())}`;
}
function res() {
  return { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
}
async function call(fn, { email = null, origin = 'https://propbetedge.ai', query = { view: 'game', game_id: ESPN } } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (email) headers.cookie = `${SESSION_COOKIE}=${mint(email)}`;
  const r = res();
  await fn({ method: 'GET', headers, query }, r);
  return { r, body: JSON.parse(r.body) };
}
const keysDeep = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};

test('owner: every eligible decision on the one game, labelled by its own scope, never relabelled OFFICIAL', async () => {
  const { r, body } = await call(handler, { email: 'owner@article-pbe.test' });
  assert.equal(r.statusCode, 200);
  assert.equal(body.view, 'game');
  assert.equal(body.access, 'pro');
  assert.equal(body.count, 2);
  const byMarket = Object.fromEntries(body.picks.map(p => [p.market, p]));
  assert.deepEqual(Object.keys(byMarket).sort(), ['moneyline', 'spread']);
  for (const p of body.picks) {
    assert.equal(p.publication_scope, 'tracking');
    assert.equal(p.label, LABELS.tracking.label);
    assert.equal(p.record, 'validation_history');
    assert.equal(p.lifecycle, 'LOCKED');
    assert.equal(p.game.espn_id, ESPN);
    assert.equal(p.receipt.verified.payload_hash, true);
  }
  assert.equal(byMarket.moneyline.selection.display, 'CIN ML');
  assert.equal(byMarket.moneyline.model.prob, 0.6);
  assert.equal(byMarket.spread.selection.display, 'CIN -1.5');
  assert.match(r.headers['cache-control'], /private, no-store/);
});

for (const [who, email] of [['anonymous', null], ['signed-in without NFL entitlement', 'free@article-pbe.test']]) {
  test(`${who}: existence and scope only — no team, line, price, probability or id leaves the server`, async () => {
    const { r, body } = await call(handler, { email });
    assert.equal(r.statusCode, 200);
    assert.equal(body.access, 'locked');
    assert.equal(body.access_reason, email ? 'no_entitlement' : 'anonymous');
    assert.equal(body.count, 2);
    assert.equal('picks' in body, false);
    assert.deepEqual(body.previews.map(p => p.publication_scope), ['tracking', 'tracking']);
    for (const key of keysDeep(body)) assert.equal(SELECTION_FIELDS.includes(key), false, `leaked ${key}`);
    const text = r.body;
    for (const needle of ['CIN ML', 'CIN -1.5', '0.6', '-120', '-110', ML.id, SPREAD.id]) assert.equal(text.includes(needle), false, `leaked ${needle}`);
  });
}

test('cross-origin: only the exact news origins get credentialed CORS; Vary keeps answers per reader', async () => {
  for (const origin of ['https://propbetedge.ai', 'https://www.propbetedge.ai']) {
    const { r } = await call(handler, { origin });
    assert.equal(r.headers['access-control-allow-origin'], origin);
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.match(r.headers.vary, /Origin/);
    assert.match(r.headers.vary, /Cookie/);
  }
  for (const origin of ['https://evil.example', 'https://propbetedge.ai.evil.example', 'http://propbetedge.ai', null]) {
    const { r } = await call(handler, { origin });
    assert.equal(r.headers['access-control-allow-origin'], undefined, String(origin));
    assert.equal(r.headers['access-control-allow-credentials'], undefined, String(origin));
  }
  const td = await call(tdHandler, { origin: 'https://propbetedge.ai' });
  assert.equal(td.r.headers['access-control-allow-origin'], 'https://propbetedge.ai');
  assert.equal(td.r.headers['access-control-allow-credentials'], 'true');
});

test('CORS is view=game only: the full Pro card is never readable cross-origin', async () => {
  for (const view of ['current', 'validation-history', 'decision', 'preview', 'state']) {
    const { r } = await call(handler, { email: 'owner@article-pbe.test', query: { view } });
    assert.equal(r.headers['access-control-allow-origin'], undefined, view);
  }
  const td = await call(tdHandler, { email: 'owner@article-pbe.test', query: { view: 'current' } });
  assert.equal(td.r.headers['access-control-allow-origin'], undefined);
});

test('an unknown or malformed game is honest: 400 for a bad id, evaluated:false for a game not on the schedule', async () => {
  assert.equal((await call(handler, { query: { view: 'game', game_id: 'JAX-CIN' } })).r.statusCode, 400);
  const { body } = await call(handler, { email: 'owner@article-pbe.test', query: { view: 'game', game_id: '401999999' } });
  assert.equal(body.evaluated, false);
  assert.deepEqual(body.picks, []);
});
