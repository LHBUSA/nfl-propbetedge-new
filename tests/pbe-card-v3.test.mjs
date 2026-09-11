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
import {
  ENV, NOW, pick, ROWS, RECEIPTS, AUDITS, GRADES, TAPE, receiptFor, sessionCookie as signCookie, mock, installMockFetch,
} from './fixtures/pbe-card-v3.fixture.mjs';

Object.assign(process.env, ENV);
/* The handler reads the clock; pin it so lifecycle is deterministic on any day. */
Date.now = () => NOW;

const P = await import('../workers/nfl-picks-engine-shared/publication.mjs');
const { default: handler } = await import('../api/pbe-picks.js');
const { HMAC_NAMESPACE, SESSION_COOKIE } = await import('../api/_nfl-auth.js');

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

test('lock boundary is the real kickoff from nfl-current, not a stale frozen kickoff_ts', () => {
  /* Rows issued before the 2026-09-10 fix carry 13:00Z for a 17:00Z (1 PM ET)
   * kickoff. At 14:00Z the engine can still replace the decision: ACTIVE. */
  const row = pick({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kickoff_ts: '2026-09-13T13:00:00+00:00' });
  const game = { kickoff: '2026-09-13T17:00Z', state: 'SCHEDULE' };
  const at14 = Date.parse('2026-09-13T14:00:00Z');
  assert.equal(P.lifecycleOf(row, { nowMs: at14 }), 'LOCKED');                 // what the row alone would say
  assert.equal(P.lifecycleOf(row, { nowMs: at14, game }), 'ACTIVE');           // what is true
  assert.equal(P.lifecycleOf(row, { nowMs: Date.parse('2026-09-13T17:00:00Z'), game }), 'LOCKED');
  assert.equal(P.lifecycleOf(row, { nowMs: at14, game: { ...game, state: 'LIVE' } }), 'LOCKED');
  const card = P.proCard({ row, lifecycle: 'ACTIVE', receipt: receiptFor(row), verification: { terms: [] }, game, nowMs: at14, engineHealthy: true, audits: [] });
  assert.equal(card.kickoff_ts, '2026-09-13T17:00:00.000Z');
  assert.equal(card.kickoff_source, 'nfl-current');
  assert.equal(card.issued_kickoff_ts, '2026-09-13T13:00:00+00:00');
  assert.equal(P.lockedPreview({ row, lifecycle: 'ACTIVE', game }).kickoff_ts, '2026-09-13T17:00:00.000Z');
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
const sessionCookie = email => signCookie(email, { namespace: HMAC_NAMESPACE, cookieName: SESSION_COOKIE });
installMockFetch();

async function callQ(query, cookie = '') {
  const res = {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(text) { this.body = text; },
  };
  await handler({ method: 'GET', query, headers: cookie ? { cookie } : {} }, res);
  return { status: res.statusCode, headers: res.headers, text: res.body, json: JSON.parse(res.body || 'null') };
}

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
  mock.engineDown = true;
  try {
    const pro = await call('current', sessionCookie('pro@propbetedge.test'));
    assert.equal(pro.json.display_mode, 'DEGRADED');
    assert.equal(pro.json.picks.some(c => c.actionable), false);
    assert.match(pro.json.engine_state, /DEGRADED/);
  } finally { mock.engineDown = false; }
});

test('the Official Track Record stays official-only; validation history is Pro-only and separate', async () => {
  mock.requested.length = 0;
  const track = await call('trackrecord');
  assert.equal(track.status, 200);
  const pickQueries = mock.requested.filter(u => u.includes('/nfl_game_picks?') && !u.includes('select=season,status,publication_scope,created_at'));
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
  mock.trained = true;
  try {
    const pro = await call('current', sessionCookie('pro@propbetedge.test'));
    assert.equal(pro.json.display_mode, 'OFFICIAL');
    /* Bootstrap rows still in play keep their validation label. */
    assert.equal(pro.json.picks.every(c => c.label === 'PBE VALIDATION SIGNAL'), true);
  } finally { mock.trained = false; }
});

/* ------------------------------------------------------------------------
 * 3. Signal lifecycle: ACTIVE -> REPLACED -> NEW ACTIVE -> LOCKED -> FINAL
 * --------------------------------------------------------------------- */
const CHAIN = [
  pick({ id: 'c0000000-0000-4000-8000-000000000001', side: 'BUF -2.5', market_line: -2.5, selection_team: 'BUF', side_is_home: false,
    status: 'superseded', superseded_by: 'c0000000-0000-4000-8000-000000000002', created_at: '2026-09-06T14:00:00+00:00', created_text: '2026-09-06 14:00:00+00' }),
  pick({ id: 'c0000000-0000-4000-8000-000000000002', side: 'HOU +3', market_line: 3, market_price: -105, selection_team: 'HOU', side_is_home: true,
    edge_pct: 0.024, confidence_bucket: 'C', stake_units: 0.6, status: 'superseded', superseded_by: 'c0000000-0000-4000-8000-000000000003',
    created_at: '2026-09-09T17:00:00+00:00', created_text: '2026-09-09 17:00:00+00' }),
  pick({ id: 'c0000000-0000-4000-8000-000000000003', side: 'BUF -3.5', market_line: -3.5, market_price: -110, selection_team: 'BUF', side_is_home: false,
    edge_pct: 0.033, confidence_bucket: 'C', stake_units: 0.8, created_at: '2026-09-11T17:30:00+00:00', created_text: '2026-09-11 17:30:00+00' }),
];

