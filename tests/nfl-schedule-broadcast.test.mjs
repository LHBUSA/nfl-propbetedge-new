/* nfl-schedule broadcast authority + where-to-watch registry + browser label.
 *
 * Fixtures are real ESPN CDN scoreboard weeks captured 2026-09-13 (trimmed to
 * identity, kickoff and broadcast fields). Nothing here reaches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { SCHEDULE } from '../workers/nfl-schedule/schedule-2026.js';
import {
  SNAPSHOT_KEY, observeCdnWeek, observeRelayRange, mergeObservations, emptySnapshot, buildBroadcast,
  joinGame, channelsFromCompetition, easternInstant
} from '../workers/nfl-schedule/broadcast-core.js';
import { BROADCASTERS, destinationFor, isAllowedDestination, allowedHostsById, providerForName } from '../workers/nfl-schedule/broadcasters.js';
import { planRefresh, runRefresh, CDN_WEEK_URL, relayRangeForWeek, MAX_WEEKS_PER_TICK } from '../workers/nfl-schedule/refresh.js';
import worker, { resetSnapshotMemo } from '../workers/nfl-schedule/index.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/espn-cdn-scoreboard-2026.json', import.meta.url), 'utf8'));
const AT = '2026-09-13T21:10:00.000Z';
const NOW = Date.parse(AT);
const clone = v => JSON.parse(JSON.stringify(v));

function snapshotFrom(weeks = { 1: FIX.week1, 2: FIX.week2, 4: FIX.week4, 18: FIX.week18 }, at = AT) {
  const snap = emptySnapshot();
  for (const [w, payload] of Object.entries(weeks)) {
    const obs = observeCdnWeek(payload, Number(w));
    assert.equal(obs.ok, true, `week ${w} fixture observes`);
    mergeObservations(snap, obs.observations, at);
  }
  return snap;
}
const game = id => SCHEDULE.find(g => g.game_id === id);
const allowedHost = (b) => b.destinations.every(d => isAllowedDestination(d.provider_id, d.url));

/* ---- A-G: real 2026 games ------------------------------------------------ */

test('A: CBS Sunday game -> CBS (GB @ MIN, 2026-09-13 20:25Z)', () => {
  const b = buildBroadcast(game('2026_01_GB_MIN'), snapshotFrom(), NOW);
  assert.equal(b.status, 'VERIFIED');
  assert.equal(b.primary, 'CBS');
  assert.deepEqual(b.networks, ['CBS']);
  assert.deepEqual(b.streaming, [], 'CBS never implies Paramount+');
  assert.equal(b.source, 'espn_cdn_scoreboard');
  assert.equal(b.source_event_id, '401872927');
  assert.equal(b.verified_at, AT);
  assert.equal(b.match.method, 'espn_event_id');
  assert.equal(b.match.kickoff_agrees, true);
  assert.equal(b.match.source_kickoff, '2026-09-13T20:25:00.000Z');
  assert.equal(b.local_affiliate, null, 'local affiliate is reserved, never claimed');
  /* ARI @ LAC is also on CBS at 4:25 ET, so neither can be national */
  assert.equal(b.distribution, 'regional');
  assert.equal(b.national, false);
  assert.equal(b.destinations.length, 1);
  assert.equal(b.destinations[0].provider, 'CBS');
  assert.equal(new URL(b.destinations[0].url).hostname, 'www.cbs.com');
  assert.ok(allowedHost(b));
});

test('B: FOX Sunday game -> FOX (MIA @ LV)', () => {
  const b = buildBroadcast(game('2026_01_MIA_LV'), snapshotFrom(), NOW);
  assert.equal(b.status, 'VERIFIED');
  assert.deepEqual(b.networks, ['FOX']);
  assert.deepEqual(b.streaming, []);
  assert.equal(b.destinations[0].url, 'https://www.foxsports.com/live');
});

test('C: Sunday Night Football -> NBC, national (DAL @ NYG)', () => {
  const b = buildBroadcast(game('2026_01_DAL_NYG'), snapshotFrom(), NOW);
  assert.deepEqual([b.status, b.primary, b.distribution, b.national], ['VERIFIED', 'NBC', 'national', true]);
  assert.deepEqual(b.networks, ['NBC']);
  assert.deepEqual(b.streaming, [], 'NBC never implies Peacock');
});

