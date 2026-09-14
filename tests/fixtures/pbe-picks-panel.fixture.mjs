/* Dashboard PBE Picks / Track Record panel — state payloads for the consumer
 * presentation suite and its before/after browser screenshots.
 *
 * Every payload here is produced by the REAL read handler (api/pbe-picks.js,
 * view=state — the exact read the dashboard panel makes) over the PBE Card
 * fixture's mocked Supabase, gateway and run ledger. Nothing is hand-shaped
 * except the two deliberately broken payloads, which exist to prove the panel
 * fails closed. The validation sample is 14 finalized observations across one
 * week; official rows are injected per scenario.
 */
import { ENV, NOW, pick, mock, installMockFetch } from './pbe-card-v3.fixture.mjs';

const official = (id, over) => pick({
  id, publication_scope: 'official', model_version: 2, status: 'graded',
  game_id: '2026_01_KC_DEN', kickoff_ts: '2026-09-08T00:20:00+00:00', created_at: '2026-09-07T15:00:00+00:00', created_text: '2026-09-07 15:00:00+00',
  ...over,
});
const OFFICIAL_ROWS = [
  official('a1000000-0000-4000-8000-000000000001'),
  official('a1000000-0000-4000-8000-000000000002', { game_id: '2026_01_GB_CHI' }),
  official('a1000000-0000-4000-8000-000000000003', { game_id: '2026_01_PIT_CLE' }),
  official('a1000000-0000-4000-8000-000000000004', { game_id: '2026_01_DAL_PHI', status: 'open', kickoff_ts: '2026-09-14T17:00:00+00:00', created_at: '2026-09-12T11:00:00+00:00', created_text: '2026-09-12 11:00:00+00' }),
];
const OBSERVATIONS = Array.from({ length: 14 }, () => ({ season: 2026, week: 1, publication_scope: 'tracking' }));

async function stateOf({ trained, engineDown, officialRows }) {
  Object.assign(process.env, ENV);
  const { handler } = await import('../../api/pbe-picks.js');
  installMockFetch();
  const base = globalThis.fetch;
  /* 14 finalized validation observations instead of the card fixture's one. */
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'supabase.test' && url.pathname.endsWith('/nfl_learning_observations')) {
      return new Response(JSON.stringify(OBSERVATIONS), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return base(input, init);
  };
  const savedNow = Date.now;
  Date.now = () => NOW;
  Object.assign(mock, { trained, engineDown, extraRows: officialRows });
  try {
    const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(t) { this.body = t; } };
    await handler({ method: 'GET', query: { view: 'state' }, headers: {} }, res);
    if (res.statusCode !== 200) throw new Error(`state view answered ${res.statusCode}: ${res.body}`);
    return JSON.parse(res.body);
  } finally {
    Object.assign(mock, { trained: false, engineDown: false, extraRows: [] });
    globalThis.fetch = base;
    Date.now = savedNow;
  }
}

/* Scenario -> the store the panel holds: { data, error }. */
export async function panelScenarios() {
  const validation = await stateOf({ trained: false, engineDown: false, officialRows: [] });
  const officialLive = await stateOf({ trained: true, engineDown: false, officialRows: OFFICIAL_ROWS });
  const runtimeDownValidation = await stateOf({ trained: false, engineDown: true, officialRows: [] });
  const runtimeDownOfficial = await stateOf({ trained: true, engineDown: true, officialRows: OFFICIAL_ROWS });
  const gatedWithRecord = await stateOf({ trained: false, engineDown: false, officialRows: OFFICIAL_ROWS });
  const liveNoOfficial = await stateOf({ trained: true, engineDown: false, officialRows: [] });
  const { decisions, ...noDecisions } = validation;
  return {
    '1-validation-no-official': { data: validation, error: null },
    '2-official-picks-exist': { data: officialLive, error: null },
    '3a-runtime-unavailable-validation-record': { data: runtimeDownValidation, error: null },
    '3b-runtime-unavailable-official-record': { data: runtimeDownOfficial, error: null },
    '3c-refresh-failed-last-valid-record-kept': { data: officialLive, error: 'picks_backend_unavailable' },
    '4a-record-payload-unavailable': { data: null, error: 'picks_backend_unavailable' },
    '4b-record-payload-malformed': { data: { ...noDecisions }, error: null },
    '5-gated-engine-with-prior-official-record': { data: gatedWithRecord, error: null },
    '6-live-engine-no-official-yet': { data: liveNoOfficial, error: null },
  };
}
