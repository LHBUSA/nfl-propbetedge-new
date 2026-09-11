/* nfl-intel Worker: the Cloudflare runtime for What Changed and Best Line.
 * Every test runs the real Worker code against stubbed bindings (KV, the
 * nfl-current and nfl-odds service bindings) and a stubbed ESPN core API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { intParam } from '../workers/nfl-intel/src/index.js';
import { ingestInjuries, KV_KEYS, TEAMS } from '../workers/nfl-intel/src/injuries.js';
import { consensusRows } from '../workers/nfl-intel/src/market.js';
import { parseSlate } from '../workers/nfl-picks-engine-shared/current-slate.mjs';

function kv(initial = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    map: m,
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); }
  };
}
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CURRENT = {
  ok: true, season: 2026, season_type: 'REG', current_week: 1,
  games: [
    { id: '401872925', kickoff: '2026-09-13T17:00Z', week: 1, season: 2026, season_type: 'REG', semantics: 'SCHEDULE', detail: 'Sun, September 13th at 1:00 PM EDT', away: { id: '27', abbreviation: 'TB', display_name: 'Tampa Bay Buccaneers', score: 0 }, home: { id: '4', abbreviation: 'CIN', display_name: 'Cincinnati Bengals', score: 0 } },
    { id: '401872999', kickoff: '2026-09-13T17:00Z', week: 1, season: 2026, season_type: 'REG', semantics: 'SCHEDULE', detail: 'Postponed', away: { id: '20', abbreviation: 'NYJ', display_name: 'New York Jets' }, home: { id: '10', abbreviation: 'TEN', display_name: 'Tennessee Titans' } }
  ]
};
const currentBinding = { fetch: async () => respond(CURRENT) };

test('an absent query parameter is absent, not zero', () => {
  const u = s => new URL(`https://x/api/changes${s}`);
  assert.equal(intParam(u(''), 'window_hours', 48, 6, 168), 48);
  assert.equal(intParam(u('?window_hours='), 'window_hours', 48, 6, 168), 48);
  assert.equal(intParam(u('?window_hours=abc'), 'window_hours', 48, 6, 168), 48);
  assert.equal(intParam(u('?window_hours=0'), 'window_hours', 48, 6, 168), 6);
  assert.equal(intParam(u('?window_hours=999'), 'window_hours', 48, 6, 168), 168);
});

/* ESPN core API stub: TB (27) lists three records — one negative id, one for a
   player whose current team is elsewhere — CIN (4) one, everyone else none. */
function espnStub({ tbStatus = 'Out', failTeams = [] } = {}) {
  const base = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
  const rec = (a, i) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/${a}/injuries/${i}?lang=en` });
  return async url => {
    const u = String(url);
    const team = /\/teams\/(\d+)\/injuries/.exec(u);
    if (team) {
      if (failTeams.includes(Number(team[1]))) return respond({}, 503);
      if (team[1] === '27') return respond({ items: [rec(1001, 5001), rec(1002, -2000004), rec(1003, 5003)] });
      if (team[1] === '4') return respond({ items: [rec(2001, 6001)] });
      return respond({ items: [] });
    }
    const inj = /athletes\/(\d+)\/injuries\/(-?\d+)/.exec(u);
    if (inj) {
      const status = inj[1] === '1001' ? tbStatus : 'Questionable';
      return respond({ id: inj[2], status, date: '2026-09-11T10:00Z', shortComment: `note ${inj[1]}`, type: { name: 'X', description: status.toLowerCase(), abbreviation: status[0] }, details: { type: 'Knee', returnDate: '2026-09-13' } });
    }
    const ath = /\/athletes\/(\d+)$/.exec(u.split('?')[0]);
    if (ath) {
      const team = ath[1] === '1003' ? 2 : ath[1].startsWith('2') ? 4 : 27;   // 1003 now plays for BUF
      return respond({ id: ath[1], displayName: `Player ${ath[1]}`, shortName: `P. ${ath[1]}`, position: { abbreviation: ath[1] === '1001' ? 'WR' : 'QB' }, headshot: { href: `https://h/${ath[1]}.png` }, team: { $ref: `${base}/seasons/2026/teams/${team}` } });
    }
    return respond({ error: 'unexpected ' + u }, 404);
  };
}

