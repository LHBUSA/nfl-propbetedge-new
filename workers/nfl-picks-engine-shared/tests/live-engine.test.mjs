/* The live picks engine: nfl-current as the only game-state authority, a
 * game-state-aware cadence that never spends provider credits, and durable run
 * evidence that survives an isolate restart. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  nflverseCode, nflverseGameId, parseSlate, issuable, gradable, matchGameForEvent,
  cadenceTier, cadenceDecision, ISSUANCE_CUTOFF_MS,
} from '../current-slate.mjs';
import { laneHealth, overallHealth, recordRun, readLane } from '../runs.mjs';
import { finalScores } from '../../nfl-game-grader/src/index.js';
import { tapeFromBoard } from '../../nfl-prop-picks-orchestrator/src/index.js';

const team = (abbreviation, score = null) => ({ abbreviation, score });
/* The real 2026 Week 1 state as nfl-current served it on 2026-09-10. */
const WEEK1 = {
  ok: true, season: 2026, season_type: 'REG', current_week: 1,
  last_updated: '2026-09-10T14:38:53.029Z',
  games: [
    { id: '401872656', season: 2026, season_type: 'REG', week: 1, semantics: 'FINAL', detail: 'Final', kickoff: '2026-09-10T00:20Z', away: team('NE', 10), home: team('SEA', 13) },
    { id: '401872657', season: 2026, season_type: 'REG', week: 1, semantics: 'SCHEDULE', kickoff: '2026-09-11T00:35Z', away: team('SF', 0), home: team('LAR', 0) },
    { id: '401872660', season: 2026, season_type: 'REG', week: 1, semantics: 'SCHEDULE', kickoff: '2026-09-13T17:00Z', away: team('WSH', 0), home: team('PHI', 0) },
  ],
};
const T = iso => Date.parse(iso);

test('ESPN abbreviations map onto nflverse ids without a schedule lookup', () => {
  assert.equal(nflverseCode('LAR'), 'LA');
  assert.equal(nflverseCode('WSH'), 'WAS');
  assert.equal(nflverseCode('SEA'), 'SEA');
  assert.equal(nflverseGameId({ season: 2026, seasonType: 'REG', week: 1, away: 'SF', home: 'LA' }), '2026_01_SF_LA');
  assert.equal(nflverseGameId({ season: 2026, seasonType: 'POST', week: 1, away: 'SF', home: 'LA' }), '2026_19_SF_LA');
  assert.equal(nflverseGameId({ season: 2026, seasonType: 'PRE', week: 3, away: 'SF', home: 'LA' }), null);
  const slate = parseSlate(WEEK1);
  assert.deepEqual(slate.games.map(g => g.game_id), ['2026_01_NE_SEA', '2026_01_SF_LA', '2026_01_WAS_PHI']);
});

test('the real kickoff comes from nfl-current, not an Eastern time parsed as UTC', () => {
  const sf = parseSlate(WEEK1).games.find(g => g.game_id === '2026_01_SF_LA');
  // nflverse says gameday 2026-09-10, gametime 20:35 (ET). Parsed as UTC that
  // was 20:35Z — four hours early. The true kickoff is 00:35Z the next day.
  assert.equal(sf.kickoff_ts, '2026-09-11T00:35:00.000Z');
});

test('a completed game can never be an issuance target; the next one is', () => {
  const slate = parseSlate(WEEK1);
  const now = T('2026-09-10T15:00:00Z');
  const ne = slate.games.find(g => g.game_id === '2026_01_NE_SEA');
  const sf = slate.games.find(g => g.game_id === '2026_01_SF_LA');
  assert.equal(issuable(ne, now), false);
  assert.equal(issuable(sf, now), true);
  // A stale authority that still says SCHEDULE cannot re-open a kicked-off game.
  assert.equal(issuable(sf, T('2026-09-11T00:36:00Z')), false);
  assert.equal(issuable(sf, sf.kickoff_ms - ISSUANCE_CUTOFF_MS + 1000), false);
  // Nor can a clock issue on a game the provider already calls LIVE.
  assert.equal(issuable({ ...sf, state: 'LIVE' }, now), false);
});

