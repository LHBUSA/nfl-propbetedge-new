/* PBEcast TOUCHDOWN TARGETS — the per-game Pro module, end to end without a
 * browser.
 *
 *   server   api/_td-game-view.js (view=game) on the Vercel function and the
 *            Cloudflare contract: entitlement, locking, lifecycle, persistence
 *   detector td-live-hit.mjs + nfl-touchdown-target-hit-alerts v1.1: stale
 *            hits persisted but never announced, final backfill, idempotency
 *   browser  pbecast-td-targets-v1.js rendered in a VM: Pro cards, the locked
 *            shell, HIT / MISS / VOID, the play-by-play marker
 *
 * Fixtures are the REAL /api/nfl-live payloads captured 2026-09-27 (CIN @ PIT
 * 401872950). Only the network edge is faked. The full-browser proof at
 * 320-1440 is scripts/pbecast-td-targets-gate.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  gameView, lifecycle, rankTargets, shapeGameTarget, touchdownType, FREE_TARGET_FIELDS, GAME_TARGET_FIELDS,
} from '../api/_td-game-view.js';
import { evaluateTarget, FRESHNESS_MS } from '../workers/nfl-td-targets-shared/td-live-hit.mjs';
import { readPlayerScoring, gradeTarget } from '../workers/nfl-td-targets-shared/td-grading.mjs';
import { runDetection, claim } from '../workers/nfl-touchdown-target-hit-alerts/src/index.js';
import { hitsView } from '../api/_td-target-hits.js';
import { tdRecordsByScope } from '../api/_td-record-scope.js';
import handler, { driversFrom } from '../api/pbe-touchdown-targets.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const executable = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const fixture = id => JSON.parse(read(`tests/fixtures/td-hit/live-${id}.json`));
const CIN_PIT = '401872950';
const CHASE_TD = '2026-09-27T17:20:10Z'; // Ja'Marr Chase 3 Yd pass from Joe Burrow
const ms = iso => Date.parse(iso);

const PRIMARY_ID = '11111111-1111-4111-8111-111111111111';
const SECONDARY_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

function pick(id, name, espnPlayerId, extra = {}) {
  return {
    id,
    event_id: 'odds-cin-pit',
    season: 2026,
    week: 4,
    kickoff_ts: '2026-09-27T17:00:00.000Z',
    player_name: name,
    player_key: name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    market: 'player_anytime_td',
    model_prob: 0.4404,
    market_prob: 0.3812,
    edge_pct: 0.0592,
    confidence_bucket: 'A',
    market_price: 150,
    book: 'draftkings',
    target_rank: 'primary',
    projection_model_version: 'pbe-td-hazard-v1',
    selector_version: 3,
    publication_scope: 'tracking',
    status: 'open',
    created_at: '2026-09-27T15:10:00.000Z',
    model_snapshot: {
      player: { espn_id: espnPlayerId, gsis_id: '00-0036900', position: 'WR', team: 'CIN', opponent: 'PIT', name },
      event: { espn_id: CIN_PIT, away_team: 'Cincinnati Bengals', home_team: 'Pittsburgh Steelers' },
      probability: {
        published: 0.4404, lambda: 0.58,
        components: { red_zone_role: { available: true, factor: 1.21, player_rz_opportunities_per_game: 2.4, position_rz_opportunities_per_game: 1.3 } },
      },
      market: { probability: 0.3812, books: 5, vig_removed: true },
      ranked_pool: [{ player: 'Somebody Unpublished', probability: 0.31 }],
    },
    ...extra,
  };
}
const chase = extra => pick(PRIMARY_ID, "Ja'Marr Chase", '4362628', extra);
const wilson = extra => pick(SECONDARY_ID, 'Roman Wilson', '4431492', { target_rank: 'secondary', created_at: '2026-09-27T15:20:00.000Z', ...extra });

const EVALUATION = {
  espn_id: CIN_PIT, event_id: 'odds-cin-pit', season: 2026, week: 4, kickoff_ts: '2026-09-27T17:00:00.000Z',
  away_team: 'CIN', home_team: 'PIT', outcome: 'target_issued', reason: null, publication_scope: 'tracking', decided_at: '2026-09-27T16:45:00Z',
  primary_pick_id: PRIMARY_ID, secondary_pick_id: SECONDARY_ID,
};

/* A fake Supabase REST honouring the select= list, so a test can prove what a
 * branch did NOT read. */
function fakeDb({ picks = [chase(), wilson()], grades = [], hits = [], evaluation = EVALUATION } = {}) {
  const reads = [];
  const project = (rows, q) => {
    const sel = /(?:^|&)select=([^&]*)/.exec(q)?.[1];
    if (!sel || sel === '*') return rows;
    const cols = sel.split(',');
    return rows.map(row => Object.fromEntries(cols.filter(c => c in row).map(c => [c, row[c]])));
  };
  const sb = async (table, q) => {
    reads.push({ table, q: decodeURIComponent(q) });
    if (table === 'nfl_td_final_pregame_evaluation') return evaluation ? project([evaluation], q) : [];
    if (table === 'nfl_prop_picks') {
      const ids = /id=in\.\(([^)]*)\)/.exec(q)?.[1]?.split(',').map(x => x.replace(/"/g, ''));
      return project(picks.filter(p => ['open', 'graded'].includes(p.status) && (!ids || ids.includes(p.id))), q);
    }
    if (table === 'nfl_prop_pick_grades') return project(grades, q);
    if (table === 'nfl_td_target_hit_events') return project(hits, q);
    throw new Error(`unexpected table ${table}`);
  };
  return { sb, reads };
}
function res() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
}
const send = (r, status, body, cache = 'private, no-store, max-age=0') => { r.statusCode = status; r.setHeader('cache-control', cache); r.end(JSON.stringify(body)); };
async function callGame({ tier = 'pro', db = fakeDb(), query = { espn_id: CIN_PIT }, nowMs = ms('2026-09-27T17:30:00Z') } = {}) {
  const r = res();
  await gameView({ res: r, send, sb: db.sb, secret: 's', query, resolveAccess: async () => ({ tier }), driversFrom, nowMs });
  return { status: r.statusCode, body: JSON.parse(r.body), cache: r.headers['cache-control'], raw: r.body, reads: db.reads };
}
function hitRow(target, detection = 'live_fresh', over = {}) {
  const v = evaluateTarget({ target, detail: fixture(CIN_PIT), nowMs: ms(CHASE_TD) + 60_000 });
  return { id: 1, detected_at: '2026-09-27T17:21:10.123Z', ...v.row, detection, ...over };
}

