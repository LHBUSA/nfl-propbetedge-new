/* PBE Touchdown Target LIVE HIT alerts — the server side.
 *
 * The detector (workers/nfl-td-targets-shared/td-live-hit.mjs), the one
 * publishing Worker (workers/nfl-touchdown-target-hit-alerts) and the public
 * read (api/_td-target-hits.js behind view=hits, on both the Vercel function
 * and the Cloudflare contract).
 *
 * Fixtures are REAL /api/nfl-live payloads captured 2026-09-27 during CIN @ PIT
 * (401872950) and KC @ MIA (401872952), trimmed to the fields the detector
 * reads. Cases the live slate did not supply (a QB rushing touchdown, a return
 * touchdown, a defensive touchdown, a second touchdown) are built by editing a
 * copy of those payloads in exactly the shape ESPN publishes them.
 *
 * Only the network edge is faked: Supabase REST (with the UNIQUE (pick_id)
 * constraint emulated), /api/nfl-live and KV.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { readPlayerScoring, gradeTarget } from '../workers/nfl-td-targets-shared/td-grading.mjs';
import {
  evaluateTarget, scorerFromScoringText, liveStatLine, boxIdentity, FRESHNESS_MS,
} from '../workers/nfl-td-targets-shared/td-live-hit.mjs';
import worker, { runDetection, SERVICE } from '../workers/nfl-touchdown-target-hit-alerts/src/index.js';
import { hitsView, parseSince, shapeHit, scopeLabel } from '../api/_td-target-hits.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fixture = id => JSON.parse(read(`tests/fixtures/td-hit/live-${id}.json`));
const clone = value => JSON.parse(JSON.stringify(value));
const CIN_PIT = '401872950';
const KC_MIA = '401872952';
const ms = iso => Date.parse(iso);

/* Real wallclocks from the fixtures. */
const WALKER_TD = '2026-09-27T17:05:14Z'; // Kenneth Walker III 10 Yd Rush
const WILSON_TD = '2026-09-27T17:07:02Z'; // Roman Wilson 38 Yd pass from Aaron Rodgers
const CHASE_TD = '2026-09-27T17:20:10Z';  // Ja'Marr Chase 3 Yd pass from Joe Burrow

let seq = 0;
function target(name, espnPlayerId, espnGame, extra = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    event_id: `odds-${espnGame}`,
    season: 2026,
    week: 4,
    kickoff_ts: '2026-09-27T17:00:00.000Z',
    player_name: name,
    player_key: name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    market: 'player_anytime_td',
    model_prob: 0.4404,
    market_price: 110,
    confidence_bucket: 'tracking',
    target_rank: 'primary',
    publication_scope: 'tracking',
    status: 'open',
    model_snapshot: {
      player: { espn_id: espnPlayerId, gsis_id: '00-0036900', position: 'WR', team: 'CIN', opponent: 'PIT', name },
      event: { espn_id: espnGame, away_team: 'Cincinnati Bengals', home_team: 'Pittsburgh Steelers' },
      probability: { published: 0.4404, components: { secret_component: { factor: 1.2 } } },
      ranked_pool: [{ player: 'Somebody Unhit', probability: 0.31 }],
    },
    ...extra,
  };
}
const chase = extra => target("Ja'Marr Chase", '4362628', CIN_PIT, extra);
const burrow = extra => target('Joe Burrow', '3915511', CIN_PIT, { ...extra, model_snapshot: { ...chase().model_snapshot, player: { espn_id: '3915511', position: 'QB', team: 'CIN' } } });

