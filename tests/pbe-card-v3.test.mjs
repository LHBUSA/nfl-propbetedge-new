/* PBE Picks V3 — publication contract.
 *
 * Two layers, both exercised here:
 *   1. the pure rules (workers/nfl-picks-engine-shared/publication.mjs)
 *   2. the real read handler (api/pbe-picks.js) against a mocked Supabase,
 *      gateway and run ledger, with session cookies minted exactly the way the
 *      auth Worker signs them.
 *
 * Every leak assertion is paired with a proof that it can fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.NFL_SESSION_SIGNING_SECRET = 'test-session-signing-secret';
process.env.NFL_GATEWAY = 'https://gateway.test';
process.env.PICKS_ENGINE_URL = 'https://engine.test';

const P = await import('../workers/nfl-picks-engine-shared/publication.mjs');
const { default: handler } = await import('../api/pbe-picks.js');
const { HMAC_NAMESPACE, SESSION_COOKIE } = await import('../api/_nfl-auth.js');

/* ------------------------------------------------------------------------
 * Fixtures: one real-shaped week-1 slate
 * --------------------------------------------------------------------- */
const NOW = Date.parse('2026-09-12T12:00:00Z');
/* The handler reads the clock; pin it so lifecycle is deterministic on any day. */
Date.now = () => NOW;
const sha = text => createHash('sha256').update(text).digest('hex');

function pick(over) {
  return {
    game_id: '2026_01_BUF_HOU', season: 2026, week: 1, kickoff_ts: '2026-09-13T17:00:00+00:00',
    market: 'spread', side: 'BUF -2.5', market_line: -2.5, market_price: -110,
    model_line: -4.12, model_prob: 0.5471, market_prob: 0.5, edge_pct: 0.0471, stake_units: 1.2345,
    confidence_bucket: 'B', model_version: 1, selection_team: 'BUF', selection_over_under: null, side_is_home: false,
    status: 'open', superseded_by: null, created_at: '2026-09-11T17:30:52.577+00:00', publication_scope: 'tracking',
    features: { home: 0, dome: 1, wind15: 0, cold25: 0, rest_diff: 0, line_move: -0.5, prior_blend_weight: 0.8, off_epa_diff: 0.02 },
    created_text: '2026-09-11 17:30:52.577+00',
    ...over,
  };
}

const ROWS = [
  pick({ id: '11111111-1111-4111-8111-111111111111' }),                                              // A active spread
  pick({ id: '00000000-0000-4000-8000-000000000000', side: 'HOU +2.5', market_line: 2.5, selection_team: 'HOU', side_is_home: true,
    status: 'superseded', superseded_by: '11111111-1111-4111-8111-111111111111', created_at: '2026-09-11T13:00:10+00:00', created_text: '2026-09-11 13:00:10+00' }), // A0 superseded
  pick({ id: '22222222-2222-4222-8222-222222222222', game_id: '2026_01_MIA_LV', kickoff_ts: '2026-09-13T20:25:00+00:00', market: 'total',
    side: 'OVER 44.5', market_line: 44.5, market_price: -108, model_line: 44.5, selection_team: null, selection_over_under: 'OVER',
    side_is_home: null, edge_pct: 0.031, confidence_bucket: 'C', model_prob: 0.5412, market_prob: 0.5102, stake_units: 0.9 }),  // B active total
  pick({ id: '33333333-3333-4333-8333-333333333333', game_id: '2026_01_NO_DET', market: 'moneyline', side: 'NO', market_line: null,
    market_price: 185, selection_team: 'NO', side_is_home: false, status: 'graded', model_line: 150, edge_pct: 0.041 }),         // C killed then stamped graded
  pick({ id: '44444444-4444-4444-8444-444444444444', game_id: '2026_01_NE_SEA', kickoff_ts: '2026-09-10T00:20:00+00:00',
    side: 'SEA -1.5', market_line: -1.5, selection_team: 'SEA', side_is_home: true, status: 'graded' }),                        // D final
  pick({ id: '55555555-5555-4555-8555-555555555555', game_id: '2026_01_SF_LA', kickoff_ts: '2026-09-12T11:00:00+00:00',
    side: 'SF -3', market_line: -3, selection_team: 'SF', side_is_home: false }),                                               // E locked (kicked off)
  pick({ id: '66666666-6666-4666-8666-666666666666', game_id: '2026_01_CHI_CAR', kickoff_ts: '2026-09-13T17:00:00+00:00',
    side: 'CAR +1', market_line: 1, selection_team: 'CAR', side_is_home: true }),                                               // G tampered receipt
  pick({ id: '77777777-7777-4777-8777-777777777777', game_id: '2025_18_BUF_NYJ', season: 2026, week: 0, status: 'graded' }),  // F other week final
];