const SECRETS = ["Ja'Marr Chase", 'Roman Wilson', '4362628', '4431492', '0.4404', '44.0', 'model_prob', 'model_snapshot',
  'ranked_pool', 'Somebody Unpublished', 'RED-ZONE', 'red-zone', 'play_id', 'pass from', 'headshot', 'draftkings', 'reasons', PRIMARY_ID, SECONDARY_ID];

/* ============================================================== ENTITLEMENT */

test('entitlement · a Pro / All Access session receives the ranked targets with probability, confidence and reasons', async () => {
  const out = await callGame({ tier: 'pro' });
  assert.equal(out.status, 200);
  assert.equal(out.body.access, 'pro');
  assert.deepEqual(out.body.targets.map(t => [t.rank, t.target_rank, t.player.name, t.state]),
    [[1, 'primary', "Ja'Marr Chase", 'PENDING'], [2, 'secondary', 'Roman Wilson', 'PENDING']]);
  const t = out.body.targets[0];
  assert.equal(t.model.probability, 0.4404);
  assert.equal(t.model.confidence, 'A');
  assert.equal(t.model.edge_pp, 5.92);
  assert.equal(t.player.headshot_url, 'https://a.espncdn.com/i/headshots/nfl/players/full/4362628.png');
  assert.ok(t.reasons.some(r => r.key === 'red_zone_role'));
  assert.match(t.primary_reason, /red-zone opportunities per game/);
  /* the raw snapshot never leaves, even for Pro */
  assert.equal(out.raw.includes('ranked_pool'), false);
  assert.equal(out.raw.includes('Somebody Unpublished'), false);
  assert.equal(out.cache, 'private, no-store, max-age=0');
});

for (const tier of ['anonymous', 'no_entitlement', 'unavailable', 'garbage']) {
  test(`entitlement · ${tier} receives the shell and counts only — no name, face, probability, reason or play`, async () => {
    const db = fakeDb({ hits: [hitRow(chase())] });
    const out = await callGame({ tier, db });
    assert.equal(out.status, 200);
    assert.equal(out.body.access, 'locked');
    assert.equal('targets' in out.body, false);
    /* live: the number of targets only; a HIT count that moves after a touchdown would name the scorer */
    assert.deepEqual(out.body.counts, { targets: 2, settled: false });
    for (const secret of SECRETS) assert.equal(out.raw.includes(secret), false, `${tier} response leaked ${secret}`);
    /* not merely stripped: the free branch never SELECTED them */
    const pickRead = out.reads.find(r => r.table === 'nfl_prop_picks');
    assert.match(pickRead.q, new RegExp(`select=${FREE_TARGET_FIELDS}(&|$)`));
    for (const read of out.reads) {
      for (const column of ['player_name', 'model_prob', 'model_snapshot', 'play_id', 'play_text', 'headshot_url']) {
        assert.equal(read.q.includes(column), false, `${tier} branch selected ${column} from ${read.table}`);
      }
    }
  });
}

test('entitlement · an access check that throws is locked, never granted', async () => {
  const db = fakeDb();
  const r = res();
  await gameView({ res: r, send, sb: db.sb, secret: 's', query: { espn_id: CIN_PIT }, resolveAccess: async () => { throw new Error('auth down'); }, driversFrom });
  const body = JSON.parse(r.body);
  assert.equal(body.access, 'locked');
  assert.equal(body.access_reason, 'unavailable');
  assert.equal('targets' in body, false);
});