/* ---- editing a real payload the way ESPN would publish a new score ---------- */
function group(detail, team, name) {
  return detail.player_stats.find(tb => tb.team.abbreviation === team).groups.find(g => g.name === name);
}
function setStat(detail, team, groupName, athlete, values) {
  const g = group(detail, team, groupName);
  let row = g.athletes.find(r => r.athlete.id === athlete.id);
  if (!row) { row = { athlete: { headshot: null, position: null, team, ...athlete }, starter: false, did_not_play: false, stats: g.labels.map(() => '0') }; g.athletes.push(row); }
  for (const [label, value] of Object.entries(values)) row.stats[g.labels.indexOf(label)] = String(value);
  return row;
}
function addScore(detail, { id, typeId, type, text, wallclock, away, home, period = 2, clock = '9:00' }) {
  detail.scoring_plays.push({ id, type, type_id: typeId, scoring_type: 'touchdown', text, period, clock, away_score: away, home_score: home, team: { id: '4', abbreviation: 'CIN' } });
  detail.plays.push({ id, text, type, type_id: typeId, period, clock, wallclock, scoring_play: true, score_value: null, participants: [] });
}

/* ================================================================ detector */

test('1 · primary target + live RUSHING touchdown -> one hit', () => {
  const walker = target('Kenneth Walker III', '4567048', KC_MIA);
  const v = evaluateTarget({ target: walker, detail: fixture(KC_MIA), nowMs: ms(WALKER_TD) + 60_000 });
  assert.equal(v.outcome, 'hit');
  assert.equal(v.row.pick_id, walker.id);
  assert.equal(v.row.play_type, 'Rushing Touchdown');
  assert.equal(v.row.play_text, 'Kenneth Walker III 10 Yd Rush (Harrison Butker Kick)');
  assert.equal(v.row.source.play_yards, 10);
  assert.equal(v.row.live_stats.rushing_td, 1);
  assert.equal(v.row.team, 'KC');
  assert.equal(v.row.opponent, 'MIA');
  assert.deepEqual([v.row.period, v.row.clock], [1, '12:54']);
});

test('2 · primary target + RECEIVING touchdown -> one hit, with the real headshot and stat line', () => {
  const t = chase();
  const v = evaluateTarget({ target: t, detail: fixture(CIN_PIT), nowMs: ms(CHASE_TD) + 45_000 });
  assert.equal(v.outcome, 'hit');
  assert.equal(v.row.play_type, 'Passing Touchdown');
  assert.equal(v.row.play_text, "Ja'Marr Chase 3 Yd pass from Joe Burrow (Evan McPherson Kick)");
  assert.equal(v.row.headshot_url, 'https://a.espncdn.com/i/headshots/nfl/players/full/4362628.png');
  assert.equal(v.row.source.headshot_authority, 'box_score_athlete');
  assert.deepEqual(v.row.live_stats, { targets: 3, receptions: 3, receiving_yards: 19, receiving_td: 1 });
  assert.deepEqual([v.row.away_team, v.row.away_score, v.row.home_team, v.row.home_score], ['CIN', 7, 'PIT', 7]);
  assert.equal(v.row.play_wallclock, '2026-09-27T17:20:10.000Z');
  assert.equal(v.row.source.result_definition, 'pbe_offensive_td_from_final_box_score');
  assert.equal(v.row.source.player_identity, 'espn_player_id');
  assert.equal(v.row.source.live_status, 'LIVE');
});

test('3 · QB target THROWS a touchdown -> NO hit (the passer is never the scorer)', () => {
  const detail = fixture(CIN_PIT);
  assert.equal(readPlayerScoring(detail.player_stats, 'joe burrow').offensive_td, 0);
  for (const nowMs of [ms(CHASE_TD) + 30_000, ms(CHASE_TD) + 10 * 60_000]) {
    assert.equal(evaluateTarget({ target: burrow(), detail, nowMs }).outcome, 'no_td');
  }
  /* Aaron Rodgers threw two in the same real payload. */
  const rodgers = target('Aaron Rodgers', '8439', CIN_PIT);
  assert.equal(evaluateTarget({ target: rodgers, detail, nowMs: ms(WILSON_TD) + 30_000 }).outcome, 'no_td');
  assert.equal(scorerFromScoringText("Ja'Marr Chase 3 Yd pass from Joe Burrow (Evan McPherson Kick)").name, "Ja'Marr Chase");
});