test('D: Monday night on ESPN only -> ESPN (ATL @ NO, week 4)', () => {
  const b = buildBroadcast(game('2026_04_ATL_NO'), snapshotFrom(), NOW);
  assert.deepEqual([b.status, b.primary, b.distribution], ['VERIFIED', 'ESPN', 'national']);
  assert.deepEqual(b.networks, ['ESPN']);
  assert.deepEqual(b.streaming, [], 'ESPN never implies ESPN+');
});

test('E: ESPN / ABC simulcast keeps both identities and both destinations (DEN @ KC)', () => {
  const b = buildBroadcast(game('2026_01_DEN_KC'), snapshotFrom(), NOW);
  assert.deepEqual(b.networks, ['ESPN', 'ABC']);
  assert.equal(b.primary, 'ESPN');
  assert.deepEqual(b.destinations.map(d => [d.provider, new URL(d.url).hostname]), [['ESPN', 'www.espn.com'], ['ABC', 'abc.com']]);
  assert.ok(allowedHost(b));
});

test('F: Thursday streaming exclusive -> Prime Video, not a guessed network (DET @ BUF)', () => {
  const b = buildBroadcast(game('2026_02_DET_BUF'), snapshotFrom(), NOW);
  assert.equal(b.status, 'VERIFIED');
  assert.equal(b.primary, 'Prime Video');
  assert.deepEqual(b.networks, []);
  assert.deepEqual(b.streaming, ['Prime Video']);
  assert.equal(b.destinations[0].type, 'streaming');
  assert.ok(['www.amazon.com', 'www.primevideo.com'].includes(new URL(b.destinations[0].url).hostname));
  const nfln = buildBroadcast(game('2026_04_IND_WAS'), snapshotFrom(), NOW);
  assert.deepEqual([nfln.primary, nfln.networks[0]], ['NFL Network', 'NFL Network'], 'ESPN "NFL Net" -> NFL Network identity');
  const netflix = buildBroadcast(game('2026_01_SF_LA'), snapshotFrom(), NOW);
  assert.deepEqual(netflix.streaming, ['Netflix']);
  assert.deepEqual(netflix.destinations, [], 'Netflix has no verified destination yet -> plain text');
});

test('G: no published TV -> UNASSIGNED (week 18, times TBD)', () => {
  const b = buildBroadcast(game('2026_18_NYJ_BUF'), snapshotFrom(), NOW);
  assert.equal(b.status, 'UNASSIGNED');
  assert.equal(b.primary, null);
  assert.deepEqual([b.networks, b.streaming, b.destinations], [[], [], []]);
  assert.equal(b.distribution, 'unknown');
  assert.equal(b.source_event_id, '401873181');
});

test('every week 1, 2, 4 and 18 game is VERIFIED or honestly UNASSIGNED, joined by ESPN event id', () => {
  const snap = snapshotFrom();
  const rows = SCHEDULE.filter(g => [1, 2, 4, 18].includes(g.week)).map(g => buildBroadcast(g, snap, NOW));
  assert.equal(rows.length, 16 + 16 + 16 + 16);
  for (const b of rows) {
    assert.ok(['VERIFIED', 'UNASSIGNED'].includes(b.status), JSON.stringify(b));
    assert.equal(b.match.method, 'espn_event_id');
    if (b.status === 'VERIFIED') assert.ok(b.primary && typeof b.primary === 'string');
  }
});

/* ---- H: refresh updates the canonical game ------------------------------- */

test('H: a network change at the source updates the game, dates the change and keeps the prior value', () => {
  const snap = snapshotFrom({ 1: FIX.week1 }, '2026-09-10T12:00:00.000Z');
  const flexed = clone(FIX.week1);
  const ev = flexed.content.sbData.events.find(e => e.id === '401872927');
  ev.competitions[0].broadcasts = [{ market: 'national', names: ['FOX'] }];
  ev.competitions[0].geoBroadcasts = [{ type: { id: '1', shortName: 'TV' }, market: { id: '1', type: 'National' }, media: { shortName: 'FOX' }, lang: 'en', region: 'us' }];
  const { changed } = mergeObservations(snap, observeCdnWeek(flexed, 1).observations, AT);
  assert.equal(changed, 1);
  const b = buildBroadcast(game('2026_01_GB_MIN'), snap, NOW);
  assert.deepEqual(b.networks, ['FOX']);
  assert.equal(b.verified_at, AT);
  assert.equal(b.changed_at, AT);
  assert.deepEqual(b.previous.networks, ['CBS']);
  /* unchanged games are re-verified but not marked changed */
  const other = buildBroadcast(game('2026_01_MIA_LV'), snap, NOW);
  assert.equal(other.verified_at, AT);
  assert.equal(other.changed_at, null);
});