test('grading eligibility is the provider FINAL with both scores', () => {
  const slate = parseSlate(WEEK1);
  const finals = finalScores(slate);
  assert.deepEqual([...finals.keys()], ['2026_01_NE_SEA']);
  assert.equal(finals.get('2026_01_NE_SEA').home_score, 13);
  assert.equal(finals.get('2026_01_NE_SEA').away_score, 10);
  assert.equal(gradable({ state: 'FINAL', home_score: null, away_score: 3 }), false);
  assert.equal(gradable({ state: 'LIVE', home_score: 7, away_score: 3 }), false);
});

test('odds events match on team pair + nearest kickoff, never on a calendar date', () => {
  const slate = parseSlate(WEEK1);
  const hit = matchGameForEvent(slate.games, { away: 'SF', home: 'LA', commenceMs: T('2026-09-11T00:35:00Z') });
  assert.equal(hit?.game_id, '2026_01_SF_LA');
  assert.equal(matchGameForEvent(slate.games, { away: 'LA', home: 'SF', commenceMs: T('2026-09-11T00:35:00Z') }), null);
  assert.equal(matchGameForEvent(slate.games, { away: 'SF', home: 'LA', commenceMs: T('2026-09-12T00:35:00Z') }), null);
});

test('cadence follows game state: 15 min near kickoff, hourly on game day, 6h off', () => {
  const games = parseSlate(WEEK1).games;
  assert.equal(cadenceTier(games, T('2026-09-10T22:00:00Z')), 'near_kickoff'); // SF@LAR in 2h35m
  assert.equal(cadenceTier(games, T('2026-09-10T15:00:00Z')), 'game_day');     // SF@LAR in 9h35m
  assert.equal(cadenceTier(games, T('2026-09-11T06:00:00Z')), 'off_hours');    // nothing within 24h
  const d = cadenceDecision({ games, nowMs: T('2026-09-10T15:00:00Z'), lastWorkMs: T('2026-09-10T14:30:00Z') });
  assert.equal(d.go, false);
  assert.equal(cadenceDecision({ games, nowMs: T('2026-09-10T15:00:00Z'), lastWorkMs: T('2026-09-10T14:30:00Z'), newTape: true }).go, true);
  assert.equal(cadenceDecision({ games, nowMs: T('2026-09-10T15:00:00Z'), lastWorkMs: null }).reason, 'first_run');
});

test('health comes from the persisted ledger: stale and unknown are never healthy', () => {
  const now = T('2026-09-10T15:00:00Z');
  const rec = (iso, status = 'ok') => ({ finished_at: iso, status });
  const lane = 'nfl-game-picks-orchestrator';
  assert.equal(laneHealth(lane, null, now).state, 'UNKNOWN');
  assert.equal(laneHealth(lane, { tick: rec('2026-09-10T13:00:00Z') }, now).state, 'STALE');
  assert.equal(laneHealth(lane, { tick: rec('2026-09-10T14:50:00Z'), work: rec('2026-09-10T14:50:00Z', 'failed') }, now).state, 'DEGRADED');
  assert.equal(laneHealth(lane, { tick: rec('2026-09-10T14:50:00Z'), work: rec('2026-09-10T14:00:00Z') }, now).state, 'HEALTHY');
  assert.equal(overallHealth([{ critical: true, state: 'HEALTHY' }, { critical: true, state: 'UNKNOWN' }]), 'STALE');
  assert.equal(overallHealth([{ critical: true, state: 'HEALTHY' }, { critical: false, state: 'STALE' }]), 'HEALTHY');
});