test('4 · QB target RUSHES for a touchdown -> hit', () => {
  const detail = fixture(CIN_PIT);
  setStat(detail, 'CIN', 'rushing', { id: '3915511', name: 'Joe Burrow' }, { CAR: 2, YDS: 4, AVG: '2.0', TD: 1, LONG: 3 });
  const wall = '2026-09-27T17:40:00Z';
  addScore(detail, { id: '401872950999', typeId: '68', type: 'Rushing Touchdown', text: 'Joe Burrow 1 Yd Rush (Evan McPherson Kick)', wallclock: wall, away: 14, home: 14 });
  const v = evaluateTarget({ target: burrow(), detail, nowMs: ms(wall) + 90_000 });
  assert.equal(v.outcome, 'hit');
  assert.equal(v.row.play_type, 'Rushing Touchdown');
  assert.equal(v.row.live_stats.rushing_td, 1);
});

test('5 · KICK-RETURN touchdown only -> NO hit', () => {
  const detail = fixture(CIN_PIT);
  setStat(detail, 'CIN', 'kickReturns', { id: '3116389', name: 'Samaje Perine' }, { NO: 2, YDS: 124, TD: 1 });
  const wall = '2026-09-27T17:41:00Z';
  addScore(detail, { id: '401872950998', typeId: '32', type: 'Kickoff Return Touchdown', text: 'Samaje Perine 98 Yd Kickoff Return (Evan McPherson Kick)', wallclock: wall, away: 14, home: 14 });
  const perine = target('Samaje Perine', '3116389', CIN_PIT);
  const seen = readPlayerScoring(detail.player_stats, perine.player_key);
  assert.equal(seen.non_offensive_td, 1);
  assert.equal(seen.offensive_td, 0);
  assert.equal(evaluateTarget({ target: perine, detail, nowMs: ms(wall) + 30_000 }).outcome, 'no_td');
});

test('6 · DEFENSIVE touchdown only -> NO hit', () => {
  const detail = fixture(CIN_PIT);
  setStat(detail, 'CIN', 'interceptions', { id: '4567098', name: 'Jordan Battle' }, { INT: 1, YDS: 40, TD: 1 });
  setStat(detail, 'CIN', 'defensive', { id: '4567098', name: 'Jordan Battle' }, { TD: 1 });
  const wall = '2026-09-27T17:42:00Z';
  addScore(detail, { id: '401872950997', typeId: '36', type: 'Interception Return Touchdown', text: 'Jordan Battle 40 Yd Interception Return (Evan McPherson Kick)', wallclock: wall, away: 14, home: 14 });
  const battle = target('Jordan Battle', '4567098', CIN_PIT);
  assert.equal(evaluateTarget({ target: battle, detail, nowMs: ms(wall) + 30_000 }).outcome, 'no_td');
});

test('10/11 · killed and superseded targets are ignored', () => {
  const detail = fixture(CIN_PIT);
  for (const status of ['killed', 'superseded', 'graded']) {
    assert.equal(evaluateTarget({ target: chase({ status }), detail, nowMs: ms(CHASE_TD) + 30_000 }).outcome, 'not_open');
  }
});

test('12 · wrong ESPN player identity -> ignored, never published', () => {
  const t = chase();
  t.model_snapshot.player.espn_id = '9999999';
  assert.equal(evaluateTarget({ target: t, detail: fixture(CIN_PIT), nowMs: ms(CHASE_TD) + 30_000 }).outcome, 'identity_mismatch');
  const missing = chase();
  delete missing.model_snapshot.player.espn_id;
  assert.equal(evaluateTarget({ target: missing, detail: fixture(CIN_PIT), nowMs: ms(CHASE_TD) + 30_000 }).outcome, 'identity_missing');
});