test('H: an UNASSIGNED game becomes VERIFIED automatically once the source publishes TV', () => {
  const snap = snapshotFrom({ 18: FIX.week18 }, '2026-09-12T00:00:00.000Z');
  assert.equal(buildBroadcast(game('2026_18_NYJ_BUF'), snap, NOW).status, 'UNASSIGNED');
  const later = clone(FIX.week18);
  const ev = later.content.sbData.events.find(e => e.id === '401873181');
  ev.competitions[0].broadcasts = [{ market: 'national', names: ['ESPN', 'ABC'] }];
  ev.competitions[0].geoBroadcasts = ['ESPN', 'ABC'].map(n => ({ type: { id: '1', shortName: 'TV' }, market: { id: '1', type: 'National' }, media: { shortName: n }, lang: 'en', region: 'us' }));
  mergeObservations(snap, observeCdnWeek(later, 18).observations, AT);
  const b = buildBroadcast(game('2026_18_NYJ_BUF'), snap, NOW);
  assert.equal(b.status, 'VERIFIED');
  assert.deepEqual(b.networks, ['ESPN', 'ABC']);
});

/* ---- I: identity --------------------------------------------------------- */

test('I: the same two teams meeting twice attach to the right game and date', () => {
  const snap = snapshotFrom({ 1: FIX.week1 });
  /* the real rematch: MIN @ GB, 2026-11-15, FOX (ESPN event 401873060) */
  snap.events['401873060'] = { event_id: '401873060', week: 11, kickoff: '2026-11-15T18:00:00.000Z', time_valid: true, away: 'MIN', home: 'GB', channels: [{ name: 'FOX', kind: 'network', basis: 'espn_geo_broadcast_type' }], source: 'espn_cdn_scoreboard', verified_at: AT, first_seen_at: AT, changed_at: null, previous: null };
  assert.deepEqual(buildBroadcast(game('2026_01_GB_MIN'), snap, NOW).networks, ['CBS']);
  const rematch = SCHEDULE.find(g => g.away_team === 'MIN' && g.home_team === 'GB');
  assert.equal(rematch.espn_event_id, '401873060');
  assert.deepEqual(buildBroadcast(rematch, snap, NOW).networks, ['FOX']);

  /* without an event id, the fallback needs both teams AND the Eastern date */
  const sameTeamsTwice = { ...snap.events['401872927'], event_id: '999000001', kickoff: '2026-12-20T18:00:00.000Z', channels: [{ name: 'FOX', kind: 'network', basis: 'x' }] };
  const events = { ...snap.events, [sameTeamsTwice.event_id]: sameTeamsTwice };
  const noId = { ...game('2026_01_GB_MIN'), espn_event_id: undefined };
  const j = joinGame(noId, events);
  assert.equal(j.event.event_id, '401872927');
  assert.equal(j.evidence.method, 'teams_and_eastern_gameday');
  const decemberRow = { ...noId, gameday: '2026-12-20', gametime: '13:00' };
  assert.equal(joinGame(decemberRow, events).event.event_id, '999000001');
  const wrongDay = { ...noId, gameday: '2026-09-14' };
  assert.equal(buildBroadcast(wrongDay, { events }, NOW).status, 'UNAVAILABLE', 'teams alone never join');
});

test('I: an ambiguous or contradictory join publishes no broadcast', () => {
  const snap = snapshotFrom({ 1: FIX.week1 });
  const dup = { ...snap.events['401872927'], event_id: '999000002' };
  const noId = { ...game('2026_01_GB_MIN'), espn_event_id: undefined };
  const amb = buildBroadcast(noId, { events: { ...snap.events, [dup.event_id]: dup } }, NOW);
  assert.equal(amb.status, 'UNAVAILABLE');
  assert.equal(amb.match.conflict, 'ambiguous');
  assert.equal(amb.primary, null);

  const swapped = clone(snap);
  swapped.events['401872927'].away = 'MIN'; swapped.events['401872927'].home = 'GB';
  const bad = buildBroadcast(game('2026_01_GB_MIN'), swapped, NOW);
  assert.equal(bad.status, 'UNAVAILABLE');
  assert.match(bad.match.conflict, /^teams_disagree/);
});

