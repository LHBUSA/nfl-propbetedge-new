/* Player DNA NEXT GAME truth — shared by QB / WR / RB / TE.
 *
 * Production bug (2026-09-15): Josh Allen's hero said "BUF has no upcoming game
 * on this slate" while DET @ BUF was scheduled for Thu Sep 17 8:15 PM ET. The DNA
 * slate is ESPN's undated scoreboard, still on the finished Week 1. Next game now
 * comes from nfl-current's team_schedule (schedule authority); market existence
 * is a separate property.
 *
 * Fixture: production's real Week 1 (all FINAL) + Week 2 schedule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { teamSchedule } from '../workers/nfl-current/src/slate.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/nfl-slate-2026-week1-week2.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-09-15T11:00:00Z');
const plain = v => JSON.parse(JSON.stringify(v));
const withStates = (games, fn) => games.map(g => ({ ...g, semantics: fn(g) }));
const tuesday = () => withStates(FIX.games, g => (g.week === 1 ? 'FINAL' : 'SCHEDULE'));

/* The shared DNA module, loaded as the browser loads it. */
function loadShared(contract) {
  const window = { PBESeason: contract === undefined ? undefined : { data: contract, latestFinal: () => contract?.latest_final || null, onReady: fn => fn(contract) } };
  const sandbox = { window, document: { getElementById: () => null, addEventListener() {}, createElement: () => ({}), body: {} }, setTimeout, clearTimeout, console, Intl, Date };
  vm.runInNewContext(readFileSync(new URL('../player-dna-shared.js', import.meta.url), 'utf8'), sandbox);
  return window.PBEPlayerDNA;
}
/* The DNA slate as production serves it on Tuesday: Week 1 only, all final. */
function slateRow(g, extra = {}) {
  return { espn_event_id: g.id, label: g.name, kickoff_utc: g.kickoff, status: g.semantics === 'FINAL' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED',
    home_team: g.home.abbreviation, away_team: g.away.abbreviation,
    home: { abbreviation: g.home.abbreviation, media: {} }, away: { abbreviation: g.away.abbreviation, media: {} }, market_event_id: null, ...extra };
}
const tuesdaySlate = () => ({ games: tuesday().filter(g => g.week === 1).map(g => slateRow(g)) });

test('schedule authority: BUF last final BUF @ HOU (with score), next DET @ BUF Thu Sep 17 8:15 PM ET', () => {
  const t = teamSchedule(tuesday(), NOW).BUF;
  assert.equal(t.last_final.name, 'BUF @ HOU');
  assert.equal(t.last_final.semantics, 'FINAL');
  assert.ok(t.last_final.away_score != null && t.last_final.home_score != null);
  assert.equal(t.next.name, 'DET @ BUF');
  assert.equal(t.next.espn_event_id, '401872932');
  assert.equal(t.next.kickoff_utc, '2026-09-18T00:15Z');
  assert.equal(t.next.week, 2);
  /* every team has a real Week 2 game */
  const all = teamSchedule(tuesday(), NOW);
  assert.equal(Object.values(all).filter(x => x.next && x.next.week === 2).length, 32);
});

test('ACCEPTANCE (production bug): Josh Allen / BUF — hero shows DET @ BUF, never "no upcoming game"', () => {
  const contract = { team_schedule: teamSchedule(tuesday(), NOW) };
  const PD = loadShared(contract);
  const pick = PD.pickSlateGame(tuesdaySlate(), 'BUF');
  assert.equal(pick.scheduleKnown, true);
  assert.equal(pick.nextGame.espn_event_id, '401872932');
  assert.equal(pick.next.espn_event_id, '401872932', 'products read .next');
  assert.equal(pick.lastFinished.label, 'BUF @ HOU');
  assert.equal(pick.marketAvailable, false);
  const html = PD.heroNextFallback(pick, 'BUF');
  assert.match(html, /<b>DET<\/b><em>@<\/em>.*<b>BUF<\/b>/s);
  assert.match(html, /THU SEP 17 · 8:15 PM ET/);
  assert.match(html, /Market unavailable/);
  assert.match(html, /Last: FINAL · BUF \d+–\d+ HOU/);
  assert.doesNotMatch(html, /no upcoming game|no scheduled game/i);
  assert.equal(PD.contextQuery(pick), 'event_id=401872932&date=20260917', 'context read carries the kickoff ET date');
});