test('a replacement carries every frozen decision it replaced, oldest first, never edited', () => {
  const index = P.lineageIndex(CHAIN);
  const chain = P.lineageOf(CHAIN[2], index);
  assert.deepEqual(chain.map(l => l.row.id.slice(-1)), ['1', '2']);
  const game = { kickoff: '2026-09-13T17:00Z', state: 'SCHEDULE' };
  const card = P.proCard({ row: CHAIN[2], lifecycle: 'ACTIVE', receipt: receiptFor(CHAIN[2]), verification: { terms: [] }, game, nowMs: NOW, engineHealthy: true, audits: [],
    lineage: chain, receipts: new Map(CHAIN.map(r => [r.id, receiptFor(r)])), verified: new Map(CHAIN.map(r => [r.id, { payload_hash: true, terms: [], chain: true }])) });
  assert.equal(card.lineage.revision, 3);
  assert.equal(card.lineage.post_lock_changes, 0);
  const [first, second] = card.lineage.replaced;
  /* Original terms preserved exactly as persisted. */
  assert.deepEqual([first.status, first.selection.display, first.issue.line, first.issue.price, first.issue.at, first.model.version, first.receipt.chain_hash],
    ['SIGNAL REPLACED', 'BUF -2.5', -2.5, -110, '2026-09-06T14:00:00+00:00', 1, receiptFor(CHAIN[0]).chain_hash]);
  /* Replacement shown with its own terms, time and receipt. */
  assert.deepEqual([first.replaced_by.selection.display, first.replaced_by.issue.line, first.replaced_by.issue.price, first.replaced_at, first.replaced_by.receipt_chain_hash],
    ['HOU +3', 3, -105, '2026-09-09T17:00:00+00:00', receiptFor(CHAIN[1]).chain_hash]);
  assert.equal(first.graded, false);
  assert.equal(first.before_lock, true);
  assert.equal(first.record, 'validation_history');
  assert.equal(card.lineage.replaces.id, second.id);
  assert.equal(second.replaced_by.selection.display, 'BUF -3.5');
  /* The timeline reads issued -> replaced -> issued -> replaced -> issued. */
  const types = card.events.map(e => e.type);
  assert.deepEqual(types.slice(0, 5), ['NEW_PBE_SIGNAL', 'SIGNAL_SUPERSEDED', 'NEW_PBE_SIGNAL', 'SIGNAL_SUPERSEDED', 'NEW_PBE_SIGNAL']);
});

test('a replacement reason is stated only when the engine rule is provable from the rows', () => {
  const r = P.replacementReason(CHAIN[0], CHAIN[1]);
  assert.deepEqual([r.rule, r.from, r.to, r.new_edge_pp, r.threshold_pp, r.new_stake_units], ['opposite_side_qualified', 'BUF -2.5', 'HOU +3', 2.4, 2, 0.6]);
  assert.equal(P.replacementReason(CHAIN[0], { ...CHAIN[1], edge_pct: 0.015 }), null);            // below threshold: no reason claimed
  assert.equal(P.replacementReason(CHAIN[0], { ...CHAIN[1], stake_units: 0 }), null);             // zero stake: no reason claimed
  assert.equal(P.replacementReason(CHAIN[0], { ...CHAIN[1], selection_team: 'BUF' }), null);      // same side: not the rule
  assert.equal(P.replacementReason(CHAIN[0], null), null);
});

test('lock immutability: any change at or after the real kickoff is reported, never hidden', () => {
  const index = P.lineageIndex(CHAIN);
  const byId = new Map(CHAIN.map(r => [r.id, r]));
  const pre = new Map([['2026_01_BUF_HOU', { kickoff: '2026-09-13T17:00Z' }]]);
  assert.deepEqual(P.lockViolations(CHAIN, { index, games: pre, byId }), []);
  /* Same rows against a kickoff that already happened on 09-10: the 09-11
   * replacement and issuance are breaches and must surface. */
  const past = new Map([['2026_01_BUF_HOU', { kickoff: '2026-09-10T00:00Z' }]]);
  const v = P.lockViolations(CHAIN, { index, games: past, byId });
  /* CHAIN[1] (09-09) was replaced on 09-11, and CHAIN[2] was issued on 09-11. */
  assert.deepEqual(v.map(x => `${x.kind}:${x.id.slice(-1)}`).sort(), ['issued_after_kickoff:3', 'replaced_after_kickoff:2']);
  const late = P.replacedEntry({ row: CHAIN[1], replacedBy: CHAIN[2] }, { game: { kickoff: '2026-09-10T00:00Z' } });
  assert.equal(late.before_lock, false);
  const killed = P.lockViolations([CHAIN[2]], { games: pre, killedAt: new Map([[CHAIN[2].id, '2026-09-13T17:05:00Z']]) });
  assert.deepEqual(killed.map(x => x.kind), ['withdrawn_after_kickoff']);
});