function receiptFor(row, tamper = {}) {
  const payload = {
    pick_id: row.id, issued_at: row.created_at, game_id: row.game_id, season: row.season, week: row.week,
    kickoff_ts: row.kickoff_ts, market: row.market, side: row.side, market_line: row.market_line,
    market_price: row.market_price, model_line: row.model_line, model_prob: row.model_prob, market_prob: row.market_prob,
    edge_pct: row.edge_pct, stake_units: row.stake_units, confidence_bucket: row.confidence_bucket,
    model_version: row.model_version, publication_scope: row.publication_scope, selection_team: row.selection_team,
    selection_over_under: row.selection_over_under, side_is_home: row.side_is_home, features: row.features, ...tamper,
  };
  const text = JSON.stringify(payload);
  const payloadHash = sha(text);
  const prev = 'a'.repeat(64);
  return {
    seq: 100, pick_id: row.id, issued_at: row.created_at, publication_scope: row.publication_scope,
    receipt_version: 'pbe-issuance-v1', payload_sha256: payloadHash, previous_chain_hash: prev,
    chain_hash: sha(`${prev}:${payloadHash}:${row.created_text}:${row.id}`), payload_text: text,
  };
}
/* G's receipt froze a different price than the row now carries. */
const RECEIPTS = ROWS.map(r => r.id.startsWith('6666') ? receiptFor(r, { market_price: -120 }) : receiptFor(r));

const AUDITS = [
  { pick_id: '11111111-1111-4111-8111-111111111111', event_type: 'pick_created', occurred_at: '2026-09-11T17:30:53Z', detail: { side: 'BUF -2.5' } },
  { pick_id: '00000000-0000-4000-8000-000000000000', event_type: 'pick_superseded', occurred_at: '2026-09-11T17:30:53Z', detail: {} },
  { pick_id: '33333333-3333-4333-8333-333333333333', event_type: 'pick_killed', occurred_at: '2026-09-11T22:00:00Z', detail: { reason: 'edge_collapsed', edge_pct: 0.004 } },
  { pick_id: '44444444-4444-4444-8444-444444444444', event_type: 'first_grade', occurred_at: '2026-09-10T04:00:00Z', detail: {} },
];
const GRADES = [
  { pick_id: '44444444-4444-4444-8444-444444444444', graded_at: '2026-09-10T04:00:00Z', result: 'win', units_delta: 1.1223, clv_points: 0.5, clv_prob: 0.012, clv_beat: true, brier: 0.2 },
  { pick_id: '33333333-3333-4333-8333-333333333333', graded_at: '2026-09-12T04:00:00Z', result: 'void', units_delta: 0, clv_points: null, clv_prob: null, clv_beat: null, brier: null },
];
const TAPE = [
  { game_id: '2026_01_BUF_HOU', captured_at: '2026-09-11T17:00:22+00:00', book: 'draftkings', market: 'spread', line: -2.5, price: -110, is_closing: false, team: 'BUF', over_under: null, is_home: false },
  { game_id: '2026_01_BUF_HOU', captured_at: '2026-09-11T17:00:22+00:00', book: 'draftkings', market: 'spread', line: 2.5, price: -110, is_closing: false, team: 'HOU', over_under: null, is_home: true },
  { game_id: '2026_01_BUF_HOU', captured_at: '2026-09-12T12:00:05+00:00', book: 'consensus:2', market: 'spread', line: -3.5, price: -105, is_closing: false, team: 'BUF', over_under: null, is_home: false },
  { game_id: '2026_01_BUF_HOU', captured_at: '2026-09-12T12:00:05+00:00', book: 'consensus:2', market: 'spread', line: 3.5, price: -115, is_closing: false, team: 'HOU', over_under: null, is_home: true },
];

