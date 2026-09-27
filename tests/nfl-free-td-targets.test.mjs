/* FREE TD TARGETS — /api/pbe-touchdown-targets?view=free-sample.
 *
 * The network free product: at most two OFFICIAL, PRIMARY, open, pregame
 * Touchdown Targets for one ET slate day, drawn from the existing engine. This
 * suite pins the contract, the one eligibility predicate, the leak boundary,
 * the premium gate that must not move, the selector thresholds and the
 * grader/detector bytes, and the free cards the TD page renders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const SB = 'https://tkmlnhmylqnttmnsnief.supabase.co';
Object.assign(process.env, { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'free-td-service-role', NFL_SESSION_SIGNING_SECRET: 'free-td-signing-secret', NFL_GATEWAY: 'https://gateway.test', PICKS_ENGINE_URL: 'https://engine.test' });

const free = await import('../api/_td-free-sample.js');
const {
  FREE_TD_TARGET_KEYS, FREE_TD_MAX_TARGETS, FREE_TD_ELIGIBILITY_RULE, isFreeTdEligible, selectFreeTdTargets,
  buildFreeTdPayload, freeTdInsights, freeTdSlateDate, etDate, freeTdGameLabel,
} = free;
const { SELECTOR_DEFAULTS } = await import('../workers/nfl-td-targets-shared/td-selector.mjs');

/* ------------------------------------------------------------------ fixtures */

const NOW = Date.parse('2026-10-04T14:00:00Z');          /* Sunday 10:00 ET */
const SUN_1PM = '2026-10-04T17:00:00Z';
const SUN_4PM = '2026-10-04T20:25:00Z';
const MON_NIGHT = '2026-10-06T00:15:00Z';                 /* Monday 8:15 PM ET */