test('injury ingest: negative ids count, off-roster records do not, report keeps ESPN shape', async () => {
  const env = { INTEL_KV: kv() };
  const res = await ingestInjuries(env, { season: 2026, fetchImpl: espnStub(), now: Date.parse('2026-09-11T15:00Z') });
  assert.equal(res.ok, true);
  assert.equal(res.refs, 4);
  assert.equal(res.off_roster_skipped, 1, 'player 1003 is rostered by BUF now');
  const stored = await env.INTEL_KV.get(KV_KEYS.report, 'json');
  const tb = stored.report.injuries.find(t => t.id === '27');
  assert.deepEqual(tb.injuries.map(e => e.id).sort(), ['-2000004', '5001']);
  assert.equal(tb.injuries.find(e => e.id === '5001').athlete.team.abbreviation, 'TB');
  assert.equal(tb.injuries.find(e => e.id === '5001').date, '2026-09-11T10:00Z', 'ESPN date carried verbatim');
  assert.equal(Object.keys(TEAMS).length, 32);
});

test('injury ingest: a changed designation between two of our runs is recorded, not displayed', async () => {
  const env = { INTEL_KV: kv() };
  await ingestInjuries(env, { season: 2026, fetchImpl: espnStub({ tbStatus: 'Questionable' }), now: Date.parse('2026-09-11T14:00Z') });
  const second = await ingestInjuries(env, { season: 2026, fetchImpl: espnStub({ tbStatus: 'Out' }), now: Date.parse('2026-09-11T14:10Z') });
  assert.equal(second.transitions, 1);
  const t = (await env.INTEL_KV.get(KV_KEYS.transitions, 'json'))[0];
  assert.equal(t.from, 'Questionable'); assert.equal(t.to, 'Out');
  assert.equal(t.from_observed_at, '2026-09-11T14:00:00.000Z');
});

test('injury ingest: a failed team keeps its previous entries flagged stale; too many failures stand down', async () => {
  const env = { INTEL_KV: kv() };
  await ingestInjuries(env, { season: 2026, fetchImpl: espnStub(), now: Date.parse('2026-09-11T14:00Z') });
  const partial = await ingestInjuries(env, { season: 2026, fetchImpl: espnStub({ failTeams: [27] }), now: Date.parse('2026-09-11T14:10Z') });
  assert.equal(partial.status, 'partial');
  const tb = (await env.INTEL_KV.get(KV_KEYS.report, 'json')).report.injuries.find(t => t.id === '27');
  assert.equal(tb.stale, true);
  assert.equal(tb.injuries.length, 2);
  const before = env.INTEL_KV.map.get(KV_KEYS.report);
  const degraded = await ingestInjuries(env, { season: 2026, fetchImpl: espnStub({ failTeams: [1, 2, 3, 4, 5, 6] }), now: Date.parse('2026-09-11T14:20Z') });
  assert.equal(degraded.ok, false);
  assert.equal(env.INTEL_KV.map.get(KV_KEYS.report), before, 'the previous report stands');
});