test('13 · a missing player headshot still publishes, with no image', () => {
  const detail = fixture(CIN_PIT);
  for (const g of detail.player_stats.flatMap(tb => tb.groups)) for (const r of g.athletes) if (r.athlete.id === '4362628') r.athlete.headshot = null;
  const v = evaluateTarget({ target: chase(), detail, nowMs: ms(CHASE_TD) + 30_000 });
  assert.equal(v.outcome, 'hit');
  assert.equal(v.row.headshot_url, null);
  assert.equal(v.row.source.headshot_authority, 'none');
});

test('14/15 · freshness: <= 5 minutes is a hit; older is stale_existing_hit and never an event', () => {
  const detail = fixture(CIN_PIT);
  assert.equal(evaluateTarget({ target: chase(), detail, nowMs: ms(CHASE_TD) + FRESHNESS_MS }).outcome, 'hit');
  const stale = evaluateTarget({ target: chase(), detail, nowMs: ms(CHASE_TD) + FRESHNESS_MS + 1000 });
  assert.equal(stale.outcome, 'stale_existing_hit');
  assert.equal(stale.row, undefined);
  /* The real launch-time case: this payload was captured ~18 minutes after
   * the touchdown. It must not celebrate. */
  assert.equal(evaluateTarget({ target: chase(), detail, nowMs: ms('2026-09-27T17:38:00Z') }).outcome, 'stale_existing_hit');
  /* A wallclock from the future is a clock problem, not a fresh play. */
  assert.equal(evaluateTarget({ target: chase(), detail, nowMs: ms(CHASE_TD) - 10 * 60_000 }).outcome, 'freshness_unproven');
});

test('freshness needs the play log: a scoring play with no logged wallclock waits, it is not guessed', () => {
  const detail = fixture(CIN_PIT);
  detail.plays = detail.plays.filter(p => p.id !== '401872950490');
  assert.equal(evaluateTarget({ target: chase(), detail, nowMs: ms(CHASE_TD) + 30_000 }).outcome, 'freshness_unproven');
});

test('8 · a player who scores twice connected ONCE: the event is his first touchdown', () => {
  const detail = fixture(CIN_PIT);
  setStat(detail, 'CIN', 'receiving', { id: '4362628', name: "Ja'Marr Chase" }, { REC: 5, YDS: 61, TD: 2 });
  const second = '2026-09-27T17:44:00Z';
  addScore(detail, { id: '401872950996', typeId: '67', type: 'Passing Touchdown', text: "Ja'Marr Chase 22 Yd pass from Joe Burrow (Evan McPherson Kick)", wallclock: second, away: 14, home: 14 });
  /* Right after the first one: the first is the event. */
  const early = evaluateTarget({ target: chase(), detail, nowMs: ms(CHASE_TD) + 60_000 });
  assert.equal(early.outcome, 'hit');
  assert.equal(early.row.play_id, '401872950490');
  /* Fresh second touchdown, stale first: the moment he connected has passed
   * unannounced, and a later touchdown is not relabelled as it. */
  assert.equal(evaluateTarget({ target: chase(), detail, nowMs: ms(second) + 60_000 }).outcome, 'stale_existing_hit');
});

test('a box-score touchdown with no matching scoring play is not published on a guess', () => {
  const detail = fixture(CIN_PIT);
  detail.scoring_plays = detail.scoring_plays.filter(s => s.id !== '401872950490');
  assert.equal(evaluateTarget({ target: chase(), detail, nowMs: ms(CHASE_TD) + 30_000 }).outcome, 'play_unmatched');
});

test('live stat line: labelled columns only, nothing inferred', () => {
  const detail = fixture(CIN_PIT);
  const brown = boxIdentity(detail.player_stats, 'chase brown', '4362238');
  assert.equal(brown.status, 'ok');
  assert.deepEqual(liveStatLine(brown.rows), { carries: 3, rush_yards: 13, rushing_td: 0 });
  const g = group(detail, 'CIN', 'receiving');
  g.labels = g.labels.filter(label => label !== 'TGTS');
  const noTargets = liveStatLine(boxIdentity(detail.player_stats, "ja'marr chase", '4362628').rows);
  assert.equal('targets' in noTargets, false);
});