let seq = 0;
function snapshot({ name, gsis, espn = '4239996', team = 'NO', opponent = 'LV', atHome = true, gameId = '2026_05_LV_NO', position = 'RB' }) {
  return {
    player: { name, gsis_id: gsis, espn_id: espn, team, opponent, at_home: atHome, position },
    event: { game_id: gameId, espn_id: '401872961', away_team: 'Las Vegas Raiders', home_team: 'New Orleans Saints' },
    probability: {
      published: 0.43,
      base: { history: { rate: 0.645161, weight: 14.7788, available: true }, current_season: { rate: null, weight: 0, available: false } },
      components: {
        red_zone_role: { available: true, factor: 1.12, player_rz_opportunities_per_game: 2.663723, position_rz_opportunities_per_game: 1.449193 },
        opponent: { available: true, factor: 1, opponent_rushing_td_allowed_per_game: 0.83193, opponent_receiving_td_allowed_per_game: 1.43697 },
        game_script: { available: true, factor: 1.16, bucket: 'favourite', sample_rows: 7214 },
      },
    },
    market: { books: 8, probability: 0.41 },
    game_context: { implied_team_total: { LV: 20.25, NO: 23.25 } },
    selector_config: { primary_min_prob: 0.22 },
    ranked_preview: [{ player_name: 'Someone Else', probability: 0.3 }],
  };
}
function target(over = {}, snap = {}) {
  seq += 1;
  return {
    id: over.id || `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    event_id: `evt-${seq}`,
    season: 2026, week: 5,
    kickoff_ts: SUN_1PM,
    player_name: snap.name || `Player ${seq}`,
    player_key: String(snap.name || `player ${seq}`).toLowerCase(),
    market: 'player_anytime_td',
    model_prob: 0.40,
    market_prob: 0.38, edge_pct: 0.02, ev_pct: 3.1, market_price: 145, book: 'Fanatics', confidence_bucket: 'C',
    target_rank: 'primary',
    projection_model_version: 'pbe-td-hazard-v1',
    selector_version: 3,
    publication_scope: 'official',
    status: 'open',
    created_at: '2026-10-02T00:30:00Z',
    ...over,
    model_snapshot: snapshot({ name: snap.name || `Player ${seq}`, gsis: snap.gsis || `00-00${String(40000 + seq).padStart(5, '0')}`, gameId: snap.gameId || `2026_05_G${seq}_H${seq}`.slice(0, 16), ...snap }),
  };
}
const ALLOWED = { publication: 'ALLOWED', gate_open: true, engine_health: 'HEALTHY', current: { season: 2026, week: 5 } };
const GATED = { publication: 'GATED', gate_open: false, engine_health: 'HEALTHY', current: { season: 2026, week: 5 } };

/* Anything that would give away the paid product. */
const FORBIDDEN_KEYS = ['model_prob', 'probability', 'market_prob', 'market_probability', 'edge', 'edge_pct', 'edge_pp', 'ev_pct',
  'market_price', 'price', 'odds', 'book', 'best_book', 'target_rank', 'rank', 'confidence', 'confidence_bucket', 'drivers',
  'factor', 'model_snapshot', 'ranked_preview', 'pool', 'selector_config', 'receipt', 'chain_hash', 'lambda', 'components', 'games'];
function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach(v => keysDeep(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  return out;
}

/* ------------------------------------------------------- the eligibility rule */

test('the eligibility predicate: official + primary + open + pregame + resolved identity, nothing else', () => {
  assert.equal(FREE_TD_ELIGIBILITY_RULE, 'official_primary_pregame_td_target');
  assert.equal(isFreeTdEligible(target()), true);
  for (const [label, row] of [
    ['tracking', target({ publication_scope: 'tracking' })],
    ['missing scope', target({ publication_scope: null })],
    ['secondary', target({ target_rank: 'secondary' })],
    ['withdrawn (killed)', target({ status: 'killed' })],
    ['replaced (superseded)', target({ status: 'superseded' })],
    ['settled (graded)', target({ status: 'graded' })],
    ['issued after kickoff', target({ created_at: '2026-10-04T17:05:00Z' })],
    ['passing yards market', target({ market: 'player_pass_yds' })],
  ]) assert.equal(isFreeTdEligible(row), false, label);
  const noId = target();
  noId.model_snapshot.player.gsis_id = null;
  assert.equal(isFreeTdEligible(noId), false, 'a name without a resolved GSIS id never qualifies');
});

test('TODAY (every target tracking, publication GATED): zero targets, explicit reason, clean empty state', () => {
  const rows = [target({ publication_scope: 'tracking', model_prob: 0.55 }), target({ publication_scope: 'tracking', model_prob: 0.5 })];
  const body = buildFreeTdPayload({ state: GATED, rows, season: 2026, week: 5, nowMs: NOW });
  assert.equal(body.count, 0);
  assert.deepEqual(body.targets, []);
  assert.deepEqual(body.eligibility, { rule: 'official_primary_pregame_td_target', publication: 'GATED', gate_open: false, reason: 'td_publication_gated' });
  assert.deepEqual(body.empty_state, { code: 'td_publication_gated', message: 'No qualified free TD targets yet' });
  assert.equal(body.slate_date, null);
});

test('publication allowed but nothing official open: a different, honest reason', () => {
  const body = buildFreeTdPayload({ state: ALLOWED, rows: [], season: 2026, week: 5, nowMs: NOW });
  assert.equal(body.eligibility.reason, 'no_official_primary_td_target');
  assert.equal(body.empty_state.code, 'no_official_primary_td_target');
  const degraded = buildFreeTdPayload({ state: { ...ALLOWED, engine_health: 'DEGRADED' }, rows: [], nowMs: NOW });
  assert.equal(degraded.eligibility.reason, 'td_engine_degraded');
});

/* ------------------------------------------------------------ max two, order */

test('never more than two, whatever the slate holds; the selector\'s own order picks them', () => {
  const rows = [0.31, 0.52, 0.44, 0.61, 0.29].map(p => target({ model_prob: p }));
  const body = buildFreeTdPayload({ state: ALLOWED, rows, season: 2026, week: 5, nowMs: NOW });
  assert.equal(FREE_TD_MAX_TARGETS, 2);
  assert.equal(body.max_targets, 2);
  assert.equal(body.count, 2);
  assert.equal(body.targets.length, 2);
  assert.deepEqual(body.targets.map(t => t.target_id), [rows[3].id, rows[1].id]);
  assert.equal(selectFreeTdTargets(rows, 99, NOW).length, 2, 'a caller cannot ask for more than two');
  assert.equal(body.eligibility.reason, null);
  assert.equal(body.empty_state, null);
});

test('one qualified target shows one — nothing is manufactured to make two', () => {
  const rows = [target({ model_prob: 0.5 }), target({ publication_scope: 'tracking', model_prob: 0.7 }), target({ target_rank: 'secondary', model_prob: 0.6 })];
  const body = buildFreeTdPayload({ state: ALLOWED, rows, season: 2026, week: 5, nowMs: NOW });
  assert.equal(body.count, 1);
  assert.equal(body.targets[0].target_id, rows[0].id);
});

test('dedupe by player_id + game_id', () => {
  const a = target({ model_prob: 0.5 }, { name: 'Kenneth Walker III', gsis: '00-0038134', gameId: '2026_05_SEA_ARI' });
  const b = target({ model_prob: 0.49 }, { name: 'Kenneth Walker', gsis: '00-0038134', gameId: '2026_05_SEA_ARI' });
  const c = target({ model_prob: 0.3 }, { name: 'Other Back', gsis: '00-0039999', gameId: '2026_05_DAL_NYG' });
  const picked = selectFreeTdTargets([a, b, c], 2, NOW);
  assert.deepEqual(picked.map(r => r.id), [a.id, c.id]);
});

test('suffix identity: Jr./Sr./II/III resolve by GSIS id, never by name', () => {
  /* Two different players whose names differ only by a suffix are two players. */
  const jr = target({ model_prob: 0.5 }, { name: 'Marvin Harrison Jr.', gsis: '00-0039849', gameId: '2026_05_ARI_SEA', team: 'ARI', opponent: 'SEA', atHome: false, position: 'WR' });
  const sr = target({ model_prob: 0.45 }, { name: 'Marvin Harrison', gsis: '00-0011111', gameId: '2026_05_ARI_SEA', team: 'ARI', opponent: 'SEA', atHome: false, position: 'WR' });
  const body = buildFreeTdPayload({ state: ALLOWED, rows: [jr, sr], nowMs: NOW });
  assert.deepEqual(body.targets.map(t => [t.player_name, t.player_id]), [['Marvin Harrison Jr.', '00-0039849'], ['Marvin Harrison', '00-0011111']]);
  /* The headshot is keyed by the frozen ESPN id, never looked up by name. */
  assert.match(body.targets[0].headshot_url, /^https:\/\/a\.espncdn\.com\/i\/headshots\/nfl\/players\/full\/\d+\.png$/);
  /* A suffix name with no resolved id cannot be free. */
  const unresolved = target({ model_prob: 0.9 }, { name: 'Michael Pittman Jr.', gsis: 'michael pittman jr' });
  assert.equal(isFreeTdEligible(unresolved), false);
});

/* ------------------------------------------------------------ one slate day */

test('one ET slate day: the earliest day on/after today with an eligible target; max two within it', () => {
  const sun1 = target({ kickoff_ts: SUN_1PM, model_prob: 0.35 });
  const sun4 = target({ kickoff_ts: SUN_4PM, model_prob: 0.4 });
  const mon = target({ kickoff_ts: MON_NIGHT, model_prob: 0.9 });
  const body = buildFreeTdPayload({ state: ALLOWED, rows: [sun1, sun4, mon], nowMs: NOW });
  assert.equal(body.slate_date, '2026-10-04');
  assert.deepEqual(body.targets.map(t => t.target_id), [sun4.id, sun1.id], 'Monday\'s higher probability does not jump the Sunday slate');
  assert.ok(body.targets.every(t => t.slate_date === '2026-10-04'));
  /* Monday night is the Monday ET slate even though it kicks off after 00:00 UTC. */
  assert.equal(etDate(MON_NIGHT), '2026-10-05');
  const monday = buildFreeTdPayload({ state: ALLOWED, rows: [sun1, sun4, mon], nowMs: Date.parse('2026-10-05T15:00:00Z') });
  assert.equal(monday.slate_date, '2026-10-05');
  assert.deepEqual(monday.targets.map(t => t.target_id), [mon.id]);
  assert.equal(freeTdSlateDate([], NOW), null);
});

/* ----------------------------------------------------------- the leak boundary */

test('a free target carries exactly the contract keys and never a premium field', () => {
  const rows = [target({ model_prob: 0.5 }, { name: 'Travis Etienne', gsis: '00-0036973', gameId: '2026_05_LV_NO' }), target({ model_prob: 0.4 })];
  const body = buildFreeTdPayload({ state: ALLOWED, rows, season: 2026, week: 5, nowMs: NOW });
  assert.deepEqual(Object.keys(body), ['contract', 'sport', 'product', 'product_version', 'generated_at', 'season', 'week', 'slate_date',
    'max_targets', 'count', 'eligibility', 'targets', 'empty_state', 'full_product_url', 'cta_label']);
  for (const t of body.targets) assert.deepEqual(Object.keys(t), [...FREE_TD_TARGET_KEYS]);
  const keys = keysDeep(body);
  for (const key of FORBIDDEN_KEYS) assert.equal(keys.has(key), false, `leaked ${key}`);
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /%/, 'no percentage anywhere — no probability can hide in copy');
  assert.doesNotMatch(raw, /0\.5\b|Fanatics|\+145/, 'no probability, book or price value');
  const t = body.targets[0];
  assert.equal(body.contract, 'pbe-nfl-free-td-targets-v1');
  assert.equal(body.product_version, 'nfl-free-td-targets/1.0.0');
  assert.equal(body.full_product_url, 'https://nfl.propbetedge.ai/#tdtargets');
  assert.equal(body.cta_label, 'Unlock all TD Targets');
  assert.deepEqual([t.selection_type, t.free, t.official, t.publication_scope, t.market], ['td_target', true, true, 'official', 'player_anytime_td']);
  assert.deepEqual([t.player_id, t.team, t.opponent, t.home_away, t.game_id, t.game_label, t.slate_date], ['00-0036973', 'NO', 'LV', 'home', '2026_05_LV_NO', 'LV @ NO', '2026-10-04']);
  assert.deepEqual([t.game_status, t.locked_at, t.issued_at], ['scheduled', null, '2026-10-02T00:30:00Z']);
  const live = buildFreeTdPayload({ state: ALLOWED, rows, nowMs: Date.parse('2026-10-04T17:30:00Z') }).targets[0];
  assert.deepEqual([live.game_status, live.locked_at], ['started', SUN_1PM]);
});

test('target_id is the issuance row id, unchanged across calls and times', () => {
  const row = target({ id: 'ce699727-28e8-4dec-a587-360537a04940' });
  const a = buildFreeTdPayload({ state: ALLOWED, rows: [row], nowMs: NOW }).targets[0].target_id;
  const b = buildFreeTdPayload({ state: ALLOWED, rows: [row], nowMs: NOW + 3 * 3600000 }).targets[0].target_id;
  assert.equal(a, 'ce699727-28e8-4dec-a587-360537a04940');
  assert.equal(b, a);
});

test('insights: two or three, only from data the frozen snapshot actually carries', () => {
  const s = snapshot({ name: 'Travis Etienne', gsis: '00-0036973' });
  assert.deepEqual(freeTdInsights(s), [
    { label: 'Red-zone role', value: '2.7 red-zone opportunities per game (RB average 1.4)' },
    { label: 'Scoring history', value: '0.65 rushing + receiving TDs per game (recency-weighted)' },
    { label: 'Opponent TD allowance', value: 'LV allows 0.83 rushing + 1.44 receiving TDs per game' },
  ]);
  s.probability.components.red_zone_role.available = false;
  s.probability.components.opponent.available = false;
  s.probability.base.current_season = { rate: 1.5, weight: 2, available: true };
  assert.deepEqual(freeTdInsights(s), [
    { label: 'This season', value: '1.50 rushing + receiving TDs per game over 2 games' },
    { label: 'Team implied total', value: 'NO 23.25 points (sportsbook consensus)' },
  ]);
  assert.deepEqual(freeTdInsights({}), []);
  assert.equal(freeTdGameLabel({ model_snapshot: { event: { game_id: '2026_05_KC_LV' }, player: {} } }), 'KC @ LV');
});

/* ------------------------------------------------------------ the HTTP door */

const answer = (() => {
  let picks = [];
  const fn = url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/v1/engine/runs')) return { lanes: ['nfl-touchdown-targets-orchestrator', 'nfl-odds-snapshot', 'nfl-touchdown-targets-grader'].map(lane => ({ lane, label: lane, critical: true, state: 'HEALTHY' })) };
    if (u.pathname.endsWith('/api/season')) return { season: 2026, current_week: 5, season_type: 'REG' };
    if (u.origin !== SB) throw new Error(`unexpected fetch ${url}`);
    const table = u.pathname.split('/').pop();
    fn.reads.push(decodeURIComponent(u.search));
    if (table === 'nfl_prop_selector_models') return [{ version: 2, market: 'player_anytime_td', projection_model: 'pbe-td-hazard-v1', config: { primary_min_prob: 0.22 }, trained: false, promoted: true }];
    if (table === 'nfl_prop_picks') return picks;
    return [];
  };
  fn.reads = [];
  fn.setPicks = rows => { picks = rows; };
  return fn;
})();
globalThis.fetch = async url => new Response(JSON.stringify(answer(String(url instanceof Request ? url.url : url))), { status: 200, headers: { 'content-type': 'application/json' } });
const vercel = (await import('../api/pbe-touchdown-targets.js')).default;
const worker = await import('../workers/nfl-touchdown-targets-api/src/contract.js');

async function viaVercel(view, headers = {}) {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await vercel({ method: 'GET', query: { view }, headers }, res);
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

test('view=free-sample over HTTP: public, cacheable, gated today, and it reads only open primaries', async () => {
  answer.setPicks([target({ publication_scope: 'tracking', model_prob: 0.6 }), target({ publication_scope: 'tracking', model_prob: 0.5 })]);
  answer.reads.length = 0;
  const out = await viaVercel('free-sample');
  assert.equal(out.status, 200);
  assert.equal(out.body.contract, 'pbe-nfl-free-td-targets-v1');
  assert.equal(out.body.count, 0);
  assert.equal(out.body.eligibility.reason, 'td_publication_gated');
  assert.equal(out.body.season, 2026);
  assert.equal(out.body.week, 5);
  assert.match(out.headers['cache-control'], /^public/);
  const pickRead = answer.reads.find(q => q.includes('market=eq.player_anytime_td&season='));
  assert.match(pickRead, /status=eq\.open&target_rank=eq\.primary/);
});

test('an official target in the database never exceeds two and never leaks, end to end (Vercel and Worker agree)', async () => {
  const rows = [0.3, 0.6, 0.5, 0.4].map(p => target({ model_prob: p, kickoff_ts: '2099-01-03T18:00:00Z', created_at: '2099-01-01T00:00:00Z' }));
  answer.setPicks(rows);
  const out = await viaVercel('free-sample');
  assert.equal(out.status, 200);
  assert.equal(out.body.count, 2);
  for (const key of FORBIDDEN_KEYS) assert.equal(keysDeep(out.body).has(key), false, `leaked ${key}`);
  const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'x', NFL_AUTH_INTERNAL_TOKEN: 'i'.repeat(40), AUTH: { fetch: async () => new Response('{}') }, NFL_CURRENT: { fetch: async req => new Response(JSON.stringify(answer(req.url))) }, PICKS_ENGINE: { fetch: async req => new Response(JSON.stringify(answer(req.url))) } };
  const r = await worker.handle(new Request('https://nfl.propbetedge.ai/api/pbe-touchdown-targets?view=free-sample'), ENV);
  const wbody = JSON.parse(await r.text());
  const strip = b => JSON.parse(JSON.stringify(b, (k, v) => (k === 'generated_at' ? '<t>' : v)));
  assert.deepEqual(strip(wbody), strip(out.body));
});

test('premium stays premium: anonymous current/week are 401 with no targets, signed-in non-Pro is 403', async () => {
  for (const view of ['current', 'week']) {
    const out = await viaVercel(view);
    assert.equal(out.status, 401);
    assert.equal(out.body.error, 'sign_in_required');
    assert.equal(out.body.games, undefined);
  }
  const verdict = { valid: true, pro: false, signed_in: true, access: 'no_entitlement', degraded: false, stage: 'entitlement_missing' };
  const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'x', NFL_AUTH_INTERNAL_TOKEN: 'i'.repeat(40), AUTH: { fetch: async () => new Response(JSON.stringify(verdict)) }, NFL_CURRENT: { fetch: async req => new Response(JSON.stringify(answer(req.url))) }, PICKS_ENGINE: { fetch: async req => new Response(JSON.stringify(answer(req.url))) } };
  for (const view of ['current', 'week']) {
    const r = await worker.handle(new Request(`https://nfl.propbetedge.ai/api/pbe-touchdown-targets?view=${view}`, { headers: { cookie: 'pbe_nfl_session_v2=free' } }), ENV);
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(await r.text()).games, undefined);
  }
});