/* ------------------------------------------------------------------------
 * 1. Pure rules
 * --------------------------------------------------------------------- */
async function verifiedMap(rows = ROWS, receipts = RECEIPTS) {
  const byId = new Map(receipts.map(r => [r.pick_id, r]));
  const out = new Map();
  for (const row of rows) out.set(row.id, await P.verifyReceipt(row, byId.get(row.id)));
  return out;
}
const KILLED = new Set(['33333333-3333-4333-8333-333333333333']);

test('eligibility: superseded, withdrawn, other-week and tampered rows never become current picks', async () => {
  const verified = await verifiedMap();
  const { current, withdrawn, excluded } = P.eligibleDecisions(ROWS, { nowMs: NOW, killedIds: KILLED, verified, season: 2026, week: 1 });
  const ids = current.map(c => c.row.id.slice(0, 4));
  assert.deepEqual(ids.sort(), ['1111', '2222', '4444', '5555']);
  assert.equal(current.find(c => c.row.id.startsWith('1111')).lifecycle, 'ACTIVE');
  assert.equal(current.find(c => c.row.id.startsWith('5555')).lifecycle, 'LOCKED');
  assert.equal(current.find(c => c.row.id.startsWith('4444')).lifecycle, 'FINAL');
  assert.equal(excluded.superseded, 1);
  assert.equal(excluded.withdrawn, 1);
  assert.equal(excluded.receipt_unverified, 1);
  assert.equal(excluded.stale_final, 1);
  assert.deepEqual(withdrawn.map(w => w.row.id.slice(0, 4)), ['3333']);
});

test('killed semantics: a killed row stamped graded/void by the grader is still WITHDRAWN, never FINAL', () => {
  const c = ROWS.find(r => r.id.startsWith('3333'));
  assert.equal(P.lifecycleOf(c, { nowMs: NOW, killedIds: KILLED }), 'WITHDRAWN');
  assert.equal(P.lifecycleOf({ ...c, status: 'killed' }, { nowMs: NOW }), 'WITHDRAWN');
  /* Without the audit event it would read as FINAL — which is why the audit
   * log, not the status column, decides. */
  assert.equal(P.lifecycleOf(c, { nowMs: NOW, killedIds: new Set() }), 'FINAL');
});

test('lock boundary is the kickoff: open + kicked off is LOCKED, open + ahead is ACTIVE', () => {
  const row = ROWS[0];
  assert.equal(P.lifecycleOf(row, { nowMs: Date.parse(row.kickoff_ts) - 1 }), 'ACTIVE');
  assert.equal(P.lifecycleOf(row, { nowMs: Date.parse(row.kickoff_ts) }), 'LOCKED');
});

test('receipt verification: digest, chain link and every issued term', async () => {
  const good = await P.verifyReceipt(ROWS[0], RECEIPTS[0]);
  assert.deepEqual({ ok: good.ok, payload_hash: good.payload_hash, chain: good.chain, terms: good.terms }, { ok: true, payload_hash: true, chain: true, terms: [] });
  const moved = await P.verifyReceipt({ ...ROWS[0], market_line: -3 }, RECEIPTS[0]);
  assert.equal(moved.ok, false); assert.equal(moved.reason, 'issued_terms_mismatch'); assert.deepEqual(moved.terms, ['market_line']);
  const forged = await P.verifyReceipt(ROWS[0], { ...RECEIPTS[0], payload_sha256: 'b'.repeat(64) });
  assert.equal(forged.ok, false); assert.equal(forged.reason, 'payload_hash_mismatch');
  const swapped = await P.verifyReceipt(ROWS[0], RECEIPTS[2]);
  assert.equal(swapped.ok, false); assert.equal(swapped.reason, 'receipt_identity_mismatch');
  const scope = await P.verifyReceipt({ ...ROWS[0], publication_scope: 'official' }, RECEIPTS[0]);
  assert.equal(scope.ok, false);
  assert.equal((await P.verifyReceipt(ROWS[0], null)).reason, 'receipt_missing');
});