test('19 · LIVE and FINAL use one touchdown definition: every live verdict agrees with gradeTarget', () => {
  const detail = fixture(CIN_PIT);
  setStat(detail, 'CIN', 'kickReturns', { id: '3116389', name: 'Samaje Perine' }, { TD: 1 });
  const cases = [
    [chase(), 'win'], [burrow(), 'loss'], [target('Aaron Rodgers', '8439', CIN_PIT), 'loss'],
    [target('Roman Wilson', '4431492', CIN_PIT), 'win'], [target('Samaje Perine', '3116389', CIN_PIT), 'loss'],
    [target('Chase Brown', '4362238', CIN_PIT), 'loss'],
  ];
  for (const [t, expected] of cases) {
    const graded = gradeTarget({ target: t, seen: readPlayerScoring(detail.player_stats, t.player_key), closing: null });
    assert.equal(graded.result, expected, t.player_name);
    const live = evaluateTarget({ target: t, detail, nowMs: ms('2026-09-27T17:38:00Z') }).outcome;
    assert.equal(['hit', 'stale_existing_hit'].includes(live), expected === 'win', `${t.player_name} live=${live}`);
  }
});

test('19 · the final grader and its definition are byte-for-byte unchanged, and the detector imports the grader\'s function', () => {
  const sha = path => createHash('sha256').update(read(path).replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(sha('workers/nfl-touchdown-targets-grader/src/index.js'), '8b28351932eb0f965683485647ddf6514e73ee551e696cc7755c5cd25b68df11');
  assert.equal(sha('workers/nfl-td-targets-shared/td-grading.mjs'), '2551516e7d2df3ef9442399a5b0595bc5eeeef9c5154a7a3b4480e3cdef7fa9a');
  const detector = read('workers/nfl-td-targets-shared/td-live-hit.mjs');
  assert.match(detector, /import \{ readPlayerScoring, RESULT_DEFINITION \} from '\.\/td-grading\.mjs'/);
  assert.match(detector, /readPlayerScoring\(detail\?\.player_stats, target\.player_key \|\| target\.player_name\)/);
  assert.match(read('workers/nfl-touchdown-targets-grader/src/index.js'), /readPlayerScoring\(detail\.player_stats, target\.player_key \|\| target\.player_name\)/);
});

/* ========================================================== the Worker loop */

function harness({ targets, details, existingHits = [], dbHasRowsTheSelectMisses = [] }) {
  const hits = new Map(existingHits.map(row => [row.pick_id, row]));
  for (const row of dbHasRowsTheSelectMisses) hits.set(row.pick_id, row);
  const hidden = new Set(dbHasRowsTheSelectMisses.map(row => row.pick_id));
  const calls = [];
  const kv = new Map();
  const env = {
    SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', NFL_SITE_URL: 'https://nfl.test',
    PICKS_KV: { put: async (k, v) => { kv.set(k, v); }, get: async (k, o) => { const v = kv.get(k); return v && o?.type === 'json' ? JSON.parse(v) : v ?? null; } },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, host: url.host, path: url.pathname, search: decodeURIComponent(url.search) });
    const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.host === 'nfl.test' && url.pathname === '/api/nfl-live') {
      const detail = details[url.searchParams.get('event')];
      return detail ? ok(detail) : new Response('{}', { status: 503 });
    }
    if (url.host !== 'sb.test') throw new Error(`unexpected host ${url.host}`);
    const table = url.pathname.split('/').pop();
    const q = decodeURIComponent(url.search);
    if (method === 'GET' && table === 'nfl_prop_picks') {
      assert.match(q, /market=eq\.player_anytime_td/);
      assert.match(q, /status=eq\.open/);
      return ok(targets.filter(t => t.status === 'open'));
    }
    if (method === 'GET' && table === 'nfl_td_target_hit_events') return ok([...hits.values()].filter(r => !hidden.has(r.pick_id)).map(r => ({ pick_id: r.pick_id })));
    if (method === 'POST' && table === 'nfl_td_target_hit_events') {
      assert.match(q, /on_conflict=pick_id/);
      assert.match(init.headers.prefer, /resolution=ignore-duplicates/);
      const [row] = JSON.parse(init.body);
      if (hits.has(row.pick_id)) return ok([]);         // UNIQUE (pick_id): DO NOTHING
      hits.set(row.pick_id, { ...row, id: hits.size + 1, detected_at: new Date().toISOString() });
      return ok([hits.get(row.pick_id)]);
    }
    throw new Error(`unexpected ${method} ${table}`);
  };
  return { env, calls, hits, kv };
}