/* --------------------------------------------- nothing about the engine moved */

test('selector thresholds are unchanged (the free product never lowers a bar)', () => {
  assert.deepEqual({
    primary_min_prob: SELECTOR_DEFAULTS.primary_min_prob,
    secondary_min_prob: SELECTOR_DEFAULTS.secondary_min_prob,
    secondary_min_edge: SELECTOR_DEFAULTS.secondary_min_edge,
    secondary_min_books: SELECTOR_DEFAULTS.secondary_min_books,
    min_books: SELECTOR_DEFAULTS.min_books,
    max_publishable_prob: SELECTOR_DEFAULTS.max_publishable_prob,
    availability_abstain_share: SELECTOR_DEFAULTS.availability_abstain_share,
    replace_min_prob_gap: SELECTOR_DEFAULTS.replace_min_prob_gap,
  }, {
    primary_min_prob: 0.22, secondary_min_prob: 0.30, secondary_min_edge: 0.03, secondary_min_books: 3,
    min_books: 2, max_publishable_prob: 0.92, availability_abstain_share: 0.6, replace_min_prob_gap: 0.025,
  });
  /* The free module defines no threshold of its own. */
  assert.doesNotMatch(read('api/_td-free-sample.js'), /min_prob|min_edge|primary_min|threshold\s*=/);
});