test('market since issue uses the persisted tape and the grader\'s CLV sign', () => {
  const m = P.marketSinceIssue(ROWS[0], TAPE, { nowMs: NOW });
  assert.equal(m.available, true);
  assert.equal(m.basis, 'latest_snapshot');
  assert.deepEqual([m.issue.line, m.issue.price], [-2.5, -110]);
  assert.deepEqual([m.current.line, m.current.price], [-3.5, -105]);
  assert.equal(m.line_delta, -1);
  assert.equal(m.clv_points_now, 1);          // BUF -2.5 taken, market now -3.5: issue number is better
  assert.equal(m.direction, 'toward');
  assert.equal(m.line_moved, true);
  assert.ok(m.current.market_prob > 0.48 && m.current.market_prob < 0.5);   // de-vigged -105 / -115
  /* A selection with no tape since issue says so; it never borrows another side. */
  const none = P.marketSinceIssue(ROWS[2], TAPE, { nowMs: NOW });
  assert.equal(none.available, false);
  assert.equal(none.reason, 'no_tape_since_issue');
});

test('why it cleared: threshold checks on persisted terms, flags from the frozen vector, no prose', () => {
  const w = P.whyCleared(ROWS[0]);
  assert.equal(w.source, 'persisted_terms_and_frozen_features');
  const edge = w.checks.find(c => c.key === 'edge');
  assert.equal(edge.threshold_pp, 2); assert.equal(edge.value_pp, 4.71); assert.equal(edge.pass, true);
  assert.equal(w.checks.find(c => c.key === 'confidence').recomputed, 'B');
  assert.ok(w.frozen_flags.some(f => f.key === 'dome'));
  assert.equal(JSON.stringify(w).includes('because'), false);
});

test('labels come from each row, and the official transition needs no redesign', () => {
  assert.equal(P.labelFor('tracking').label, 'PBE VALIDATION SIGNAL');
  assert.match(P.labelFor('tracking').tag, /NOT OFFICIAL CHAMPION RECORD/);
  assert.equal(P.labelFor('official').label, 'OFFICIAL PBE PICK');
  assert.equal(P.displayMode({ health: 'HEALTHY', trained: false }), 'VALIDATION');
  assert.equal(P.displayMode({ health: 'HEALTHY', trained: true }), 'OFFICIAL');
  assert.equal(P.displayMode({ health: 'STALE', trained: true }), 'DEGRADED');
  /* Trained champion: official rows graduate, a still-open bootstrap tracking
   * row keeps its validation label (scope drain), nothing is relabelled. */
  const official = pick({ id: '88888888-8888-4888-8888-888888888888', publication_scope: 'official', model_version: 2, game_id: '2026_02_KC_DEN' });
  const tracking = ROWS[0];
  const cards = [official, tracking].map(row => P.proCard({ row, lifecycle: 'ACTIVE', receipt: receiptFor(row), verification: { terms: [] }, nowMs: NOW, engineHealthy: true, audits: [] }));
  assert.equal(cards[0].label, 'OFFICIAL PBE PICK');
  assert.equal(cards[0].tag, 'OFFICIAL PBE PICK · CHAMPION v2');
  assert.equal(cards[0].record, 'official_track_record');
  assert.equal(cards[1].label, 'PBE VALIDATION SIGNAL');
  assert.equal(cards[1].record, 'validation_history');
});