test('next game + market exists: marketAvailable true, market chip open, game unchanged', () => {
  const PD = loadShared({ team_schedule: teamSchedule(tuesday(), NOW) });
  const det = tuesday().find(g => g.id === '401872932');
  const slate = { games: [...tuesdaySlate().games, slateRow(det, { market_event_id: 'mkt_det_buf' })] };
  const pick = PD.pickSlateGame(slate, 'DET');
  assert.equal(pick.nextGame.espn_event_id, '401872932');
  assert.deepEqual(plain(pick.marketGame), { espn_event_id: '401872932', market_event_id: 'mkt_det_buf' });
  assert.equal(pick.marketAvailable, true);
  assert.match(PD.heroNextFallback(pick, 'DET'), /Market open/);
  assert.match(PD.marketStateHtml({ markets: { available: true } }, pick), /Market open/);
  assert.match(PD.marketStateHtml({ markets: { available: false } }, pick), /Market unavailable/, 'context verdict wins');
});

test('next game + market missing: the real opponent/kickoff, Market unavailable, no fabricated line', () => {
  const PD = loadShared({ team_schedule: teamSchedule(tuesday(), NOW) });
  const pick = PD.pickSlateGame({ games: [] }, 'KC');
  assert.equal(pick.nextGame.name, 'IND @ KC');
  assert.equal(pick.marketAvailable, false);
  const html = PD.heroNextFallback(pick, 'KC');
  assert.match(html, /IND/); assert.match(html, /SUN SEP 20 · 8:20 PM ET/); assert.match(html, /Market unavailable/);
  assert.doesNotMatch(html, /[+-]\d+\.5|O\/U/, 'no line is printed');
});

test('bye week: next game 12 days out (beyond the old ±10-day window) is still next', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const games = [
    { id: 'w4', name: 'NYJ @ BUF', kickoff: '2026-10-04T17:00Z', week: 4, season: 2026, season_type: 'REG', semantics: 'FINAL', away: { abbreviation: 'NYJ', score: 10 }, home: { abbreviation: 'BUF', score: 20 } },
    { id: 'w6', name: 'BUF @ MIA', kickoff: '2026-10-18T17:00Z', week: 6, season: 2026, season_type: 'REG', semantics: 'SCHEDULE', away: { abbreviation: 'BUF' }, home: { abbreviation: 'MIA' } }
  ];
  const PD = loadShared({ team_schedule: teamSchedule(games, now) });
  const pick = PD.pickSlateGame({ games: [] }, 'BUF');
  assert.equal(pick.nextGame.espn_event_id, 'w6');
  assert.equal(pick.nextGame.week, 6);
  assert.doesNotMatch(PD.heroNextFallback(pick, 'BUF'), /no scheduled game/i);
});

test('postseason: a drawn playoff game is next; an eliminated team has none and says so with its last final', () => {
  const now = Date.parse('2027-01-12T12:00:00Z');
  const games = [
    { id: 'r18', name: 'BUF @ NYJ', kickoff: '2027-01-10T18:00Z', week: 18, season: 2026, season_type: 'REG', semantics: 'FINAL', away: { abbreviation: 'BUF', score: 27 }, home: { abbreviation: 'NYJ', score: 3 } },
    { id: 'wc1', name: 'PIT @ BUF', kickoff: '2027-01-17T21:30Z', week: 1, season: 2026, season_type: 'POST', semantics: 'SCHEDULE', away: { abbreviation: 'PIT' }, home: { abbreviation: 'BUF' } },
    { id: 'tbd', name: 'TBD @ KC', kickoff: '2027-01-24T21:30Z', week: 2, season: 2026, season_type: 'POST', semantics: 'SCHEDULE', away: { abbreviation: 'TBD' }, home: { abbreviation: 'KC' } }
  ];
  const sched = teamSchedule(games, now);
  assert.equal(sched.TBD, undefined, 'TBD placeholders are not teams');
  const PD = loadShared({ team_schedule: sched });
  const buf = PD.pickSlateGame({ games: [] }, 'BUF');
  assert.equal(buf.nextGame.espn_event_id, 'wc1');
  assert.equal(buf.nextGame.season_type, 'POST');
  const nyj = PD.pickSlateGame({ games: [] }, 'NYJ');
  assert.equal(nyj.nextGame, null);
  const html = PD.heroNextFallback(nyj, 'NYJ');
  assert.match(html, /NYJ has no scheduled game in the current schedule window/);
  assert.match(html, /Last: FINAL · BUF 27–3 NYJ/);
});