test('model, selector, grader and detector files are byte-for-byte unchanged', () => {
  const sha = path => createHash('sha256').update(read(path).replace(/\r\n/g, '\n')).digest('hex');
  const pinned = {
    'workers/nfl-touchdown-targets-grader/src/index.js': '8b28351932eb0f965683485647ddf6514e73ee551e696cc7755c5cd25b68df11',
    'workers/nfl-td-targets-shared/td-grading.mjs': '2551516e7d2df3ef9442399a5b0595bc5eeeef9c5154a7a3b4480e3cdef7fa9a',
    'workers/nfl-td-targets-shared/td-live-hit.mjs': '821aadf094a1d54602b197fd05b5e2b7b8d76e6211c08c41a261569810e019d8',
    'workers/nfl-touchdown-target-hit-alerts/src/index.js': '2bef1f72b2b77146486065118f581e85a818233cb6eea9141c15fd4db4547460',
    'workers/nfl-td-targets-shared/td-selector.mjs': '16db24c90d8bf239d944e396f4eac949089cb60c77b9bf15e3679680b2432313',
    'workers/nfl-td-targets-shared/td-kernel.mjs': '29550cf0d815bd5fea9782afca2e04fac0991628b8fcb6d8cc1eac35a3035673',
    'workers/nfl-td-targets-shared/td-score.mjs': '9b8b5f237f3557a2df385c184935d95c0ec2c1d0ec03bea070afbc567f584e0a',
    'workers/nfl-td-targets-shared/td-model-v1.js': '9eadfc11398ee38a9b217f16e8c1f0552da4e0dfd3012abc709a3eccfe608c82',
    'workers/nfl-touchdown-targets-orchestrator/src/index.js': 'd416d5b8be131ef944f5ff1fe7fc34ad9e0fbe57cb7f0681670f6b9ee13f245f',
  };
  for (const [path, hash] of Object.entries(pinned)) assert.equal(sha(path), hash, path);
});