test('locked preview carries nothing actionable, and the leak guard can fail', () => {
  const preview = P.lockedPreview({ row: ROWS[0], lifecycle: 'ACTIVE' });
  assert.equal(P.assertNoSelection({ previews: [preview] }), true);
  const text = JSON.stringify(preview);
  for (const needle of ['BUF -2.5', '-110', '0.0471', '1.2345', ROWS[0].id, '"B"']) assert.equal(text.includes(needle), false, needle);
  assert.throws(() => P.assertNoSelection({ previews: [{ ...preview, market_price: -110 }] }), /selection_leak/);
  assert.throws(() => P.assertNoSelection({ a: { b: [{ selection: { team: 'BUF' } }] } }), /selection_leak:\$\.a\.b\[0\]\.selection/);
});

test('live progress is derived from the live score only', () => {
  const locked = ROWS.find(r => r.id.startsWith('5555'));               // SF -3 away
  assert.equal(P.progressOf(locked, { state: 'LIVE', away_score: 14, home_score: 7 }).text, 'Covering by 4');
  assert.equal(P.progressOf(locked, { state: 'LIVE', away_score: 10, home_score: 7 }).text, 'On the number');
  assert.equal(P.progressOf(locked, { state: 'SCHEDULE', away_score: 0, home_score: 0 }), null);
  assert.equal(P.progressOf(ROWS[2], { state: 'LIVE', away_score: 20, home_score: 17 }).text, '7.5 points to clear 44.5');
});