test('genuinely no future game (offseason): the no-game state, only because the schedule authority says so', () => {
  const now = Date.parse('2027-03-01T12:00:00Z');
  const games = [{ id: 'sb', name: 'KC @ PHI', kickoff: '2027-02-07T23:30Z', week: 5, season: 2026, season_type: 'POST', semantics: 'FINAL', away: { abbreviation: 'KC', score: 20 }, home: { abbreviation: 'PHI', score: 24 } }];
  const PD = loadShared({ team_schedule: teamSchedule(games, now) });
  const pick = PD.pickSlateGame({ games: [] }, 'BUF');
  assert.equal(pick.scheduleKnown, true);
  assert.equal(pick.nextGame, null);
  assert.match(PD.heroNextFallback(pick, 'BUF'), /BUF has no scheduled game/);
});

test('schedule authority not loaded yet: nothing is asserted about a missing game', () => {
  const PD = loadShared(null);
  const pick = PD.pickSlateGame(tuesdaySlate(), 'BUF');
  assert.equal(pick.scheduleKnown, false);
  assert.equal(pick.nextGame, null, 'the finished BUF @ HOU is never next');
  assert.equal(pick.lastFinished.espn_event_id, '401872660');
  assert.equal(PD.heroNextFallback(pick, 'BUF'), '', 'blank rather than "no upcoming game"');
});

test('player changed teams: next game follows the current team, never a former team\'s game', () => {
  /* Davante Adams: LV/NYJ in 2024, LAR now. The slate row for his old team is ignored. */
  const PD = loadShared({ team_schedule: teamSchedule(tuesday(), NOW) });
  const lvGame = tuesday().find(g => g.id && (g.home.abbreviation === 'LV' || g.away.abbreviation === 'LV') && g.week === 2);
  const slate = { games: [slateRow(lvGame, { market_event_id: 'mkt_lv' })] };
  const pick = PD.pickSlateGame(slate, 'LAR');
  assert.equal(pick.nextGame.name, 'NYG @ LAR');
  assert.ok(![pick.nextGame.home_team, pick.nextGame.away_team].includes('LV'));
  assert.equal(pick.marketAvailable, false, "the old team's market is not this game's market");
});

test('kickoff label carries weekday, date and ET time for every product', () => {
  const PD = loadShared({ team_schedule: {} });
  assert.equal(PD.kickoffLabel('2026-09-18T00:15Z'), 'THU SEP 17 · 8:15 PM ET');
  assert.equal(PD.kickoffLabel('2026-09-20T17:00Z'), 'SUN SEP 20 · 1:00 PM ET');
});