/* -------------------------------------------------------- the free cards (UI) */

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
const page = loadPage();
const plainText = html => html.replace(/<[^>]+>/g, ' ').replace(/&rarr;/g, '→').replace(/\s+/g, ' ').trim();

test('UI · two targets: two premium player cards with photo, team/opp, TD TARGET, reasons and the CTA', () => {
  const rows = [target({ model_prob: 0.5 }, { name: 'Travis Etienne', gsis: '00-0036973' }), target({ model_prob: 0.4 }, { name: 'Marvin Harrison Jr.', gsis: '00-0039849', team: 'ARI', opponent: 'SEA', atHome: false, espn: '4432708' })];
  const payload = buildFreeTdPayload({ state: ALLOWED, rows, nowMs: NOW });
  const html = page.freeSampleHtml(payload);
  const t = plainText(html);
  assert.equal((html.match(/class="pbetd-free-card"/g) || []).length, 2);
  for (const expected of ['2 Free TD Targets', 'Travis Etienne', 'Marvin Harrison Jr.', 'TD TARGET', 'NO · RB · vs LV', 'ARI · RB · @ SEA', 'Red-zone role', 'Unlock all TD Targets →']) {
    assert.ok(t.includes(expected), `missing ${expected}\n${t}`);
  }
  assert.match(html, /<img src="https:\/\/a\.espncdn\.com\/i\/headshots\/nfl\/players\/full\/4239996\.png"/);
  assert.match(html, /data-pbetd-upgrade="1"/);
  assert.doesNotMatch(t, /%/);
});