test('7 · repeated cron after the same hit -> no duplicate; the database, not memory, is the boundary', async () => {
  const t = chase();
  const h = harness({ targets: [t], details: { [CIN_PIT]: fixture(CIN_PIT) } });
  const first = await runDetection(h.env, { nowMs: ms(CHASE_TD) + 60_000 });
  assert.equal(first.counts.hits_detected, 1);
  const second = await runDetection(h.env, { nowMs: ms(CHASE_TD) + 120_000 });
  assert.equal(second.counts.hits_detected, 0);
  assert.equal(second.counts.already_published, 1);
  assert.equal(h.hits.size, 1);
});

test('7 · two overlapping ticks that both miss the pre-check still write ONE row (unique claim)', async () => {
  const t = chase();
  const h = harness({ targets: [t], details: { [CIN_PIT]: fixture(CIN_PIT) }, dbHasRowsTheSelectMisses: [{ pick_id: t.id }] });
  const run = await runDetection(h.env, { nowMs: ms(CHASE_TD) + 60_000 });
  assert.equal(run.counts.hits_detected, 0);
  assert.equal(run.counts.duplicate_hits, 1);
  assert.equal(h.hits.size, 1);
});

test('9 · primary and secondary in one game each connect once; the game package is read ONCE per tick', async () => {
  const primary = chase();
  const secondary = target('Roman Wilson', '4431492', CIN_PIT, { target_rank: 'secondary' });
  const h = harness({ targets: [primary, secondary], details: { [CIN_PIT]: fixture(CIN_PIT) } });
  const a = await runDetection(h.env, { nowMs: ms(WILSON_TD) + 60_000 });
  assert.deepEqual([a.counts.hits_detected, a.counts.games_checked], [1, 1]);
  assert.equal(h.calls.filter(c => c.path === '/api/nfl-live').length, 1);
  const b = await runDetection(h.env, { nowMs: ms(CHASE_TD) + 60_000 });
  assert.equal(b.counts.hits_detected, 1);
  assert.equal(b.counts.already_published, 1);
  assert.deepEqual([...h.hits.values()].map(r => [r.player_name, r.target_rank]).sort(), [["Ja'Marr Chase", 'primary'], ['Roman Wilson', 'secondary']]);
});

test('launch safety · a touchdown scored before the Worker was watching is counted, never published', async () => {
  const h = harness({ targets: [chase(), target('Roman Wilson', '4431492', CIN_PIT)], details: { [CIN_PIT]: fixture(CIN_PIT) } });
  const run = await runDetection(h.env, { nowMs: ms('2026-09-27T17:38:00Z') });
  assert.equal(run.counts.stale_existing_hits, 2);
  assert.equal(run.counts.hits_detected, 0);
  assert.equal(h.calls.filter(c => c.method !== 'GET').length, 0);
});

test('write surface · the Worker writes ONE table and nothing else: no grade, pick, receipt, audit or learning write', async () => {
  const h = harness({ targets: [chase(), burrow(), chase({ status: 'killed' })], details: { [CIN_PIT]: fixture(CIN_PIT) } });
  await runDetection(h.env, { nowMs: ms(CHASE_TD) + 60_000 });
  const writes = h.calls.filter(c => c.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].path], ['POST', '/rest/v1/nfl_td_target_hit_events']);
  /* Executable source only: the header comment names what it never does. */
  const src = read('workers/nfl-touchdown-target-hit-alerts/src/index.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['nfl_prop_pick_grades', 'nfl_prop_pick_receipts', 'nfl_prop_learning_observations', 'nfl_prop_pick_audit_events', 'upsert', 'patch(', 'slack', 'discord', 'webhook']) {
    assert.equal(src.toLowerCase().includes(forbidden.toLowerCase()), false, `worker source mentions ${forbidden}`);
  }
});

