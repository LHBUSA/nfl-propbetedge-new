/* PBE Card v3 — a real-shaped week-1 slate for the contract suite and the
 * browser render gate. Fixture data only: the selections here are test values
 * and are never shown or reported as engine output.
 *
 * installMockFetch() routes the read handler's upstreams (supabase.test,
 * gateway.test, engine.test) to these rows and passes every other request to
 * the real fetch, so the same handler code runs unmodified.
 */
import { createHash, createHmac } from 'node:crypto';

export const NOW = Date.parse('2026-09-12T12:00:00Z');
export const ENV = Object.freeze({
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  NFL_SESSION_SIGNING_SECRET: 'test-session-signing-secret',
  NFL_GATEWAY: 'https://gateway.test',
  PICKS_ENGINE_URL: 'https://engine.test',
});
export const sha = text => createHash('sha256').update(text).digest('hex');

export function pick(over) {
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

export const ROWS = [
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

export function receiptFor(row, tamper = {}) {
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
export const RECEIPTS = ROWS.map(r => r.id.startsWith('6666') ? receiptFor(r, { market_price: -120 }) : receiptFor(r));

export const AUDITS = [
  { pick_id: '11111111-1111-4111-8111-111111111111', event_type: 'pick_created', occurred_at: '2026-09-11T17:30:53Z', detail: { side: 'BUF -2.5' } },
  { pick_id: '00000000-0000-4000-8000-000000000000', event_type: 'pick_superseded', occurred_at: '2026-09-11T17:30:53Z', detail: {} },
  { pick_id: '33333333-3333-4333-8333-333333333333', event_type: 'pick_killed', occurred_at: '2026-09-11T22:00:00Z', detail: { reason: 'edge_collapsed', edge_pct: 0.004 } },
  { pick_id: '44444444-4444-4444-8444-444444444444', event_type: 'first_grade', occurred_at: '2026-09-10T04:00:00Z', detail: {} },
];
export const GRADES = [
  { pick_id: '44444444-4444-4444-8444-444444444444', graded_at: '2026-09-10T04:00:00Z', result: 'win', units_delta: 1.1223, clv_points: 0.5, clv_prob: 0.012, clv_beat: true, brier: 0.2 },
  { pick_id: '33333333-3333-4333-8333-333333333333', graded_at: '2026-09-12T04:00:00Z', result: 'void', units_delta: 0, clv_points: null, clv_prob: null, clv_beat: null, brier: null },
];
export const TAPE = [
  { game_id: '2026_01_BUF_HOU', captured_at: '2026-09-11T17:00:22+00:00', book: 'draftkings', market: 'spread', line: -2.5, price: -110, is_closing: false, team: 'BUF', over_under: null, is_home: false },
  { game_id: '2026_01_BUF_HOU', captured_at: '2026-09-11T17:00:22+00:00', book: 'draftkings', market: 'spread', line: 2.5, price: -110, is_closing: false, team: 'HOU', over_under: null, is_home: true },
  { game_id: '2026_01_BUF_HOU', captured_at: '2026-09-12T12:00:05+00:00', book: 'consensus:2', market: 'spread', line: -3.5, price: -105, is_closing: false, team: 'BUF', over_under: null, is_home: false },
  { game_id: '2026_01_BUF_HOU', captured_at: '2026-09-12T12:00:05+00:00', book: 'consensus:2', market: 'spread', line: 3.5, price: -115, is_closing: false, team: 'HOU', over_under: null, is_home: true },
];
export const SCORES = [
  { game_id: '401872657', season: 2026, game_type: 'REG', week: 1, kickoff: '2026-09-12T11:00Z', away_team: 'SF', home_team: 'LAR', away_score: 14, home_score: 7, semantics: 'LIVE', detail: 'Q2 4:11' },
];

/* Session cookie signed exactly as the auth Worker signs it. */
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function sessionCookie(email, { namespace, cookieName, secret = ENV.NFL_SESSION_SIGNING_SECRET, now = Date.now() }) {
  const t = Math.floor(now / 1000);
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ email, type: 'session', iat: t, exp: t + 3600, jti: 't' }))}`;
  const sig = createHmac('sha256', `${namespace}:${secret}`).update(data).digest();
  return `${cookieName}=${data}.${b64u(sig)}`;
}

function inIds(query) {
  const m = /pick_id=in\.\(([^)]*)\)/.exec(decodeURIComponent(query));
  return m ? m[1].split(',').map(s => s.replace(/"/g, '')) : [];
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/* Mutable switches the suites flip: engine down, trained champion. */
export const mock = { engineDown: false, trained: false, requested: [] };

export function installMockFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!['engine.test', 'gateway.test', 'supabase.test'].includes(url.host)) return real(input, init);
    mock.requested.push(url.toString());
    if (url.host === 'engine.test') {
      if (mock.engineDown) throw new Error('offline');
      return reply({ generated_at: new Date().toISOString(), lanes: [
        { lane: 'nfl-game-picks-orchestrator', critical: true, state: 'HEALTHY', last_work: { finished_at: '2026-09-12T11:45:00Z', status: 'ok' }, last_tick: { finished_at: '2026-09-12T11:45:00Z' } },
        { lane: 'nfl-odds-snapshot', critical: true, state: 'HEALTHY' },
        { lane: 'nfl-game-grader', critical: true, state: 'HEALTHY' },
      ] });
    }
    if (url.host === 'gateway.test') {
      if (url.pathname === '/api/season') return reply({ season: 2026, current_week: 1, season_type: 'REG' });
      if (url.pathname === '/api/scores') return reply({ games: SCORES });
    }
    if (url.host === 'supabase.test') {
      const table = url.pathname.replace('/rest/v1/', '');
      const q = url.search;
      const dq = decodeURIComponent(q);
      if (table === 'nfl_subscriptions') {
        if (dq.includes('broken@')) return reply({ message: 'down' }, 500);
        return reply(dq.includes('pro@') ? [{ status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] : []);
      }
      if (table === 'nfl_model_weights') return reply([{ version: mock.trained ? 2 : 1, weights: { meta: { trained: mock.trained } }, notes: 'fixture' }]);
      if (table === 'nfl_learning_observations') return reply([{ season: 2026, week: 1, publication_scope: 'tracking' }]);
      if (table === 'nfl_game_picks') {
        if (q.includes('select=season,status,publication_scope,created_at')) return reply(ROWS.map(({ season, status, publication_scope, created_at }) => ({ season, status, publication_scope, created_at })));
        if (dq.includes('publication_scope=eq.official')) return reply(ROWS.filter(r => r.publication_scope === 'official'));
        if (dq.includes('publication_scope=eq.tracking')) return reply(ROWS.filter(r => ['graded', 'killed'].includes(r.status)));
        return reply(ROWS);
      }
      if (table === 'nfl_pick_receipts') { const ids = inIds(q); return reply(RECEIPTS.filter(r => ids.includes(r.pick_id))); }
      if (table === 'nfl_pick_audit_events') { const ids = inIds(q); return reply(AUDITS.filter(a => ids.includes(a.pick_id))); }
      if (table === 'nfl_pick_grades') { const ids = inIds(q); return reply(GRADES.filter(g => ids.includes(g.pick_id))); }
      if (table === 'nfl_odds_snapshots') { const id = /game_id=eq\.([^&]+)/.exec(q)?.[1]; return reply(TAPE.filter(s => s.game_id === decodeURIComponent(id || ''))); }
    }
    return reply({ error: 'unmocked', url: url.toString() }, 404);
  };
}