/* ---- J: malformed upstream ----------------------------------------------- */

test('J: malformed ESPN payloads are rejected without touching the snapshot', () => {
  assert.equal(observeCdnWeek({}, 1).ok, false);
  assert.equal(observeCdnWeek({ content: { sbData: { events: 'nope' } } }, 1).ok, false);
  assert.equal(observeCdnWeek(FIX.week2, 1).ok, false, 'a payload for another week is not trusted');
  const bad = clone(FIX.week1);
  bad.content.sbData.events.find(e => e.id === '401872927').competitions[0].broadcasts = 'CBS';
  const obs = observeCdnWeek(bad, 1);
  assert.equal(obs.ok, true);
  assert.deepEqual(obs.rejected, [{ event_id: '401872927', reason: 'broadcasts_malformed' }]);
  const snap = snapshotFrom({ 1: FIX.week1 }, '2026-09-12T00:00:00.000Z');
  mergeObservations(snap, obs.observations, AT);
  const b = buildBroadcast(game('2026_01_GB_MIN'), snap, NOW);
  assert.deepEqual(b.networks, ['CBS'], 'previous verified observation stands');
  assert.equal(b.verified_at, '2026-09-12T00:00:00.000Z', 'but it is not re-verified');
  assert.equal(channelsFromCompetition({ geoBroadcasts: {} }).ok, false);
  assert.deepEqual(channelsFromCompetition({ broadcasts: [{ names: ['ESPN+'] }] }).channels, [{ name: 'ESPN+', kind: 'unknown', basis: 'unclassified' }], 'an unknown name is kept verbatim and never typed by guess');
});

test('J: the schedule still answers when the broadcast snapshot is unreadable or missing', async () => {
  for (const env of [{ NFL_KV: { get: async () => { throw new Error('kv down'); } } }, { NFL_KV: { get: async () => null } }, {}]) {
    resetSnapshotMemo();
    const res = await worker.fetch(new Request('https://nfl-schedule/api/schedule'), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 272);
    assert.equal(body.broadcast_source.status, 'UNAVAILABLE');
    for (const g of body.games) {
      assert.equal(g.broadcast.status, 'UNAVAILABLE');
      assert.equal(g.broadcast.primary, null);
      assert.deepEqual(g.broadcast.destinations, []);
    }
  }
});

test('J: a refresh tick whose sources all fail keeps prior observations and records the failure', async () => {
  const prior = snapshotFrom({ 1: FIX.week1, 2: FIX.week2 }, '2026-09-13T20:00:00.000Z');
  prior.lanes = { sweep: { completed_at: '2026-09-13T12:00:00.000Z', cursor: 1 } };
  const calls = [];
  const out = await runRefresh({ snapshot: prior, schedule: SCHEDULE, now: NOW, fetchImpl: async url => { calls.push(url); return new Response('<html>blocked</html>', { status: 200 }); } });
  assert.equal(out.ran, true);
  assert.ok(calls.length <= 2 * MAX_WEEKS_PER_TICK);
  assert.ok(out.snapshot.lanes.near.last_error);
  assert.deepEqual(buildBroadcast(game('2026_01_GB_MIN'), out.snapshot, NOW).networks, ['CBS']);
  assert.equal(buildBroadcast(game('2026_01_GB_MIN'), out.snapshot, NOW).verified_at, '2026-09-13T20:00:00.000Z');
});

/* ---- refresh lanes ------------------------------------------------------- */