test('source failures are counted and never become a hit; an old contract without scoring_plays publishes nothing', async () => {
  const old = fixture(CIN_PIT);
  delete old.scoring_plays;
  const h = harness({ targets: [chase(), target('Kenneth Walker III', '4567048', KC_MIA)], details: { [CIN_PIT]: old } });
  const run = await runDetection(h.env, { nowMs: ms(CHASE_TD) + 60_000 });
  assert.equal(run.counts.source_unavailable, 2);
  assert.equal(run.counts.hits_detected, 0);
  const health = await (await worker.fetch(new Request('https://w.test/health'), h.env)).json();
  assert.equal(health.service, SERVICE);
  assert.equal(health.health, 'DEGRADED');
  assert.equal(health.counts.source_unavailable, 2);
  for (const key of ['targets_checked', 'games_checked', 'live_games', 'hits_detected', 'duplicate_hits', 'stale_existing_hits', 'source_unavailable', 'identity_missing']) assert.ok(key in health.counts, key);
  assert.deepEqual(health.writes, ['nfl_td_target_hit_events']);
});

test('no target in the game window -> one query, a skipped tick, no upstream read', async () => {
  const h = harness({ targets: [], details: {} });
  const run = await runDetection(h.env, { nowMs: ms(CHASE_TD) });
  assert.equal(run.counts.targets_checked, 0);
  assert.equal(h.calls.length, 1);
  assert.ok(h.kv.has(`run:tick:${SERVICE}`));
  assert.equal(h.kv.has(`run:work:${SERVICE}`), false);
});

/* ============================================================ public read */

function hitRowFor(t, overrides = {}) {
  const v = evaluateTarget({ target: t, detail: fixture(CIN_PIT), nowMs: ms(CHASE_TD) + 60_000 });
  return { id: 1, detected_at: '2026-09-27T17:21:10.123Z', ...v.row, ...overrides };
}

async function callHits(rows, query = {}) {
  const reads = [];
  const sb = async (path, q) => { reads.push({ path, q: decodeURIComponent(q) }); return rows; };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  const send = (r, status, body, cache) => { r.statusCode = status; r.setHeader('cache-control', cache); r.end(JSON.stringify(body)); };
  await hitsView({ res, send, sb, secret: 's', query, nowMs: ms('2026-09-27T17:22:00Z') });
  return { status: res.statusCode, body: JSON.parse(res.body), cache: res.headers['cache-control'], reads };
}

test('16 · view=hits reads ONLY the hit-event table: an unhit target cannot leave through it', async () => {
  const out = await callHits([hitRowFor(chase())]);
  assert.equal(out.status, 200);
  /* bootstrap: the high-water id, then the bounded window — both on the hit table only */
  assert.deepEqual(out.reads.map(r => r.path), ['nfl_td_target_hit_events', 'nfl_td_target_hit_events']);
  assert.match(out.reads[1].q, /detected_at=gt\./);
  assert.match(out.reads[1].q, /limit=25/);
  assert.equal(out.cache, 'no-store');
  assert.equal(out.body.count, 1);
  const shaped = out.body.hits[0];
  assert.deepEqual(Object.keys(shaped).sort(), ['detected_at', 'game', 'id', 'live_stats', 'pick_id', 'play', 'player', 'target'].sort());
  assert.deepEqual(shaped.game, { espn_id: CIN_PIT, away: 'CIN', home: 'PIT', away_score: 7, home_score: 7, period: 1, clock: '5:50' });
});