test('all four products route through the shared resolver (no per-product schedule logic)', () => {
  for (const f of ['qb-dna-v2.js', 'wr-dna-v1.js', 'rb-dna-v1.js', 'te-dna-v1.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /PD\.pickSlateGame\(state\.slate, team, state\.dna\.player\)/, f);
    assert.match(src, /if \(state\.dna && PD\.isRetired\(state\.dna\.player\)\) return '';/, f);
    assert.match(src, /PD\.teamLabel\(p, t\)/, f);
    assert.equal((src.match(/if \(state\.dna && PD\.isRetired\(state\.dna\.player\)\) return '';/g) || []).length, 2, `${f}: heroNext AND heroLines stand down for a retired player`);
    assert.match(src, /await PD\.scheduleReady\(\)/, f);
    assert.match(src, /PD\.contextQuery\(state\.slatePick\)/, f);
    assert.match(src, /PD\.heroNextFallback\(state\.slatePick, tm\)/, f);
    assert.match(src, /PD\.marketStateHtml\(c, state\.slatePick\)/, f);
    assert.doesNotMatch(src, /if \(!state\.slate\.games\.length\) return;/, `${f}: an empty scoreboard slate must not end resolution`);
    assert.doesNotMatch(src, /has no upcoming game/, f);
  }
});

/* ---- game-context: a scheduled game off the undated board still resolves ---- */
function espnEvent(g, state) {
  return { id: g.id, date: g.kickoff, competitions: [{ status: { type: { name: state } }, neutralSite: false, venue: { fullName: 'Highmark Stadium', indoor: false },
    competitors: [{ homeAway: 'home', team: { id: '2', abbreviation: g.home.abbreviation, displayName: g.home.display_name } }, { homeAway: 'away', team: { id: '8', abbreviation: g.away.abbreviation, displayName: g.away.display_name } }] }] };
}

test('game-context?event_id=DET@BUF&date=20260917 resolves from the dated board; market absence only marks markets', async () => {
  const { default: handler } = await import('../api/qb-dna/game-context.js');
  const realFetch = globalThis.fetch;
  const seen = [];
  const week1 = tuesday().filter(g => g.week === 1).map(g => espnEvent(g, 'STATUS_FINAL'));
  const det = FIX.games.find(g => g.id === '401872932');
  globalThis.fetch = async url => {
    const u = String(url); seen.push(u);
    const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('scoreboard?dates=20260917')) return ok({ events: [espnEvent(det, 'STATUS_SCHEDULED')] });
    if (u.includes('/scoreboard')) return ok({ events: week1 });
    if (u.includes('/api/odds/events')) return ok({ events: [] });
    return new Response('nope', { status: 503 });
  };
  const call = async query => {
    const out = { status: 0, body: '' };
    const res = { statusCode: 200, setHeader() {}, end(b) { out.body = b; } };
    await handler({ query }, res);
    out.status = res.statusCode;
    return { status: out.status, body: JSON.parse(out.body) };
  };
  try {
    const undated = await call({ event_id: '401872932' });
    assert.equal(undated.status, 404, 'without a date the undated board (Week 1) cannot see it — the old failure');
    const r = await call({ event_id: '401872932', date: '20260917' });
    assert.equal(r.status, 200);
    assert.equal(r.body.game.label, 'DET @ BUF');
    assert.equal(r.body.game.kickoff_utc, '2026-09-18T00:15Z');
    assert.equal(r.body.markets.available, false);
    assert.ok(r.body.unresolved.some(u => u.field === 'current_markets'), 'market absence is recorded as a market fact');
    assert.ok(seen.some(u => u.includes('scoreboard?dates=20260917')));
  } finally { globalThis.fetch = realFetch; }
});

test('retired player (Tom Brady, active_2026 false): no next matchup, no market chip, Last team', () => {
  /* TB has a real Week 2 game; it is not Brady's. */
  const PD = loadShared({ team_schedule: teamSchedule(tuesday(), NOW) });
  const brady = { name: 'Tom Brady', current_team: 'TB', active_2026: false, team: { abbreviation: 'TB', name: 'Tampa Bay Buccaneers' } };
  const pick = PD.pickSlateGame(tuesdaySlate(), 'TB', brady);
  assert.equal(pick.retired, true);
  assert.equal(pick.nextGame, null);
  assert.equal(pick.next, null);
  assert.equal(pick.marketAvailable, false);
  assert.equal(PD.heroNextFallback(pick, 'TB'), '', 'no NEXT block, and no "no scheduled game" either');
  assert.equal(PD.marketStateHtml({ markets: { available: true } }, pick), '', 'no market chip even if a context was loaded');
  assert.equal(PD.isRetired(brady), true);
  assert.equal(PD.teamLabel(brady, brady.team), 'Last team · Tampa Bay Buccaneers');
  /* an active player on the same team still resolves the game */
  const active = { current_team: 'TB', active_2026: true, team: { abbreviation: 'TB', name: 'Tampa Bay Buccaneers' } };
  assert.equal(PD.pickSlateGame(tuesdaySlate(), 'TB', active).nextGame.name, 'CLE @ TB');
  assert.equal(PD.teamLabel(active, active.team), 'Tampa Bay Buccaneers');
  /* a player with no roster verdict is not treated as retired */
  assert.equal(PD.isRetired({ current_team: 'TB' }), false);
});