test('refresh: CDN first; the existing relay is the fallback and its names are typed only by identity', async () => {
  const relay = { ok: true, mode: 'range', games: FIX.week2.content.sbData.events.map(e => ({ id: e.id, date: e.date, season: e.season, week: e.week.number, teams: Object.fromEntries(e.competitions[0].competitors.map(c => [c.homeAway, { abbreviation: c.team.abbreviation }])), broadcast: e.competitions[0].broadcasts.flatMap(b => b.names) })) };
  const obs = observeRelayRange(relay, 2);
  assert.equal(obs.ok, true);
  const snap = emptySnapshot();
  mergeObservations(snap, obs.observations, AT);
  const b = buildBroadcast(game('2026_02_DET_BUF'), snap, NOW);
  assert.deepEqual([b.primary, b.streaming, b.source], ['Prime Video', ['Prime Video'], 'espn_site_scoreboard_via_relay']);
  assert.equal(b.distribution, 'unknown', 'relay has no timeValid, so distribution is not claimed');
  assert.equal(relayRangeForWeek(SCHEDULE, 2), '20260916-20260922');

  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    if (url.startsWith('https://cdn.espn.com/')) return new Response('forbidden', { status: 403 });
    return new Response(JSON.stringify(relay), { status: 200 });
  };
  const out = await runRefresh({ snapshot: { ...emptySnapshot(), lanes: { sweep: { completed_at: AT, cursor: 1 }, near: { last_success_at: AT, last_attempt_at: AT } } }, schedule: SCHEDULE, now: Date.parse('2026-09-17T20:00:00Z'), fetchImpl });
  assert.ok(seen.some(u => u === CDN_WEEK_URL(2)));
  assert.ok(seen.some(u => u.startsWith('https://nfl.propbetedge.ai/api/nfl-live?range=')));
  assert.ok(!seen.some(u => u.includes('site.api.espn.com')), 'the Worker never calls site.api directly');
  assert.equal(out.snapshot.events['401872932'].source, 'espn_site_scoreboard_via_relay');
});

test('refresh cadence: empty store sweeps; idle store reads nothing; game day reads the current week every 15 minutes', () => {
  const first = planRefresh(null, SCHEDULE, NOW);
  assert.deepEqual(first.sweep_weeks, [1, 2, 3, 4, 5, 6]);
  assert.ok(first.weeks.length <= MAX_WEEKS_PER_TICK);

  const tue = Date.parse('2026-09-15T15:00:00Z');
  const idle = { lanes: { sweep: { completed_at: '2026-09-15T06:00:00Z', cursor: 1 }, near: { last_success_at: '2026-09-15T14:30:00Z', last_attempt_at: '2026-09-15T14:30:00Z' } } };
  assert.equal(planRefresh(idle, SCHEDULE, tue).gameday, false);
  assert.deepEqual(planRefresh(idle, SCHEDULE, tue).weeks, []);
  assert.deepEqual(planRefresh(idle, SCHEDULE, tue + 31 * 60000).weeks.map(w => w.week), [2, 3], 'hourly: current + next week');

  const sunday = Date.parse('2026-09-20T15:00:00Z');
  const gd = { lanes: { ...idle.lanes, sweep: { completed_at: '2026-09-20T06:00:00Z', cursor: 1 }, near: { last_success_at: '2026-09-20T14:50:00Z', last_attempt_at: '2026-09-20T14:50:00Z' }, gameday: { last_success_at: '2026-09-20T14:44:00Z', last_attempt_at: '2026-09-20T14:44:00Z' } } };
  const plan = planRefresh(gd, SCHEDULE, sunday);
  assert.equal(plan.gameday, true);
  assert.deepEqual(plan.weeks, [{ week: 2, reasons: ['gameday'] }]);
});

test('refresh: a sweep whose weeks all fail still advances, so a dead source cannot become a request loop', async () => {
  const fail = async () => new Response('nope', { status: 503 });
  const t1 = await runRefresh({ snapshot: null, schedule: SCHEDULE, now: NOW, fetchImpl: fail });
  assert.equal(t1.snapshot.lanes.sweep.cursor, 7);
  assert.deepEqual(t1.snapshot.lanes.sweep.pass_failed_weeks, [1, 2, 3, 4, 5, 6]);
  assert.ok(t1.requests <= 2 * MAX_WEEKS_PER_TICK);
  const t2 = await runRefresh({ snapshot: t1.snapshot, schedule: SCHEDULE, now: NOW + 15 * 60000, fetchImpl: fail });
  assert.deepEqual(t2.plan.sweep_weeks, [7, 8, 9, 10, 11, 12]);
  const t3 = await runRefresh({ snapshot: t2.snapshot, schedule: SCHEDULE, now: NOW + 30 * 60000, fetchImpl: fail });
  assert.equal(t3.snapshot.lanes.sweep.cursor, 1);
  assert.ok(t3.snapshot.lanes.sweep.completed_at);
  const idle = planRefresh(t3.snapshot, SCHEDULE, NOW + 45 * 60000);
  assert.deepEqual(idle.sweep_weeks, [], 'the next pass waits a day');
  for (const g of SCHEDULE) assert.equal(buildBroadcast(g, t3.snapshot, NOW).status, 'UNAVAILABLE');
});