test('entitlement · the real Vercel handler: an unauthenticated request (no cookie) is locked', async () => {
  const saved = { fetch: globalThis.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  const seen = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    seen.push(decodeURIComponent(url.pathname + url.search));
    const table = url.pathname.split('/').pop();
    const body = table === 'nfl_td_final_pregame_evaluation' ? [EVALUATION]
      : table === 'nfl_prop_picks' ? [{ id: PRIMARY_ID, target_rank: 'primary', status: 'open' }] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = res();
    await handler({ method: 'GET', headers: {}, query: { view: 'game', espn_id: CIN_PIT } }, r);
    const body = JSON.parse(r.body);
    assert.equal(r.statusCode, 200);
    assert.equal(body.access, 'locked');
    assert.equal(body.access_reason, 'anonymous');
    assert.equal(body.counts.targets, 1);
    assert.match(r.headers['cache-control'], /private, no-store/);
    assert.equal(seen.some(q => /player_name|model_snapshot|model_prob/.test(q)), false);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
});

test('entitlement · view=game is routed identically on the Vercel function and the Cloudflare contract, tier decided server-side', () => {
  for (const path of ['api/pbe-touchdown-targets.js', 'workers/nfl-touchdown-targets-api/src/contract.js']) {
    const src = read(path);
    assert.match(src, /if \(view === 'game'\) return await gameView\(\{ res, send, sb, secret, query: req\.query \|\| \{\}, resolveAccess: \(\) => gameAccess\(req\), driversFrom \}\);/, path);
    assert.match(src, /return \{ tier: auth\.pro === true \? 'pro' : 'no_entitlement' \};/, path);
    assert.match(src, /if \(auth\?\.degraded\) return \{ tier: 'unavailable' \};/, path);
  }
  /* the Vercel tier comes from the one NFL session authority (NFL ledger, then All Access) */
  assert.match(read('api/pbe-touchdown-targets.js'), /async function gameAccess\(req\) \{\n  const auth = await getNflSession\(req\);/);
});

test('entitlement · the browser module holds no identity of its own and asks only the gated view', () => {
  const src = executable(read('pbecast-td-targets-v1.js'));
  assert.match(src, /\$\{API\}\?view=game&espn_id=/);
  assert.equal(/view=(current|week|hits)\b/.test(src), false);
  assert.equal(/localStorage/.test(src), false);
  /* no name-based image or player lookup anywhere */
  assert.equal(/headshots\/nfl\/players\/full\/\$\{/.test(src), false);
  assert.equal(/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(src), false);
});

test('bad input · a non-ESPN id is refused before any read or entitlement check', async () => {
  const db = fakeDb();
  let asked = false;
  const r = res();
  await gameView({ res: r, send, sb: db.sb, secret: 's', query: { espn_id: '1;drop' }, resolveAccess: async () => { asked = true; return { tier: 'pro' }; }, driversFrom });
  assert.equal(r.statusCode, 400);
  assert.equal(asked, false);
  assert.equal(db.reads.length, 0);
});

/* ================================================================== LOCKING */

test('locking · pregame targets render with the set unlocked; at kickoff the set is reported LOCKED', async () => {
  const pre = await callGame({ nowMs: ms('2026-09-27T16:59:59Z') });
  assert.equal(pre.body.game.locked, false);
  const post = await callGame({ nowMs: ms('2026-09-27T17:00:00Z') });
  assert.equal(post.body.game.locked, true);
  assert.equal(post.body.game.locked_at, '2026-09-27T17:00:00.000Z');
  assert.equal(post.body.targets[0].locked.before_kickoff, true);
});

test('locking · the database refuses a post-kickoff issue or withdrawal, and the orchestrator never touches a started game', () => {
  const sql = read('migrations/nfl_td_targets_binary_market_v1.sql');
  assert.match(sql, /nfl_prop_pick_binary_issued_pregame/);
  assert.match(sql, /created_at < kickoff_ts/);
  assert.match(sql, /nfl_td_no_withdrawal_after_kickoff/);
});

test('locking · view=game is read-only: many concurrent readers produce reads only, never a write', async () => {
  const db = fakeDb({ hits: [hitRow(chase())] });
  await Promise.all(Array.from({ length: 12 }, (_, i) => gameView({ res: res(), send, sb: db.sb, secret: 's', query: { espn_id: CIN_PIT }, resolveAccess: async () => ({ tier: i % 2 ? 'pro' : 'anonymous' }), driversFrom })));
  assert.ok(db.reads.length > 0);
  /* sb() is a GET-only reader; the module has no write path to call */
  assert.equal(/method:|POST|rpc\//.test(executable(read('api/_td-game-view.js'))), false);
});

/* ============================================================ HIT DETECTION */

test('hit · the target\'s own receiving touchdown is a HIT with the real play, by ESPN athlete id', () => {
  const v = evaluateTarget({ target: chase(), detail: fixture(CIN_PIT), nowMs: ms(CHASE_TD) + 60_000 });
  assert.equal(v.outcome, 'hit');
  assert.equal(v.row.detection, 'live_fresh');
  assert.equal(v.row.espn_player_id, '4362628');
  assert.match(v.row.play_text, /^Ja'Marr Chase 3 Yd pass from Joe Burrow/);
  assert.ok(v.row.play_id);
});

test('hit · a touchdown by a player who is not a target changes nothing', async () => {
  /* Roman Wilson (a real TD in this fixture) is not a target here */
  const db = fakeDb({ picks: [chase({ status: 'open' })], hits: [] });
  const out = await callGame({ db });
  assert.deepEqual(out.body.targets.map(t => t.state), ['PENDING']);
  const burrow = pick(OTHER_ID, 'Joe Burrow', '3915511', { model_snapshot: { ...chase().model_snapshot, player: { espn_id: '3915511', position: 'QB', team: 'CIN' } } });
  assert.equal(evaluateTarget({ target: burrow, detail: fixture(CIN_PIT), nowMs: ms(CHASE_TD) + 60_000 }).outcome, 'no_td');
});

function workerHarness({ targets, details }) {
  const rows = new Map();
  const byPlay = new Map();
  const posts = [];
  const env = {
    SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', NFL_SITE_URL: 'https://nfl.test',
    PICKS_KV: { put: async () => {}, get: async () => null },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.host === 'nfl.test') return ok(details[url.searchParams.get('event')]);
    const table = url.pathname.split('/').pop();
    if (method === 'GET' && table === 'nfl_prop_picks') {
      assert.match(decodeURIComponent(url.search), /status=in\.\(open,graded\)/);
      return ok(targets);
    }
    if (method === 'GET' && table === 'nfl_td_target_hit_events') return ok([...rows.values()].map(r => ({ pick_id: r.pick_id })));
    if (method === 'POST' && table === 'nfl_td_target_hit_events') {
      const [row] = JSON.parse(init.body);
      posts.push(row);
      if (rows.has(row.pick_id)) return ok([]);                               // UNIQUE (pick_id)
      const playKey = `${row.espn_id}|${row.play_id}`;
      if (row.play_id && byPlay.has(playKey)) return new Response('{"code":"23505"}', { status: 409 }); // UNIQUE (espn_id, play_id)
      rows.set(row.pick_id, row);
      if (row.play_id) byPlay.set(playKey, row.pick_id);
      return ok([row]);
    }
    throw new Error(`unexpected ${method} ${table}`);
  };
  return { env, rows, posts };
}

test('idempotency · the same upstream scoring play seen on repeated Worker ticks writes ONE row', async () => {
  const h = workerHarness({ targets: [chase()], details: { [CIN_PIT]: fixture(CIN_PIT) } });
  for (let i = 1; i <= 5; i += 1) await runDetection(h.env, { nowMs: ms(CHASE_TD) + i * 20_000 });
  assert.equal(h.rows.size, 1);
  assert.equal([...h.rows.values()][0].detection, 'live_fresh');
});

test('idempotency · a second target row credited on the SAME scoring play is a duplicate (409), and the tick continues', async () => {
  const twin = chase({ id: OTHER_ID, target_rank: 'secondary' });
  const h = workerHarness({ targets: [chase(), twin], details: { [CIN_PIT]: fixture(CIN_PIT) } });
  const run = await runDetection(h.env, { nowMs: ms(CHASE_TD) + 60_000 });
  assert.equal(run.error, undefined);
  assert.equal(run.counts.hits_detected, 1);
  assert.equal(run.counts.duplicate_hits, 1);
  assert.equal(h.rows.size, 1);
});

test('idempotency · claim(): 409 from the scoring-play index is false, other failures still throw', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 409 });
  assert.equal(await claim({ SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }, { pick_id: PRIMARY_ID }), false);
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  await assert.rejects(claim({ SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }, { pick_id: PRIMARY_ID }), /supabase_500/);
});

test('idempotency · the database enforces one row per target AND one row per ESPN scoring play', () => {
  const sql = read('migrations/nfl_td_target_hit_events_detection_v1.sql');
  assert.match(sql, /create unique index if not exists nfl_td_target_hit_events_play_unique\s+on public\.nfl_td_target_hit_events \(espn_id, play_id\)\s+where play_id is not null;/);
  assert.match(sql, /check \(detection in \('live_fresh', 'live_stale', 'final_backfill'\)\)/);
  assert.match(sql, /add column if not exists detection text not null default 'live_fresh'/);
  assert.match(read('migrations/nfl_td_target_hit_events_v1.sql'), /constraint nfl_td_target_hit_events_pick_unique unique \(pick_id\)/);
});

test('idempotency · a late hit is PERSISTED (live_stale) for the permanent HIT but never announced', async () => {
  const h = workerHarness({ targets: [chase()], details: { [CIN_PIT]: fixture(CIN_PIT) } });
  const late = ms(CHASE_TD) + FRESHNESS_MS + 60_000;
  const a = await runDetection(h.env, { nowMs: late });
  assert.equal(a.counts.hits_detected, 0);
  assert.equal(a.counts.stale_recorded, 1);
  assert.deepEqual(a.published, []);
  const b = await runDetection(h.env, { nowMs: late + 60_000 });
  assert.equal(b.counts.already_published, 1);
  assert.equal(h.rows.size, 1);
  assert.equal([...h.rows.values()][0].detection, 'live_stale');
  /* view=hits (the rail's feed) only ever reads live_fresh */
  const reads = [];
  const sb = async (table, q) => { reads.push(decodeURIComponent(q)); return []; };
  await hitsView({ res: res(), send, sb, secret: 's', query: { after_id: '0' } });
  await hitsView({ res: res(), send, sb, secret: 's', query: {} });
  assert.ok(reads.filter(q => q.includes('select=id,')).every(q => q.includes('detection=eq.live_fresh')));
});

test('idempotency · a target graded before the Worker saw the touchdown still gets its hit row, not announced', async () => {
  const h = workerHarness({ targets: [chase({ status: 'graded' })], details: { [CIN_PIT]: fixture(CIN_PIT) } });
  const run = await runDetection(h.env, { nowMs: ms(CHASE_TD) + FRESHNESS_MS * 3 });
  assert.equal(run.counts.stale_recorded, 1);
  assert.equal([...h.rows.values()][0].detection, 'live_stale');
});

test('backfill · final_backfill records the real play for a graded win and never needs freshness', () => {
  const v = evaluateTarget({ target: chase({ status: 'graded' }), detail: fixture(CIN_PIT), mode: 'final_backfill', statuses: ['graded'], nowMs: ms('2026-09-29T00:00:00Z') });
  assert.equal(v.outcome, 'hit');
  assert.equal(v.row.detection, 'final_backfill');
  assert.match(v.row.play_text, /^Ja'Marr Chase 3 Yd pass/);
  /* the live default still refuses a graded target */
  assert.equal(evaluateTarget({ target: chase({ status: 'graded' }), detail: fixture(CIN_PIT), nowMs: ms(CHASE_TD) }).outcome, 'not_open');
  const src = read('scripts/td-hit-backfill.mjs');
  assert.match(src, /result=eq\.win/);
  assert.match(src, /mode: 'final_backfill', statuses: \['graded'\]/);
  assert.match(src, /const APPLY = process\.argv\.includes\('--apply'\);/);
});

/* ================================================================== GRADING */

test('grading · lifecycle: win = HIT, loss = MISS, void = VOID, open = PENDING, a live hit before the grade = HIT, the grade always wins', () => {
  assert.equal(lifecycle({ status: 'open' }), 'PENDING');
  assert.equal(lifecycle({ status: 'open', hit: {} }), 'HIT');
  assert.equal(lifecycle({ status: 'graded', grade: { result: 'win' } }), 'HIT');
  assert.equal(lifecycle({ status: 'graded', grade: { result: 'loss' } }), 'MISS');
  assert.equal(lifecycle({ status: 'graded', grade: { result: 'void' } }), 'VOID');
  assert.equal(lifecycle({ status: 'graded', grade: { result: 'loss' }, hit: {} }), 'MISS');
});

test('grading · the existing void policy is reused: only an explicit did-not-play voids; absence is a MISS', () => {
  const dnp = { matched: true, did_not_play: true, participation_observed: false, offensive_td: 0 };
  assert.equal(gradeTarget({ target: chase(), seen: dnp }).result, 'void');
  const absent = readPlayerScoring([], "Ja'Marr Chase");
  assert.equal(gradeTarget({ target: chase(), seen: absent }).result, 'loss');
  assert.equal(gradeTarget({ target: chase({ status: 'killed' }), seen: absent }).result, 'void');
});

test('grading · pending targets at the final read MISS once graded; the HIT stays HIT', async () => {
  const db = fakeDb({
    picks: [chase({ status: 'graded' }), wilson({ status: 'graded' })],
    grades: [{ pick_id: PRIMARY_ID, result: 'win', final_value: 1, graded_at: '2026-09-27T20:40:00Z' }, { pick_id: SECONDARY_ID, result: 'loss', final_value: 0, graded_at: '2026-09-27T20:40:00Z' }],
    hits: [hitRow(chase())],
  });
  const out = await callGame({ db, nowMs: ms('2026-09-27T21:00:00Z') });
  assert.deepEqual(out.body.targets.map(t => t.state), ['HIT', 'MISS']);
  assert.deepEqual(out.body.counts, { targets: 2, hit: 1, miss: 1, void: 0, pending: 0 });
});

/* ============================================================= PERSISTENCE */

test('persistence · a reload of a live game shows the HIT with the real play from the persisted row', async () => {
  const db = fakeDb({ hits: [hitRow(chase(), 'live_stale')] });
  const first = await callGame({ db });
  const second = await callGame({ db });
  for (const out of [first, second]) {
    const t = out.body.targets[0];
    assert.equal(t.state, 'HIT');
    assert.equal(t.hit.touchdown_type, 'receiving');
    assert.equal(t.hit.yards, 3);
    assert.equal(t.hit.period, 1);
    assert.equal(t.hit.announce, false);
  }
  assert.deepEqual(first.body, second.body);
});

test('persistence · a completed game keeps the HIT and its play after the grade (final_backfill row)', async () => {
  const db = fakeDb({
    picks: [chase({ status: 'graded' })],
    grades: [{ pick_id: PRIMARY_ID, result: 'win', final_value: 1 }],
    hits: [hitRow(chase(), 'final_backfill')],
  });
  const out = await callGame({ db, nowMs: ms('2026-10-02T00:00:00Z') });
  assert.equal(out.body.targets[0].state, 'HIT');
  assert.match(out.body.targets[0].hit.text, /^Ja'Marr Chase 3 Yd pass/);
});

test('persistence · the record is computed from grades only, so hit rows can never inflate it', () => {
  const settled = [
    { publication_scope: 'tracking', target_rank: 'primary', grade: { result: 'win' } },
    { publication_scope: 'tracking', target_rank: 'primary', grade: { result: 'loss' } },
    { publication_scope: 'tracking', target_rank: 'secondary', grade: { result: 'void' } },
  ];
  const r = tdRecordsByScope({ settled, open: [{ publication_scope: 'tracking', target_rank: 'primary' }] });
  assert.deepEqual([r.tracking.all.wins, r.tracking.all.losses, r.tracking.all.voids, r.tracking.all.pending], [1, 1, 1, 1]);
  assert.equal(r.tracking.all.hit_rate, 0.5);
  assert.equal(r.official.all.graded, 0);
  assert.equal(/nfl_td_target_hit_events/.test(read('api/_td-record-scope.js')), false);
});

test('shape · ranks: primary is #1, secondaries follow in issuance order; touchdown type from the play type', () => {
  const later = wilson({ id: OTHER_ID, created_at: '2026-09-27T16:00:00.000Z', player_name: 'Later Secondary' });
  assert.deepEqual(rankTargets([later, wilson(), chase()]).map(x => [x.rank, x.row.id]), [[1, PRIMARY_ID], [2, SECONDARY_ID], [3, OTHER_ID]]);
  assert.equal(touchdownType('Passing Touchdown'), 'receiving');
  assert.equal(touchdownType('Rushing Touchdown'), 'rushing');
  assert.equal(touchdownType('Kickoff Return Touchdown'), null);
  const t = shapeGameTarget({ row: chase(), rank: 1, grade: null, hit: { ...hitRow(chase()), headshot_url: 'javascript:alert(1)' }, driversFrom });
  assert.equal(t.player.headshot_url, 'https://a.espncdn.com/i/headshots/nfl/players/full/4362628.png');
  assert.ok(GAME_TARGET_FIELDS.includes('model_snapshot'));
});

/* ======================================================================= UI */

function loadModule() {
  const store = new Map();
  const listeners = {};
  const window = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatchEvent() {},
    App: { current: 'pbecast', nav() {} },
    PBEcastV6: { state: { activeId: CIN_PIT, detail: { game: { id: CIN_PIT, status: { semantics: 'LIVE' } } } } },
  };
  const document = { hidden: false, addEventListener() {}, querySelector: () => null };
  const sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  window.window = window;
  window.document = document;
  const context = vm.createContext({ window, document, sessionStorage, setTimeout: () => 0, clearTimeout() {}, Date, Math, JSON, Number, String, Array, Set, Map, Object, Promise, console, CSS: { escape: s => s }, fetch: async () => new Response('{}') });
  vm.runInContext(read('pbecast-td-targets-v1.js'), context);
  return window.PBEcastTDTargets;
}

async function payload(tier, dbOpts) {
  return (await callGame({ tier, db: fakeDb(dbOpts) })).body;
}

test('ui · Pro rendering: ranked cards with face, name, probability, confidence and the reasons', async () => {
  const M = loadModule();
  M.store.set(CIN_PIT, { data: await payload('pro'), at: Date.now() });
  const html = M.html(CIN_PIT);
  assert.match(html, /🎯 TOUCHDOWN TARGETS/);
  assert.match(html, /PBE identified 2 touchdown targets for this matchup\./);
  assert.match(html, /TARGET #1<small>PRIMARY<\/small>/);
  assert.match(html, /TARGET #2<small>SECONDARY<\/small>/);
  assert.match(html, /Ja&#39;Marr Chase/);
  assert.match(html, /44\.0%/);
  assert.match(html, /<dt>CONFIDENCE<\/dt><dd>A<\/dd>/);
  assert.match(html, /players\/full\/4362628\.png/);
  assert.match(html, /RED-ZONE ROLE/);
  assert.match(html, /class="pbetdc-badge is-pending">PENDING/);
});

test('ui · locked rendering (free): the teaser and the unlock, and nothing identifying', async () => {
  const M = loadModule();
  M.store.set(CIN_PIT, { data: await payload('anonymous'), at: Date.now() });
  const html = M.html(CIN_PIT);
  assert.match(html, /PBE identified 2 touchdown targets for this matchup\./);
  assert.match(html, /🔒 Unlock with All Access Pro/);
  assert.match(html, /data-pbetdc-upgrade="1"/);
  assert.equal((html.match(/class="pbetdc-ghost"/g) || []).length, 2);
  for (const secret of SECRETS) assert.equal(html.includes(secret), false, `locked html leaked ${secret}`);
  assert.equal(/<img/.test(html), false);
});

test('ui · HIT: gold state, "TOUCHDOWN TARGET HIT", yards + type + quarter + clock from the real play', async () => {
  const M = loadModule();
  M.store.set(CIN_PIT, { data: await payload('pro', { hits: [hitRow(chase(), 'live_fresh', { clock: '6:42', period: 2, source: { ...hitRow(chase()).source, play_yards: 18 } })] }), at: Date.now() });
  const html = M.html(CIN_PIT);
  assert.match(html, /class="pbetdc-card is-hit/);
  assert.match(html, /✓ TOUCHDOWN HIT/);
  assert.match(html, /🎯 TOUCHDOWN TARGET HIT<\/span><b>18-yard receiving touchdown<\/b><em>Q2 · 6:42<\/em>/);
  assert.match(html, /class="pbetdc is-pro has-hit"/);
});

test('ui · MISS and VOID read FINAL — MISS and VOID', async () => {
  const M = loadModule();
  M.store.set(CIN_PIT, { data: await payload('pro', {
    picks: [chase({ status: 'graded' }), wilson({ status: 'graded' })],
    grades: [{ pick_id: PRIMARY_ID, result: 'loss' }, { pick_id: SECONDARY_ID, result: 'void' }],
  }), at: Date.now() });
  const html = M.html(CIN_PIT);
  assert.match(html, /is-miss">FINAL — MISS/);
  assert.match(html, /is-void">VOID/);
  assert.match(html, /1 MISS · 1 VOID/);
});

test('ui · abstain / not evaluated render an honest empty state, never a fake target', async () => {
  const M = loadModule();
  M.store.set(CIN_PIT, { data: await payload('pro', { picks: [], evaluation: { ...EVALUATION, outcome: 'abstained', reason: 'no_credible_scorer_probability' } }), at: Date.now() });
  assert.match(M.html(CIN_PIT), /abstained: no player cleared the publication threshold/);
  M.store.set(CIN_PIT, { data: await payload('pro', { evaluation: null }), at: Date.now() });
  assert.match(M.html(CIN_PIT), /has not evaluated this game yet/);
});

test('ui · the play-by-play marker names the real play and is attached by ESPN play id only', async () => {
  const M = loadModule();
  const src = executable(read('pbecast-td-targets-v1.js'));
  assert.match(src, /\[data-play-id="\$\{sel\}"\], \[data-km-play="\$\{sel\}"\]/);
  assert.match(src, /🎯 PBE TOUCHDOWN TARGET HIT — /);
  assert.match(read('pbecast-v6.js'), /<article class="cast6-play \$\{p\?\.scoring_play\?'scoring':''\} \$\{turnover\(p\)\?'turnover':''\}" data-play-id="\$\{esc\(p\?\.id\?\?''\)\}">/);
  const h = M.hitLine({ touchdown_type: 'rushing', yards: 10, period: 3, clock: '4:05' });
  assert.equal(h.what, '10-yard rushing touchdown');
  assert.equal(h.when, 'Q3 · 4:05');
});

test('ui · celebration: once per target per session, only for an announceable hit, never for an old one', async () => {
  const src = executable(read('pbecast-td-targets-v1.js'));
  assert.match(src, /if \(t\.state !== 'HIT' \|\| !t\.hit\?\.announce \|\| done\.has\(t\.pick_id\)\) continue;/);
  assert.match(src, /const FRESH_CELEBRATION_MS = 3 \* 60 \* 1000;/);
  assert.equal(/AudioContext|\.play\(\)/.test(src), false);
  assert.match(read('pbecast-td-targets-v1.css'), /@media \(prefers-reduced-motion:reduce\)\{\.pbetdc-card\.is-celebrate\{animation:none/);
});

test('ui · placement: field -> Game Pulse -> TOUCHDOWN TARGETS -> Key Moments -> the full game log', () => {
  const src = read('pbecast-command-v1.js');
  assert.match(src, /place\(tdTargets, pulse\);\n    place\(moments, tdTargets\);/);
  assert.match(src, /window\.PBEcastTDTargets\?\.mount\?\.\(tdTargets, v6\(\)\);/);
  const loader = read('page-loader.js');
  assert.ok(loader.indexOf("./pbecast-td-targets-v1.js") > loader.indexOf("./pbecast-pulse-v1.js"));
  assert.ok(loader.indexOf("./pbecast-td-targets-v1.js") < loader.indexOf("./pbecast-command-v1.js"));
});

test('ui · mobile: single-column cards below 300px, no fixed widths wider than a 320 phone', () => {
  const css = read('pbecast-td-targets-v1.css');
  assert.match(css, /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,300px\),1fr\)\)/);
  const widths = [...css.matchAll(/(?:^|[;{])\s*(?:min-)?width:(\d+)px/g)].map(m => Number(m[1]));
  assert.ok(widths.every(w => w <= 280), `fixed widths ${widths}`);
  assert.match(css, /overflow-wrap:anywhere/);
});

/* ========================================= 2026-09-29: HIT IDENTITY IS PRO */

async function callHitsAs(tier, rows, query = {}) {
  const reads = [];
  const sb = async (table, q) => {
    const dq = decodeURIComponent(q);
    reads.push({ table, q: dq });
    if (/select=id&order=id\.desc/.test(dq)) return [{ id: 9 }];
    const sel = /select=([^&]*)/.exec(dq)[1].split(',');
    return rows.map(row => Object.fromEntries(sel.filter(c => c in row).map(c => [c, row[c]])));
  };
  const r = res();
  await hitsView({ res: r, send, sb, secret: 's', query, nowMs: ms('2026-09-27T17:22:00Z'), resolveAccess: async () => ({ tier }) });
  return { status: r.statusCode, body: JSON.parse(r.body), raw: r.body, cache: r.headers['cache-control'], reads };
}
const HIT_DB_ROW = () => ({ ...hitRow(chase()), id: 7, detected_at: '2026-09-27T17:21:10.123Z' });
const HIT_LEAKS = ["Ja'Marr Chase", 'ja marr chase', '4362628', '00-0036900', 'primary', 'secondary', '0.4404', 'model_prob', 'market_price',
  'confidence', 'CIN', 'PIT', '401872950', 'Burrow', 'Yd', 'headshot', '"play"', 'play_id', 'play_text', '"player"', 'clock', 'period', 'away_score', 'home_score', 'detected_at', 'live_stats', PRIMARY_ID, 'tracking'];

for (const tier of ['anonymous', 'no_entitlement', 'unavailable']) {
  test(`LIVE FREE · hits (${tier}): no event, count, cursor or timing; the table is never read; byte-identical before and after a hit`, async () => {
    const before = await callHitsAs(tier, [], {});
    const after = await callHitsAs(tier, [HIT_DB_ROW()], {});
    const incremental = await callHitsAs(tier, [HIT_DB_ROW()], { after_id: '0' });
    for (const out of [before, after, incremental]) {
      assert.equal(out.status, 200);
      assert.deepEqual(out.body, { view: 'hits', access: 'locked', events: [], hits: [], next_cursor: null, note: 'Live Touchdown Target signals are All Access Pro. Settled results are public in the Track Record.' });
      assert.equal(out.reads.length, 0, 'the locked tier never queries the hit table');
      assert.equal(out.cache, 'private, no-store, max-age=0');
      for (const leak of HIT_LEAKS) assert.equal(out.raw.includes(leak), false, `${tier} leaked ${leak}`);
    }
    assert.equal(before.raw, after.raw);
    assert.equal(after.raw, incremental.raw);
  });
}

test('hits · Pro / All Access: the full legitimate hit (player, ids, rank, probability, play, clock)', async () => {
  const out = await callHitsAs('pro', [HIT_DB_ROW()], { after_id: '0' });
  assert.equal(out.body.access, 'pro');
  const h = out.body.events[0];
  assert.equal(h.player.name, "Ja'Marr Chase");
  assert.equal(h.player.espn_id, '4362628');
  assert.equal(h.target.rank, 'primary');
  assert.equal(h.target.model_prob, 0.4404);
  assert.match(h.play.text, /^Ja'Marr Chase 3 Yd pass/);
  assert.equal(h.game.clock, '5:50');
});

test('LIVE FREE · hits: an access check that throws, or no resolver, is locked and silent', async () => {
  const r = res();
  await hitsView({ res: r, send, sb: async () => { throw new Error('must not read'); }, secret: 's', query: { after_id: '0' }, resolveAccess: async () => { throw new Error('down'); } });
  assert.deepEqual(JSON.parse(r.body).events, []);
  const r2 = res();
  await hitsView({ res: r2, send, sb: async () => { throw new Error('must not read'); }, secret: 's', query: {} });
  assert.equal(JSON.parse(r2.body).access, 'locked');
});

test('LIVE FREE · no alert-rail target event exists for a non-Pro reader: the poller and rail have no locked path', () => {
  const poller = executable(read('touchdown-hit-live-v1.js'));
  const rail = executable(read('pbe-breaking-v1.js'));
  assert.equal(/access === 'locked'|toLockedRailEvent/.test(poller), false);
  assert.match(poller, /if \(hit && hit\.pick_id\) \{/);
  assert.equal(/tdHitLockedBody|kind === 'upgrade'/.test(rail), false);
});

test('LIVE FREE · the detector\'s public /health carries no per-tick counts, published ids or tick times', () => {
  const src = executable(read('workers/nfl-touchdown-target-hit-alerts/src/index.js'));
  const health = src.slice(src.indexOf("if (url.pathname !== '/health')"), src.indexOf('async scheduled('));
  for (const banned of ['last_tick', 'last_work', 'counts', 'published']) assert.equal(health.includes(banned), false, banned);
});

test('LIVE PRO · a legitimate scorer event reaches the Pro rail immediately with player, play and PBEcast handoff', () => {
  const store = new Map();
  const window = { addEventListener() {}, dispatchEvent() {}, PBEBreaking: { offer() {}, PRIORITY: {}, CONFIG: {} } };
  const document = { hidden: false, addEventListener() {} };
  const sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  window.window = window;
  vm.runInContext(read('touchdown-hit-live-v1.js'), vm.createContext({ window, document, sessionStorage, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, Date, Math, JSON, Number, String, Array, Set, Map, Object, Promise, console }));
  const hit = { ...shapeHitFromRow(), access: 'pro' };
  const ev = JSON.parse(JSON.stringify(window.PBETouchdownHits._test.toRailEvent(hit)));
  assert.equal(ev.player.name, "Ja'Marr Chase");
  assert.equal(ev.cta[0].kind, 'pbecast');
  assert.equal(ev.cta[0].game_id, CIN_PIT);
});

/* ================================ FINAL FREE: settled public Track Record */

test('FINAL FREE · settled games are public proof: names and results, never probability, confidence, edge, drivers, Brier or snapshot', async () => {
  const { publicSettledTarget, settledEventIds } = await import('../api/_td-record-scope.js');
  const full = shapeGameTargetForRecord();
  const pub = publicSettledTarget(full);
  assert.equal(pub.player.name, "Ja'Marr Chase");
  assert.equal(pub.grade.result, 'win');
  const text = JSON.stringify(pub);
  for (const banned of ['probability', 'confidence', 'edge', 'ev_pct', 'drivers', 'brier', 'clv', 'model_snapshot', 'lambda', 'environment', 'artefact', 'game_market', 'availability']) {
    assert.equal(text.includes(banned), false, `public record leaked ${banned}`);
  }
  assert.deepEqual(Object.keys(pub.model), ['selector_version']);
  /* PARTIALLY GRADED: one open target keeps the whole game private */
  const unsettled = settledEventIds({ locked: [{ event_id: 'g1', status: 'graded' }, { event_id: 'g2', status: 'graded' }], open: [{ event_id: 'g2' }] });
  assert.deepEqual([...unsettled], ['g2']);
});

test('FINAL FREE · both record views: tier from the session authority, free rows = settled games only, stripped, totals over the same rows, private cache', () => {
  for (const path of ['api/pbe-touchdown-targets.js', 'workers/nfl-touchdown-targets-api/src/contract.js']) {
    const src = read(path);
    assert.ok(src.includes("try { pro = (await gameAccess(req)).tier === 'pro'; } catch (_) { pro = false; }"), path);
    assert.ok(src.includes('const visible = pro ? shaped : shaped.filter(t => !unsettled.has(String(t.event_id))).map(publicSettledTarget);'), path);
    assert.ok(src.includes('const recordsOut = pro ? records : tdRecordsByScope({ settled: shaped.filter(t => !unsettled.has(String(t.event_id))), open: openLocked });'), path);
    const view = src.slice(src.indexOf('async function trackRecordView('), src.indexOf('function modelView('));
    assert.ok(view.includes("'private, no-store, max-age=0'"), path);
    assert.equal(view.includes("'public, max-age"), false, path);
  }
});

/* ================================= 2026-09-29: CANONICAL LOCKED SET ONLY */

test('record · a target withdrawn before kickoff is excluded (kept, listed with its reason); totals recompute', async () => {
  const { splitCanonical, tdRecordsByScope: tally } = await import('../api/_td-record-scope.js');
  /* the real 401872956 shape: primary locked; the same secondary issued twice, withdrawn twice, voided by the grader */
  const rows = [
    { id: 'p', status: 'graded', publication_scope: 'tracking', target_rank: 'primary', grade: { result: 'loss' } },
    { id: 's1', status: 'graded', publication_scope: 'tracking', target_rank: 'secondary', grade: { result: 'void', settlement_note: { participation: 'target_withdrawn_before_kickoff' } } },
    { id: 's2', status: 'graded', publication_scope: 'tracking', target_rank: 'secondary', grade: { result: 'void', settlement_note: { participation: 'target_withdrawn_before_kickoff' } } },
    { id: 'k', status: 'killed', publication_scope: 'tracking', target_rank: 'secondary', grade: null },
    { id: 'r', status: 'superseded', publication_scope: 'tracking', target_rank: 'primary', grade: { result: 'win' } },
  ];
  const { locked, excluded } = splitCanonical({ rows, evaluations: [{ primary_pick_id: 'p', secondary_pick_id: null }] });
  assert.deepEqual(locked.map(r => r.id), ['p']);
  assert.deepEqual(excluded.map(x => [x.id, x.reason]), [['s1', 'withdrawn_before_kickoff'], ['s2', 'withdrawn_before_kickoff'], ['k', 'withdrawn_before_kickoff'], ['r', 'replaced_before_kickoff']]);
  const t = tally({ settled: locked }).tracking.all;
  assert.deepEqual([t.wins, t.losses, t.voids], [0, 1, 0]);
});

test('record · both record views apply the canonical rule and publish the exclusions', () => {
  for (const path of ['api/pbe-touchdown-targets.js', 'workers/nfl-touchdown-targets-api/src/contract.js']) {
    const src = read(path);
    assert.ok(src.includes("sb('nfl_td_final_pregame_evaluation', `select=primary_pick_id,secondary_pick_id${filter}&limit=2000`, secret)"), path);
    assert.ok(src.includes('excluded_from_record: visibleExcluded.map'), path);
    assert.ok(src.includes('const openLocked = splitCanonical({ rows: open, evaluations: finals }).locked;'), path);
  }
});

test('game view · only the canonical locked set is shown; a withdrawn secondary never appears', async () => {
  const withdrawn = wilson({ id: OTHER_ID, status: 'graded', player_name: 'Withdrawn Secondary' });
  const db = fakeDb({ picks: [chase(), withdrawn], evaluation: { ...EVALUATION, secondary_pick_id: null } });
  const out = await callGame({ db });
  assert.deepEqual(out.body.targets.map(t => t.player.name), ["Ja'Marr Chase"]);
  assert.ok(out.reads.find(r => r.table === 'nfl_prop_picks').q.includes(`id=in.("${PRIMARY_ID}")`));
});

test('game view · free counts: live = number of targets only; once every target is graded the tally is public', async () => {
  const live = await callGame({ tier: 'anonymous', db: fakeDb({ hits: [hitRow(chase())] }) });
  assert.deepEqual(live.body.counts, { targets: 2, settled: false });
  const settled = await callGame({ tier: 'anonymous', db: fakeDb({
    picks: [chase({ status: 'graded' }), wilson({ status: 'graded' })],
    grades: [{ pick_id: PRIMARY_ID, result: 'win' }, { pick_id: SECONDARY_ID, result: 'loss' }],
  }) });
  assert.deepEqual(settled.body.counts, { targets: 2, hit: 1, miss: 1, void: 0, pending: 0, settled: true });
  for (const secret of SECRETS) assert.equal(settled.raw.includes(secret), false);
});

test('audit · scripts/td-record-audit.mjs checks every graded target against the canonical set, kickoff, grade, duplicates and hit rows', () => {
  const src = read('scripts/td-record-audit.mjs');
  for (const rule of ['created_before_kickoff', 'in_canonical_locked_set', 'one_grade', 'no_duplicate_rank', 'no_duplicate_player', 'win_has_scoring_play', 'no_lifecycle_after_kickoff']) {
    assert.ok(src.includes(rule), rule);
  }
});

function shapeHitFromRow() {
  const row = { id: 7, ...hitRow(chase()), id: 7 };
  return {
    id: row.id, pick_id: row.pick_id, detected_at: row.detected_at,
    game: { espn_id: row.espn_id, away: row.away_team, home: row.home_team, away_score: row.away_score, home_score: row.home_score, period: row.period, clock: row.clock },
    player: { name: row.player_name, espn_id: row.espn_player_id, gsis_id: row.gsis_id, position: row.position, team: row.team, opponent: row.opponent, headshot_url: row.headshot_url },
    target: { rank: row.target_rank, publication_scope: row.publication_scope, model_prob: row.model_prob, market_price: row.market_price },
    play: { id: row.play_id, type: row.play_type, text: row.play_text }, live_stats: row.live_stats,
  };
}
function shapeGameTargetForRecord() {
  return {
    id: PRIMARY_ID, event_id: 'odds-cin-pit', espn_id: CIN_PIT, season: 2026, week: 4, kickoff_ts: '2026-09-27T17:00:00.000Z', away_team: 'CIN', home_team: 'PIT',
    target_rank: 'primary', status: 'graded', publication_scope: 'tracking',
    player: { name: "Ja'Marr Chase", key: 'ja marr chase', espn_id: '4362628', gsis_id: '00-0036900', position: 'WR', team: 'CIN', opponent: 'PIT', at_home: false },
    model: { probability: 0.44, version: 'pbe-td-hazard-v1', artefact_probability: 0.43, lambda: 0.58, selector_version: 2, confidence: 'A', label: 'x' },
    market: { probability: 0.38, books: 5, best_price: 150, best_book: 'DraftKings', disagreement_pp: 1 },
    edge_pp: 5.9, ev_pct: 12, environment: { temp_f: 60 }, game_market: { spread_points: -3 },
    drivers: [{ key: 'red_zone_role' }], availability: { reported: true },
    locked: { at: '2026-09-27T15:10:00Z', phase: 'locked', hours_to_kickoff: 2, before_kickoff: true },
    grade: { result: 'win', offensive_td: 1, units: 1.5, brier: 0.31, clv_prob: 0.01, clv_beat: true, graded_at: 'x', result_definition: 'pbe', non_offensive_td: false, settlement_note: {}, source: 'espn' },
    receipt: { seq: 1, chain_hash: 'c' },
  };
}

/* ================================= players open stats + Player DNA (GSIS) */

test('players · PBEcast cards: name and photo open the player\'s stats + Player DNA by GSIS id', async () => {
  const M = loadModule();
  M.store.set(CIN_PIT, { data: await payload('pro', { hits: [hitRow(chase())] }), at: Date.now() });
  const html = M.html(CIN_PIT);
  assert.equal((html.match(/data-pbetdc-player="00-0036900" data-pbetdc-position="WR"/g) || []).length >= 2, true);
  assert.match(html, /title="Ja&#39;Marr Chase: stats \+ Player DNA"/);
  const marker = M.playerLink({ name: 'X', gsis_id: '00-0036900', position: 'WR' }, 'X');
  assert.match(marker, /data-pbetdc-player="00-0036900"/);
  /* no GSIS id, or a position without a DNA page: plain text, never a guessed link */
  assert.equal(M.playerLink({ name: 'K', gsis_id: '00-0036900', position: 'K' }, 'K'), 'K');
  assert.equal(M.playerLink({ name: 'N', gsis_id: null, position: 'WR' }, 'N'), 'N');
  const src = executable(read('pbecast-td-targets-v1.js'));
  assert.match(src, /sessionStorage\.setItem\('pbe\.playerdna\.focus'/);
  assert.match(src, /window\.PBETouchdownTargets\?\.openPlayer/);
});

test('players · Touchdown Targets page: every card and Track Record row name uses the one GSIS link', () => {
  const src = read('touchdown-targets-v1.js');
  assert.ok(src.includes('<p class="pbetd-name">${playerLink(player)}</p>'));
  assert.ok(src.includes('<td class="player">${playerLink(target.player)}</td>'));
  assert.ok(src.includes('    openPlayer,\n    playerLink,'));
});

test('players · the public settled record carries the ids a link needs and still no model internals', async () => {
  const { publicSettledTarget } = await import('../api/_td-record-scope.js');
  const pub = publicSettledTarget({ id: 'x', player: { name: 'A', gsis_id: '00-0000001', espn_id: '1', position: 'RB' }, model: { probability: 0.4, selector_version: 2 }, grade: { result: 'win', brier: 0.2 } });
  assert.deepEqual([pub.player.gsis_id, pub.player.position], ['00-0000001', 'RB']);
  assert.equal(JSON.stringify(pub).includes('probability') || JSON.stringify(pub).includes('brier'), false);
});