test('17 · view=hits never returns model_snapshot, the pool, components or the raw provider', async () => {
  const out = await callHits([{ ...hitRowFor(chase()), model_snapshot: chase().model_snapshot }]);
  const text = JSON.stringify(out.body);
  for (const leak of ['model_snapshot', 'ranked_pool', 'secret_component', 'Somebody Unhit', 'espn_site_summary', 'provider', 'selector']) {
    assert.equal(text.includes(leak), false, `leaked ${leak}`);
  }
  assert.equal(out.reads.some(r => r.q.includes('model_snapshot')), false);
});

test('18 · a tracking target is never labelled official', async () => {
  const out = await callHits([hitRowFor(chase()), hitRowFor(chase(), { id: 2, publication_scope: 'official', target_rank: 'secondary' })]);
  assert.deepEqual(out.body.hits.map(h => [h.target.publication_scope, h.target.scope_label, h.target.rank]),
    [['tracking', 'TRACKING TARGET', 'primary'], ['official', 'OFFICIAL TARGET', 'secondary']]);
  assert.equal(scopeLabel(undefined), 'TRACKING TARGET');
  assert.match(out.body.settlement, /final result settles after the game/i);
});

test('the cursor is bounded: default 30 minutes, never older than 24 hours, never in the future', () => {
  const now = ms('2026-09-27T17:22:00Z');
  assert.equal(parseSince(undefined, now), '2026-09-27T16:52:00.000Z');
  assert.equal(parseSince('not-a-date', now), '2026-09-27T16:52:00.000Z');
  assert.equal(parseSince('2020-01-01T00:00:00Z', now), '2026-09-26T17:22:00.000Z');
  assert.equal(parseSince('2030-01-01T00:00:00Z', now), '2026-09-27T17:22:00.000Z');
  assert.equal(shapeHit({ ...hitRowFor(chase()), headshot_url: 'javascript:alert(1)' }).player.headshot_url, null);
});

test('view=hits is routed identically on the Vercel function and the Cloudflare contract', () => {
  for (const path of ['api/pbe-touchdown-targets.js', 'workers/nfl-touchdown-targets-api/src/contract.js']) {
    const src = read(path);
    assert.match(src, /if \(view === 'hits'\) return await hitsView\(\{ res, send, sb, secret, query: req\.query \|\| \{\} \}\);/, path);
    assert.match(src, /views: \['state', 'current', 'week', 'trackrecord', 'model', 'hits'\]/, path);
  }
});

/* ================================================================ database */

test('20 · the event table is append-only with one row per pick, and closed to clients', () => {
  const sql = read('migrations/nfl_td_target_hit_events_v1.sql');
  assert.match(sql, /pick_id uuid not null references public\.nfl_prop_picks\(id\) on delete restrict/);
  assert.match(sql, /constraint nfl_td_target_hit_events_pick_unique unique \(pick_id\)/);
  assert.match(sql, /before update or delete on public\.nfl_td_target_hit_events/);
  assert.match(sql, /before truncate on public\.nfl_td_target_hit_events/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.nfl_td_target_hit_events from public, anon, authenticated, service_role;/);
  assert.match(sql, /grant select, insert on table public\.nfl_td_target_hit_events to service_role;/);
  assert.equal(/create policy/i.test(sql), false);
  /* Additive: it alters no existing table. */
  assert.equal(/alter table public\.nfl_prop_(picks|pick_grades|pick_receipts|learning_observations)/i.test(sql), false);
});

test('wrangler: Cloudflare cron every minute, service-role secret, shared run ledger, observability', () => {
  const toml = read('workers/nfl-touchdown-target-hit-alerts/wrangler.toml');
  assert.match(toml, /name = "nfl-touchdown-target-hit-alerts"/);
  assert.match(toml, /crons = \["\* \* \* \* \*"\]/);
  assert.match(toml, /id = "0e7c77bc62fa477ea8d1a1608fb69a62"/);
  assert.match(toml, /\[observability\]\r?\nenabled = true/);
  assert.equal(/SUPABASE_SERVICE_ROLE_KEY\s*=/.test(toml), false);
});