test('stale snapshots are marked STALE rather than silently served as fresh', () => {
  const snap = snapshotFrom({ 2: FIX.week2 }, '2026-09-10T00:00:00.000Z');
  const b = buildBroadcast(game('2026_02_DET_BUF'), snap, Date.parse('2026-09-17T12:00:00Z'));
  assert.equal(b.status, 'STALE');
  assert.equal(b.primary, 'Prime Video', 'the last verified value is still shown, labelled stale');
});

/* ---- API contract -------------------------------------------------------- */

function kvWith(snap) { return { NFL_KV: { get: async (key) => { assert.equal(key, SNAPSHOT_KEY); return clone(snap); } } }; }

test('API: /api/schedule keeps every deployed field and filter and adds broadcast to every game', async () => {
  resetSnapshotMemo();
  const env = kvWith(snapshotFrom());
  const all = await (await worker.fetch(new Request('https://x/api/schedule'), env)).json();
  assert.equal(all.count, 272);
  assert.deepEqual(all.source, { provider: 'nflverse', dataset: 'schedules/games.csv', season: 2026, semantics: 'SCHEDULE' });
  assert.equal(all.broadcast_source.authority, 'nfl-schedule');
  for (const g of all.games) {
    for (const k of ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'home_team', 'espn_event_id']) assert.ok(k in g, k);
    assert.ok(['VERIFIED', 'UNASSIGNED', 'STALE', 'UNAVAILABLE'].includes(g.broadcast.status));
    assert.ok(Array.isArray(g.broadcast.networks) && Array.isArray(g.broadcast.streaming) && Array.isArray(g.broadcast.destinations));
    assert.ok(!JSON.stringify(g.broadcast).includes('undefined'));
  }
  const wk1 = await (await worker.fetch(new Request('https://x/api/schedule?week=1&team=GB'), env)).json();
  assert.deepEqual(wk1.games.map(g => [g.game_id, g.broadcast.primary]), [['2026_01_GB_MIN', 'CBS']]);
  assert.equal((await worker.fetch(new Request('https://x/api/schedule?season=2025'), env)).status, 404);
  const health = await (await worker.fetch(new Request('https://x/api/schedule/broadcast/health'), env)).json();
  assert.equal(health.joins.counts.UNAVAILABLE, 272 - 64, 'weeks not in the fixture are honestly unavailable');
  const reg = await (await worker.fetch(new Request('https://x/api/schedule/broadcast/registry'), env)).json();
  assert.deepEqual(reg.allowed_hosts, allowedHostsById());
  const plain = await (await worker.fetch(new Request('https://x/api/schedule/health'), env)).json();
  assert.equal(plain.games, 272);
});

test('schedule rows are the deployed rows plus espn_event_id only', () => {
  const src = readFileSync(new URL('../workers/nfl-schedule/schedule-2026.js', import.meta.url), 'utf8');
  assert.equal(SCHEDULE.length, 272);
  assert.equal(new Set(SCHEDULE.map(g => g.espn_event_id)).size, 272);
  assert.ok(SCHEDULE.every(g => /^\d{9}$/.test(g.espn_event_id)));
  assert.ok(!/network|broadcast|tv/i.test(src.split('export const SCHEDULE')[1]), 'no network is hand-written into the schedule');
  assert.equal(easternInstant('2026-09-13', '16:25'), '2026-09-13T20:25:00.000Z');
  assert.equal(easternInstant('2026-12-27', '13:00'), '2026-12-27T18:00:00.000Z');
});