test('the ledger survives an isolate: it is written to KV, and a skip is not work', async () => {
  const store = new Map();
  const env = { PICKS_KV: {
    put: async (k, v) => { store.set(k, v); },
    get: async (k, opts) => (store.has(k) ? (opts?.type === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null),
  } };
  await recordRun(env, 'nfl-game-grader', { status: 'ok', started_at: '2026-09-10T14:00:00Z', counts: { graded: 2 } });
  await recordRun(env, 'nfl-game-grader', { status: 'skipped', reason: 'not_due' });
  const lane = await readLane(env, 'nfl-game-grader');
  assert.equal(lane.tick.status, 'skipped');
  assert.equal(lane.work.status, 'ok');
  assert.deepEqual(lane.work.counts, { graded: 2 });
  assert.equal(lane.err, null);
});

test('prop tape is the nfl-odds board, stamped with the batch observation time', () => {
  const tape = tapeFromBoard({
    captured_at: '2026-09-10T12:00:46.120Z',
    quotes: [
      { player: 'Brock Purdy', market: 'player_pass_yds', direction: 'OVER', point: 245.5, price: -114, book: 'DraftKings', last_update: '2026-09-10T11:58:00Z' },
      { player: 'Brock Purdy', market: 'player_pass_tds', direction: 'OVER', point: 1.5, price: -150, book: 'DraftKings' },
    ],
  });
  assert.equal(tape.rows.length, 1, 'only the supported market enters the tape');
  assert.equal(tape.rows[0].current.captured_at, '2026-09-10T12:00:46.120Z');
});

test('no picks lane can reach a paid odds provider or pbe-nfl-intelligence', () => {
  const lanes = ['nfl-game-picks-orchestrator', 'nfl-odds-snapshot', 'nfl-game-grader', 'nfl-weight-tuner',
    'nfl-prop-picks-orchestrator', 'nfl-prop-picks-grader', 'nfl-prop-picks-tuner'];
  for (const lane of lanes) {
    const dir = new URL(`../../${lane}/src/`, import.meta.url);
    for (const file of readdirSync(dir)) {
      const src = readFileSync(new URL(file, dir), 'utf8');
      assert.equal(/the-odds-api\.com|ODDS_API_KEY|apiKey=/.test(src), false, `${lane}/${file} references a provider`);
      assert.equal(/pbe-nfl-intelligence\.sales-fd3|intelligenceBase\(|NFL_INTELLIGENCE_URL/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false,
        `${lane}/${file} still calls pbe-nfl-intelligence`);
    }
    const toml = readFileSync(new URL(`../../${lane}/wrangler.toml`, import.meta.url), 'utf8');
    assert.equal(/^\s*ODDS_API_KEY\s*=/m.test(toml), false, `${lane} config carries a provider key`);
  }
});

test('every engine lane writes the durable ledger and has a named, unambiguous cron', () => {
  const lanes = ['nfl-game-picks-orchestrator', 'nfl-odds-snapshot', 'nfl-game-grader', 'nfl-weight-tuner',
    'nfl-prop-picks-orchestrator', 'nfl-prop-picks-grader', 'nfl-prop-picks-tuner'];
  for (const lane of lanes) {
    const src = readFileSync(new URL(`../../${lane}/src/index.js`, import.meta.url), 'utf8');
    assert.match(src, /recordRun\(env, SERVICE/, `${lane} never records a run`);
    const toml = readFileSync(new URL(`../../${lane}/wrangler.toml`, import.meta.url), 'utf8');
    assert.match(toml, /binding = "PICKS_KV"/, `${lane} lacks the ledger binding`);
    const crons = (toml.match(/crons = \[([^\]]*)\]/) || [])[1] || '';
    // Cloudflare counts day-of-week from 1=Sunday; a bare digit there is a trap.
    for (const cron of crons.split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean)) {
      const dow = cron.split(/\s+/)[4];
      assert.ok(dow === '*' || /^[A-Z,-]+$/.test(dow), `${lane} cron "${cron}" uses a numeric day-of-week`);
    }
  }
});