test('UI · one target renders one card, never a filler second', () => {
  const payload = buildFreeTdPayload({ state: ALLOWED, rows: [target({ model_prob: 0.5 }, { name: 'Travis Etienne', gsis: '00-0036973' })], nowMs: NOW });
  const html = page.freeSampleHtml(payload);
  assert.equal((html.match(/class="pbetd-free-card"/g) || []).length, 1);
  assert.ok(plainText(html).includes('1 Free TD Target'));
  assert.match(html, /pbetd-free-grid one/);
});

test('UI · zero targets renders the clean empty state with the reason; a failed read renders nothing', () => {
  const payload = buildFreeTdPayload({ state: GATED, rows: [], nowMs: NOW });
  const html = page.freeSampleHtml(payload);
  const t = plainText(html);
  assert.equal((html.match(/class="pbetd-free-card"/g) || []).length, 0);
  assert.ok(t.includes('No qualified free TD targets yet'));
  assert.ok(t.includes('tracking phase'));
  assert.ok(t.includes('Unlock all TD Targets →'));
  assert.equal(page.freeSampleHtml(null), '');
  assert.equal(page.freeSampleHtml({ error: 'touchdown_targets_backend_unavailable' }), '');
});

test('UI · even a malformed payload with three targets renders at most two', () => {
  const rows = [0.5, 0.4].map(p => target({ model_prob: p }));
  const payload = buildFreeTdPayload({ state: ALLOWED, rows, nowMs: NOW });
  payload.targets.push({ ...payload.targets[0], target_id: 'extra' });
  assert.equal((page.freeSampleHtml(payload).match(/class="pbetd-free-card"/g) || []).length, 2);
});