test('no weekday / time-slot network rule exists in the authority', () => {
  for (const f of ['broadcast-core.js', 'refresh.js', 'index.js', 'broadcasters.js']) {
    const code = readFileSync(new URL(`../workers/nfl-schedule/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/sunday|monday|thursday|getUTCDay|getDay\(/i.test(code), `${f} must not branch on weekday`);
    assert.ok(!/Math\.random/.test(code));
  }
});

/* ---- registry ------------------------------------------------------------ */

test('registry: every emitted link is https on its own provider allow-list, first-party only', () => {
  for (const p of Object.values(BROADCASTERS)) {
    for (const url of [p.watch_url, p.official_url].filter(Boolean)) assert.ok(isAllowedDestination(p.id, url), `${p.id} ${url}`);
    if (p.link_status === 'verified') assert.ok(p.verified_at, p.id);
    assert.equal(p.logo_url, undefined, 'no logos without approval');
  }
  for (const name of ['CBS', 'FOX', 'NBC', 'ESPN', 'ABC', 'NFL Net', 'Prime Video', 'Peacock']) {
    const d = destinationFor(name, providerForName(name).kind);
    assert.ok(d && d.verified === true && d.verified_at, name);
    assert.ok(!/google\.|bing\.|reelgood|justwatch|tvguide|sportsmediawatch/i.test(d.url), 'no search or aggregator');
  }
  assert.equal(new URL(destinationFor('CBS', 'network').url).hostname, 'www.cbs.com');
  assert.ok(['www.amazon.com', 'www.primevideo.com'].includes(new URL(destinationFor('Prime Video', 'streaming').url).hostname));
  assert.equal(destinationFor('Netflix', 'streaming'), null);
  assert.equal(destinationFor('ESPN+', 'streaming'), null, 'unknown identity -> no link');
});

test('registry: malicious or unapproved URLs are rejected', () => {
  for (const url of ['https://evil.example/cbs', 'http://www.cbs.com/live-tv/stream/', 'https://www.cbs.com.evil.example/', 'javascript:alert(1)',
    'https://user:pw@www.cbs.com/', 'https://www.cbs.com:8443/', 'https://www.foxsports.com/live', '//www.cbs.com/', 'data:text/html,hi']) {
    assert.equal(isAllowedDestination('cbs', url), false, url);
  }
  const saved = BROADCASTERS.cbs.watch_url;
  try {
    BROADCASTERS.cbs.watch_url = 'https://www.google.com/search?q=cbs+nfl';
    assert.equal(destinationFor('CBS', 'network'), null, 'a tampered registry URL is dropped, not emitted');
  } finally { BROADCASTERS.cbs.watch_url = saved; }
});

/* ---- browser label (nfl-broadcast-v1.js) ---------------------------------- */

function browserModule() {
  const listeners = {};
  const doc = { addEventListener: () => {}, querySelectorAll: () => [] };
  const win = { addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, dispatchEvent: () => true };
  const ctx = { window: win, document: doc, URL, Intl, Date, Map, Promise, CustomEvent: class { constructor(t) { this.type = t; } }, fetch: async () => { throw new Error('no network in tests'); }, console };
  win.NFL_TEAMS = { GB: { abbr: 'GB', name: 'Green Bay Packers' }, MIN: { abbr: 'MIN', name: 'Minnesota Vikings' }, LAR: { abbr: 'LAR', name: 'Los Angeles Rams' }, SF: { abbr: 'SF', name: 'San Francisco 49ers' } };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../nfl-broadcast-v1.js', import.meta.url), 'utf8'), ctx);
  return win.PBEBroadcast;
}

test('browser: host allow-list equals the Worker registry allow-list', () => {
  const B = browserModule();
  assert.deepEqual(JSON.parse(JSON.stringify(B.HOSTS)), allowedHostsById());
});

test('browser: CBS renders "CBS ↗" as a secondary external link with noopener noreferrer and an accessible label', () => {
  const B = browserModule();
  const b = buildBroadcast(game('2026_01_GB_MIN'), snapshotFrom(), NOW);
  const html = B.html(b, { away: 'Green Bay Packers', home: 'Minnesota Vikings', lead: ' · ' });
  assert.match(html, /^<span class="pbe-tv"[^>]*><span class="pbe-tv-lead"> · <\/span><a /);
  assert.match(html, /<a class="pbe-tv-link" href="https:\/\/www\.cbs\.com\/live-tv\/stream\/" target="_blank" rel="noopener noreferrer" aria-label="Watch \/ view Green Bay Packers at Minnesota Vikings broadcast information on CBS/);
  assert.match(html, />CBS<span class="pbe-tv-ext" aria-hidden="true">↗<\/span><\/a>/);
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.equal(B.text(b), 'CBS');
  assert.equal(B.html(b, { mode: 'text' }).includes('<a '), false, 'text mode (inside buttons) never nests a link');
});

test('browser: ESPN / ABC keeps two identities with two links; Prime Video links to Amazon', () => {
  const B = browserModule();
  const snap = snapshotFrom();
  const html = B.html(buildBroadcast(game('2026_01_DEN_KC'), snap, NOW), { away: 'Denver Broncos', home: 'Kansas City Chiefs' });
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.match(html, /href="https:\/\/www\.espn\.com\/watch\/"[^>]*>ESPN<span[\s\S]*<span class="pbe-tv-sep"> \/ <\/span><a [^>]*href="https:\/\/abc\.com\/watch-live"[^>]*>ABC</);
  const prime = B.html(buildBroadcast(game('2026_02_DET_BUF'), snap, NOW), {});
  assert.match(prime, /href="https:\/\/www\.amazon\.com\/tnf"/);
});

test('browser: a malicious destination is rejected, a missing destination leaves plain text, unknown shows TV TBA, nothing renders undefined', () => {
  const B = browserModule();
  const b = buildBroadcast(game('2026_01_GB_MIN'), snapshotFrom(), NOW);
  const evil = { ...b, destinations: [{ ...b.destinations[0], url: 'https://evil.example/watch' }] };
  assert.equal(B.html(evil, {}).includes('<a '), false);
  assert.match(B.html(evil, {}), /<span class="pbe-tv-name">CBS<\/span>/, 'network is never hidden because its URL is unusable');
  const js = { ...b, destinations: [{ ...b.destinations[0], url: 'javascript:alert(1)' }] };
  assert.equal(B.html(js, {}).includes('javascript:'), false);
  const unverified = { ...b, destinations: [{ ...b.destinations[0], verified: false }] };
  assert.equal(B.html(unverified, {}).includes('<a '), false);
  const none = { ...b, destinations: [] };
  assert.match(B.html(none, {}), /<span class="pbe-tv-name">CBS<\/span>/);
  const unassigned = buildBroadcast(game('2026_18_NYJ_BUF'), snapshotFrom(), NOW);
  assert.match(B.html(unassigned, { lead: ' · ' }), /TV TBA/);
  for (const v of [undefined, null, {}, { status: 'UNAVAILABLE', networks: [] }, '', { status: 'VERIFIED' }]) {
    const out = B.html(v, { lead: ' · ' });
    assert.equal(out, '', JSON.stringify(v));
    assert.ok(!/undefined|null|TBD/.test(out));
  }
  assert.equal(B.html('<b>NBC</b>', {}).includes('<b>'), false, 'legacy strings are escaped');
});

test('browser: find() joins by ESPN event id, then by both teams + Eastern date, never by teams alone', () => {
  const B = browserModule();
  const snap = snapshotFrom();
  const games = SCHEDULE.map(g => ({ ...g, broadcast: buildBroadcast(g, snap, NOW) }));
  assert.equal(B.ingest({ games }), true);
  assert.equal(B.find({ event: '401872927' }).game_id, '2026_01_GB_MIN');
  assert.equal(B.find({ away: 'Green Bay Packers', home: 'Minnesota Vikings', kickoff: '2026-09-13T20:25:00Z' }).game_id, '2026_01_GB_MIN');
  assert.equal(B.find({ away: 'Minnesota Vikings', home: 'Green Bay Packers', kickoff: '2026-09-13T20:25:00Z' }), null);
  assert.equal(B.find({ away: 'Green Bay Packers', home: 'Minnesota Vikings' }), null);
  assert.equal(B.find({ away: 'San Francisco 49ers', home: 'Los Angeles Rams', kickoff: '2026-09-11T00:35:00Z' }).game_id, '2026_01_SF_LA', 'LAR directory code -> LA schedule code');
  assert.match(B.slot({ event: '401872927', lead: ' · ' }), /CBS/);
});