test('market history: consensus rows keyed to nflverse ids; post-kick quotes never recorded', () => {
  const slate = parseSlate(CURRENT);
  const book = (key, spread, total) => ({ key, title: key, markets: [
    { key: 'spreads', outcomes: [{ name: 'Tampa Bay Buccaneers', point: -spread, price: -110 }, { name: 'Cincinnati Bengals', point: spread, price: -110 }] },
    { key: 'totals', outcomes: [{ name: 'Over', point: total, price: -110 }, { name: 'Under', point: total, price: -110 }] }
  ] });
  const payload = { captured_at: '2026-09-11T12:00:00Z', events: [
    { id: 'e1', commence_time: '2026-09-13T17:00:00Z', away_team: 'Tampa Bay Buccaneers', home_team: 'Cincinnati Bengals', bookmakers: [book('dk', -3.5, 50.5), book('fd', -3, 50.5)] },
    { id: 'e2', commence_time: '2026-09-10T17:00:00Z', away_team: 'New York Jets', home_team: 'Tennessee Titans', bookmakers: [book('dk', 1, 40)] }
  ] };
  const { rows, postKick } = consensusRows(payload, slate);
  assert.equal(postKick, 1);
  assert.ok(rows.length >= 4 && rows.every(r => r.game_id === '2026_01_TB_CIN'));
  const home = rows.find(r => r.market === 'spread' && r.is_home === true);
  assert.equal(home.book, 'consensus:2');
});

test('GET /api/changes composes persisted state; one market capture is honestly not a move', async () => {
  const env = { INTEL_KV: kv(), NFL_CURRENT: currentBinding };
  await ingestInjuries(env, { season: 2026, fetchImpl: espnStub(), now: Date.now() - 60000 });
  await env.INTEL_KV.put('mkt:v1:batches', JSON.stringify([{ batch_id: 'b1', captured_at: '2026-09-11T12:00:00Z', rows: 0 }]));
  const res = await worker.fetch(new Request('https://nfl-api.propbetedge.ai/api/changes'), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.window_hours, 48);
  assert.equal(body.sources.injuries.available, true);
  assert.equal(body.sources.market.available, false);
  assert.equal(body.sources.market.reason, 'one_capture_so_far_a_move_needs_two');
  assert.equal(body.transitions.available, false, 'UPDATED, never CHANGED FROM');
  assert.ok(body.changes.some(c => c.kind === 'GAME_STATUS' && c.status === 'POSTPONED'), 'disruption read from ESPN status text');
  assert.ok(body.changes.some(c => c.kind === 'INJURY_STATUS' && c.player?.name === 'Player 1001'));
  assert.ok(!body.changes.some(c => /from|→/.test(c.headline)));
  assert.equal(body.weather.available, false);
});

test('GET /api/changes without any ingest says why, not "no changes"', async () => {
  const env = { INTEL_KV: kv(), NFL_CURRENT: { fetch: async () => respond({}, 503) } };
  const res = await worker.fetch(new Request('https://x/api/changes'), env, {});
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.sources.injuries.reason, 'first_ingest_pending');
});

test('GET /api/best-line keeps fair value and edge empty and names the snapshot age', async () => {
  const snap = { semantics: 'LAST_VERIFIED_MARKET', captured_at: '2026-09-11T12:00:00Z', captured_at_et: 'Sep 11, 8:00 AM ET', age_seconds: 3600, ingest: { status: 'OK' }, events: [
    { id: 'e1', commence_time: new Date(Date.now() + 2 * 86400000).toISOString(), away_team: 'Tampa Bay Buccaneers', home_team: 'Cincinnati Bengals', bookmakers: [
      { key: 'dk', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Tampa Bay Buccaneers', price: 150 }, { name: 'Cincinnati Bengals', price: -175 }] }] }
    ] }
  ] };
  const env = { NFL_ODDS: { fetch: async () => respond(snap) } };
  const res = await worker.fetch(new Request('https://x/api/best-line'), env, {});
  const body = await res.json();
  assert.equal(body.window_days, 8, 'absent days is the default window, not one day');
  assert.equal(body.price_semantics, 'SCHEDULED_SNAPSHOT_NOT_LIVE');
  const side = body.events[0].markets.moneyline['Tampa Bay Buccaneers'];
  assert.equal(side.best.price, 150);
  assert.equal(side.pbe_fair, null);
  assert.equal(side.model_edge, null);
});

test('manual lane run requires the admin token', async () => {
  const res = await worker.fetch(new Request('https://x/api/intel/run', { method: 'POST' }), { INTEL_ADMIN_TOKEN: 'secret' }, {});
  assert.equal(res.status, 401);
});