test('handler: the Pro card shows SIGNAL REPLACED with both frozen decisions and receipts', async () => {
  const pro = await call('current', sessionCookie('pro@propbetedge.test'));
  const card = pro.json.picks.find(c => c.id === ROWS[0].id);                  // BUF -2.5 replaced HOU +2.5
  assert.equal(card.lineage.revision, 2);
  const r = card.lineage.replaces;
  assert.deepEqual([r.id, r.selection.display, r.issue.line, r.issue.price, r.issue.at, r.receipt.chain_hash, r.graded],
    [ROWS[1].id, 'HOU +2.5', 2.5, -110, ROWS[1].created_at, RECEIPTS[1].chain_hash, false]);
  assert.equal(r.replaced_by.selection.display, 'BUF -2.5');
  assert.equal(r.replaced_by.receipt_chain_hash, RECEIPTS[0].chain_hash);
  assert.equal(r.reason.rule, 'opposite_side_qualified');
  assert.equal(pro.json.eligibility.lock_integrity.violations, 0);
  assert.equal(pro.json.summary.replaced_before_lock, 1);
  /* The replaced row itself is never a current pick. */
  assert.equal(pro.json.picks.some(c => c.id === ROWS[1].id), false);
  /* Free sees that the signal was revised, not what it was or is. */
  const preview = await call('preview');
  const pv = preview.json.previews.find(p => p.game_id === '2026_01_BUF_HOU' && p.market === 'spread');
  assert.equal(pv.revisions, 1);
  assert.equal(preview.text.includes('HOU +2.5'), false);
  assert.equal(P.assertNoSelection(preview.json), true);
});

test('handler: replaced decisions live in Validation History, ungraded and outside the record', async () => {
  const hist = await call('validation-history', sessionCookie('pro@propbetedge.test'));
  assert.equal(hist.status, 200);
  const rep = hist.json.replaced.find(x => x.id === ROWS[1].id);
  assert.ok(rep, 'superseded decision listed');
  assert.deepEqual([rep.status, rep.graded, rep.before_lock, rep.replaced_by.id], ['SIGNAL REPLACED', false, true, ROWS[0].id]);
  assert.equal(hist.json.summary.replaced_before_lock, 1);
  /* Not a result: the W-L-P only counts graded decisions. */
  assert.equal(hist.json.summary.win + hist.json.summary.loss + hist.json.summary.push, 1);   // only the graded NE@SEA win
  assert.equal(hist.json.picks.some(p => p.id === ROWS[1].id), false);
});

test('handler: an official decision replaced before lock is not an Official Track Record pick', async () => {
  const off = pick({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', publication_scope: 'official', model_version: 2, status: 'superseded',
    superseded_by: '11111111-1111-4111-8111-111111111111', game_id: '2026_01_KC_DEN', kickoff_ts: '2026-09-10T00:00:00+00:00' });
  mock.extraRows.push(off);
  try {
    const track = await call('trackrecord');
    assert.equal(track.json.total_count, 0);
    assert.equal(track.json.picks.length, 0);
    assert.equal(track.json.replaced_count, 1);
  } finally { mock.extraRows.length = 0; }
});

test('handler: view=decision returns the persisted row to Pro only', async () => {
  const id = ROWS[0].id;
  const pro = await callQ({ view: 'decision', id }, sessionCookie('pro@propbetedge.test'));
  assert.equal(pro.status, 200);
  for (const k of ['selection_team', 'market_line', 'market_price', 'created_at', 'model_prob', 'market_prob', 'edge_pct', 'stake_units', 'model_version', 'publication_scope']) {
    assert.equal(pro.json.row[k], ROWS[0][k], k);
  }
  assert.equal('features' in pro.json.row, false);
  assert.equal(pro.json.receipt.chain_hash, RECEIPTS[0].chain_hash);
  assert.equal(pro.json.verification.ok, true);
  assert.equal((await callQ({ view: 'decision', id })).status, 401);
  assert.equal((await callQ({ view: 'decision', id }, `${SESSION_COOKIE}=eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InByb0B4LmNvbSJ9.AAAA`)).status, 401);
  const free = await callQ({ view: 'decision', id }, sessionCookie('free@propbetedge.test'));
  assert.equal(free.status, 403);
  assertNoSecrets(free.text);
});