/* ------------------------------------------------------------------------
 * 2. The real handler
 * --------------------------------------------------------------------- */
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sessionCookie(email) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ email, type: 'session', iat: now, exp: now + 3600, jti: 't' }))}`;
  const sig = createHmac('sha256', `${HMAC_NAMESPACE}:${process.env.NFL_SESSION_SIGNING_SECRET}`).update(data).digest();
  return `${SESSION_COOKIE}=${data}.${b64u(sig)}`;
}

const requested = [];
let engineDown = false;
let trained = false;
function inIds(query) {
  const m = /pick_id=in\.\(([^)]*)\)/.exec(decodeURIComponent(query));
  return m ? m[1].split(',').map(s => s.replace(/"/g, '')) : [];
}
function reply(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  requested.push(url.toString());
  if (url.host === 'engine.test') {
    if (engineDown) throw new Error('offline');
    return reply({ generated_at: new Date().toISOString(), lanes: [
      { lane: 'nfl-game-picks-orchestrator', critical: true, state: 'HEALTHY', last_work: { finished_at: '2026-09-12T11:45:00Z', status: 'ok' }, last_tick: { finished_at: '2026-09-12T11:45:00Z' } },
      { lane: 'nfl-odds-snapshot', critical: true, state: 'HEALTHY' },
      { lane: 'nfl-game-grader', critical: true, state: 'HEALTHY' },
    ] });
  }
  if (url.host === 'gateway.test') {
    if (url.pathname === '/api/season') return reply({ season: 2026, current_week: 1, season_type: 'REG' });
    if (url.pathname === '/api/scores') return reply({ games: [
      { game_id: '401872657', season: 2026, game_type: 'REG', week: 1, away_team: 'SF', home_team: 'LAR', away_score: 14, home_score: 7, semantics: 'LIVE', detail: 'Q2 4:11' },
    ] });
  }
  if (url.host === 'supabase.test') {
    const table = url.pathname.replace('/rest/v1/', '');
    const q = url.search;
    if (table === 'nfl_subscriptions') {
      if (q.includes('broken')) return reply({ message: 'down' }, 500);
      return reply(q.includes('pro%40') || q.includes('pro@') ? [{ status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] : []);
    }
    if (table === 'nfl_model_weights') return reply([{ version: trained ? 2 : 1, weights: { meta: { trained } }, notes: 'fixture' }]);
    if (table === 'nfl_learning_observations') return reply([{ season: 2026, week: 1, publication_scope: 'tracking' }]);
    if (table === 'nfl_game_picks') {
      if (q.includes('select=season,status,publication_scope,created_at')) return reply(ROWS.map(({ season, status, publication_scope, created_at }) => ({ season, status, publication_scope, created_at })));
      if (decodeURIComponent(q).includes('publication_scope=eq.official')) return reply(ROWS.filter(r => r.publication_scope === 'official'));
      if (decodeURIComponent(q).includes('publication_scope=eq.tracking')) return reply(ROWS.filter(r => ['graded', 'killed'].includes(r.status)));
      return reply(ROWS);
    }
    if (table === 'nfl_pick_receipts') { const ids = inIds(q); return reply(RECEIPTS.filter(r => ids.includes(r.pick_id))); }
    if (table === 'nfl_pick_audit_events') { const ids = inIds(q); return reply(AUDITS.filter(a => ids.includes(a.pick_id))); }
    if (table === 'nfl_pick_grades') { const ids = inIds(q); return reply(GRADES.filter(g => ids.includes(g.pick_id))); }
    if (table === 'nfl_odds_snapshots') { const id = /game_id=eq\.([^&]+)/.exec(q)?.[1]; return reply(TAPE.filter(s => s.game_id === decodeURIComponent(id || ''))); }
  }
  return reply({ error: 'unmocked', url: url.toString() }, 404);
};

async function call(view, cookie = '') {
  const res = {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(text) { this.body = text; },
  };
  await handler({ method: 'GET', query: { view }, headers: cookie ? { cookie } : {} }, res);
  return { status: res.statusCode, headers: res.headers, text: res.body, json: JSON.parse(res.body || 'null') };
}

/* Every actionable value of every tracking row in the fixture. */
const SECRETS = ['BUF -2.5', 'OVER 44.5', '"selection_team"', '"market_price"', '"edge_pct"', '"model_prob"', '"stake_units"', '1.2345', '0.0471', '11111111-1111'];
function assertNoSecrets(text) { for (const s of SECRETS) assert.equal(text.includes(s), false, `leaked ${s}`); }

test('non-Pro cannot retrieve selection fields: anonymous, forged cookie, free account', async () => {
  const anon = await call('current');
  assert.equal(anon.status, 401); assertNoSecrets(anon.text);
  const forged = await call('current', `${SESSION_COOKIE}=eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InByb0B4LmNvbSJ9.AAAA`);
  assert.equal(forged.status, 401); assertNoSecrets(forged.text);
  const free = await call('current', sessionCookie('free@propbetedge.test'));
  assert.equal(free.status, 403); assertNoSecrets(free.text);
  const hist = await call('validation-history', sessionCookie('free@propbetedge.test'));
  assert.equal(hist.status, 403); assertNoSecrets(hist.text);
  /* The secrets list is not vacuous: the Pro response does contain them. */
  const pro = await call('current', sessionCookie('pro@propbetedge.test'));
  assert.equal(pro.text.includes('BUF -2.5'), true);
});

test('degraded entitlement fails closed', async () => {
  const broken = await call('current', sessionCookie('broken@propbetedge.test'));
  assert.equal(broken.status, 503);
  assert.equal(broken.json.error, 'entitlement_unavailable');
  assertNoSecrets(broken.text);
});

test('public preview and state carry no selection data', async () => {
  const preview = await call('preview');
  assert.equal(preview.status, 200);
  assertNoSecrets(preview.text);
  assert.equal(P.assertNoSelection(preview.json), true);
  assert.equal(preview.json.previews.length, 4);
  assert.deepEqual(preview.json.previews.map(p => p.matchup.away).sort(), ['BUF', 'MIA', 'NE', 'SF']);
  assert.equal(preview.json.unlock.cta, "Unlock today's PBE card");
  const state = await call('state');
  assertNoSecrets(state.text);
});

test('Pro receives the real current validation selection, exactly as persisted', async () => {
  const pro = await call('current', sessionCookie('pro@propbetedge.test'));
  assert.equal(pro.status, 200);
  assert.equal(pro.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(pro.json.display_mode, 'VALIDATION');
  assert.equal(pro.json.contract, 'pbe-card-v3');
  const card = pro.json.picks.find(c => c.id === ROWS[0].id);
  const row = ROWS[0];
  assert.equal(card.label, 'PBE VALIDATION SIGNAL');
  assert.equal(card.publication_scope, 'tracking');
  assert.equal(card.record, 'validation_history');
  assert.deepEqual(
    [card.selection.team, card.selection.display, card.issue.line, card.issue.price, card.issue.at, card.model.prob, card.market_prob, card.edge_pct, card.confidence_bucket, card.stake_units, card.model.version, card.model.fair_line],
    [row.selection_team, 'BUF -2.5', row.market_line, row.market_price, row.created_at, row.model_prob, row.market_prob, row.edge_pct, row.confidence_bucket, row.stake_units, row.model_version, row.model_line],
  );
  assert.equal(card.receipt.chain_hash, RECEIPTS[0].chain_hash);
  assert.deepEqual(card.receipt.verified, { payload_hash: true, issued_terms: true, chain_link: true });
  assert.equal(card.actionable, true);
  assert.equal(card.market_since_issue.direction, 'toward');
  assert.equal('features' in card, false);
  assert.equal(pro.text.includes('payload_text'), false);
  assert.equal(pro.text.includes('off_epa_diff'), false);
  /* Superseded never current; killed only as an event; locked carries live progress. */
  assert.equal(pro.json.picks.some(c => c.id.startsWith('0000')), false);
  assert.equal(pro.json.picks.some(c => c.id.startsWith('3333')), false);
  assert.deepEqual(pro.json.withdrawn.map(w => [w.matchup.away, w.market, w.reason]), [['NO', 'moneyline', 'edge_collapsed']]);
  const locked = pro.json.picks.find(c => c.id.startsWith('5555'));
  assert.equal(locked.lifecycle, 'LOCKED');
  assert.equal(locked.game.state, 'LIVE');
  assert.equal(locked.progress.text, 'Covering by 4');
  const final = pro.json.picks.find(c => c.id.startsWith('4444'));
  assert.equal(final.grade.result, 'win');
  assert.equal(pro.json.eligibility.excluded.superseded, 1);
  assert.equal(pro.json.eligibility.excluded.receipt_unverified, 1);
  assert.equal(pro.json.summary.strongest.id, ROWS[0].id);
});

test('degraded engine suppresses actionable framing', async () => {
  engineDown = true;
  try {
    const pro = await call('current', sessionCookie('pro@propbetedge.test'));
    assert.equal(pro.json.display_mode, 'DEGRADED');
    assert.equal(pro.json.picks.some(c => c.actionable), false);
    assert.match(pro.json.engine_state, /DEGRADED/);
  } finally { engineDown = false; }
});

test('the Official Track Record stays official-only; validation history is Pro-only and separate', async () => {
  requested.length = 0;
  const track = await call('trackrecord');
  assert.equal(track.status, 200);
  const pickQueries = requested.filter(u => u.includes('/nfl_game_picks?') && !u.includes('select=season,status,publication_scope,created_at'));
  assert.equal(pickQueries.length, 1);
  assert.match(decodeURIComponent(pickQueries[0]), /publication_scope=eq\.official/);
  assert.equal(track.json.publication_scope, 'official');
  assert.equal(track.json.picks.length, 0);
  assertNoSecrets(track.text);
  const hist = await call('validation-history', sessionCookie('pro@propbetedge.test'));
  assert.equal(hist.status, 200);
  assert.equal(hist.json.record, 'validation_history');
  assert.deepEqual(hist.json.picks.map(p => p.id.slice(0, 4)).sort(), ['4444', '7777']);
  assert.equal(hist.json.withdrawn.length, 1);
  assert.equal(hist.json.picks.every(p => p.label === 'PBE VALIDATION SIGNAL'), true);
});

test('official mode: the contract switches to OFFICIAL from the champion row alone', async () => {
  trained = true;
  try {
    const pro = await call('current', sessionCookie('pro@propbetedge.test'));
    assert.equal(pro.json.display_mode, 'OFFICIAL');
    /* Bootstrap rows still in play keep their validation label. */
    assert.equal(pro.json.picks.every(c => c.label === 'PBE VALIDATION SIGNAL'), true);
  } finally { trained = false; }
});
