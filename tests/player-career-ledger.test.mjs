/* Career Ledger acceptance: factual history, live totals, no double count.
 *
 * Runs against the committed ledger (data/dist/career-ledger.json) and real
 * ESPN payloads captured 2026-09-15: DEN @ KC (401872931, final) box score and
 * Patrick Mahomes' 2026 game log. LIVE and correction states are derived from
 * those real payloads by changing the fields a provider would change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { composeCareer, parseGamelog, boxScoreLine, eventState, totals, STAT_KEYS, isRookieCandidate, parseRookieEvidence, evaluateRookie } from '../api/_career/ledger-core.js';

const LEDGER = JSON.parse(readFileSync(new URL('../data/dist/career-ledger.json', import.meta.url), 'utf8'));
const SUMMARY_FINAL = JSON.parse(readFileSync(new URL('./fixtures/career-summary-401872931-final.json', import.meta.url), 'utf8'));
const GAMELOG_2026 = JSON.parse(readFileSync(new URL('./fixtures/career-gamelog-3139477-2026.json', import.meta.url), 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v));
const P = id => LEDGER.players[id];
const MNF = '401872931';

function career(id, { currentRows = [], currentAvailable = true, summary = null, boxFetchedAt = '2026-09-15T02:00:00Z' } = {}) {
  const boxScore = summary ? { event: eventState(summary), line: boxScoreLine(summary, id) } : null;
  return composeCareer({
    player: P(id), currentSeason: 2026, currentRows, currentAvailable, currentError: currentAvailable ? null : 'upstream_503',
    boxScore: boxScore?.line ? boxScore : null, boxFetchedAt, currentFetchedAt: '2026-09-15T11:00:00Z', historyMeta: LEDGER.meta
  });
}

/* A live version of the real final box score, as ESPN publishes mid-game. */
function liveSummary({ period = 3, clock = '8:21', cmp = 11, att = 19, pyd = 131, ptd = 1 } = {}) {
  const s = clone(SUMMARY_FINAL);
  const c = s.header.competitions[0];
  c.status = { period, displayClock: clock, type: { state: 'in', completed: false, shortDetail: `${clock} - ${period}rd` } };
  c.competitors.find(x => x.team.abbreviation === 'KC').score = '17';
  c.competitors.find(x => x.team.abbreviation === 'DEN').score = '10';
  const kc = s.boxscore.players.find(t => t.team.abbreviation === 'KC');
  const pass = kc.statistics.find(g => g.name === 'passing').athletes.find(a => a.athlete.id === '3139477');
  pass.stats[0] = `${cmp}/${att}`; pass.stats[1] = String(pyd); pass.stats[3] = String(ptd);
  return s;
}

const SUMS = ['games', ...STAT_KEYS];
function assertSumsReconcile(body) {
  for (const [st, key] of [['REG', 'regular_season'], ['POST', 'postseason']]) {
    const seasons = body.seasons.filter(s => s.season_type === st);
    const games = body.game_log.filter(g => g.season_type === st && g.status !== 'LIVE');
    assert.equal(body.totals[key].games, games.length, `${st} games = game rows`);
    for (const k of SUMS) {
      const career = body.totals[key][k];
      if (career === null) continue;
      assert.equal(career, seasons.reduce((a, s) => a + s[k], 0), `${st} ${k}: career = sum of seasons`);
      assert.equal(career, games.reduce((a, g) => a + (k === 'games' ? 1 : g.stats[k]), 0), `${st} ${k}: career = sum of games`);
    }
  }
}

/* ---- history + identity ---------------------------------------------------- */
test('identity audit: every ESPN id maps to exactly one GSIS id, no conflicts, no ambiguity', () => {
  const a = LEDGER.meta.identity_audit;
  assert.equal(a.nflverse_gsis_conflict.length, 0);
  assert.equal(a.nflverse_ambiguous.length, 0);
  assert.equal(a.nflverse_missing.length, 0);
  assert.equal(a.nflverse_gsis_match, a.dna_players);
  assert.equal(LEDGER.meta.failures.length, 0);
});

for (const [pos, id, name, debut, teams] of [
  ['QB', '2330', 'Tom Brady', 2000, ['NE', 'TB']],
  ['RB', '3043078', 'Derrick Henry', 2016, ['TEN', 'BAL']],
  ['WR', '15795', 'DeAndre Hopkins', 2013, ['HOU', 'ARI', 'TEN', 'KC', 'BAL']],
  ['TE', '12537', 'Jared Cook', 2009, ['TEN', 'STL', 'GB', 'OAK', 'NO', 'LAC']]
]) {
  test(`${pos} full history: ${name} — debut ${debut} through today proven, career = seasons = games, one ledger across ${teams.length} teams`, () => {
    const rows2026 = pos === 'QB' ? [] : [];
    const body = career(id, { currentRows: rows2026 });
    assert.equal(body.label, 'CAREER');
    assert.equal(body.coverage.complete, true);
    assert.equal(body.coverage.debut_season, debut);
    assert.deepEqual(body.coverage.missing_seasons, []);
    assert.equal(body.player.name, name);
    assert.ok(body.player.dna_positions.includes(pos));
    assert.deepEqual(body.player.teams, teams, 'one identity across every team, in order');
    assert.equal(body.seasons.filter(s => s.season_type === 'REG')[body.seasons.filter(s => s.season_type === 'REG').length - 1].season, debut);
    assertSumsReconcile(body);
    assert.equal(body.totals.regular_season.starts, null, 'starts unsupported -> null, never 0');
  });
}

test('QB: Brady regular-season career matches the provider career row exactly (335 G, 7,753 CMP, 12,050 ATT)', () => {
  const body = career('2330');
  assert.equal(body.totals.regular_season.games, 335);
  assert.equal(body.totals.regular_season.cmp, 7753);
  assert.equal(body.totals.regular_season.att, 12050);
  assert.equal(body.totals.regular_season.pyd, P('2330').provider_career_regular_season.pyd);
  assert.equal(body.totals.regular_season.rec, null, 'a QB game log publishes no receiving -> unknown, not 0');
  assert.equal(body.excluded_events.every(e => e.reason === 'pro_bowl'), true);
});

test('team change mid-season: Davante Adams 2024 is one season row with LV/NYJ, never two players', () => {
  const body = career('16800');
  const s24 = body.seasons.find(s => s.season === 2024 && s.season_type === 'REG');
  assert.deepEqual(s24.teams, ['LV', 'NYJ']);
  assert.equal(s24.games, 14);
  assert.equal(new Set(body.game_log.map(g => g.event_id)).size, body.game_log.length, 'no event twice');
});

test('one identity across two DNA products: Taysom Hill (QB + TE) has one ledger', () => {
  const body = career('2468609');
  assert.deepEqual(body.player.dna_positions, ['QB', 'TE']);
  assert.equal(Object.values(LEDGER.players).filter(p => p.gsis_id === P('2468609').gsis_id).length, 1);
});

test('duplicate names never merge: Josh Allen QB vs Josh Allen C, Mike Williams WR (2017) vs Mike Williams WR (2010)', () => {
  const qb = P('3918298');
  assert.equal(qb.name, 'Josh Allen');
  assert.deepEqual([...new Set(qb.games.map(g => g.t))], ['BUF']);
  assert.equal(qb.games[0].s, 2018);
  assert.equal(P('17102'), undefined, 'the other Josh Allen (C, ESPN 17102) is not in this ledger');
  const mw = P('3045138');
  assert.equal(mw.name, 'Mike Williams');
  assert.equal(mw.games[0].s, 2017, 'no 2010-2014 Buccaneers games from the other Mike Williams');
  assert.ok(!mw.games.some(g => g.t === 'TB'));
  assert.equal(P('13489'), undefined);
  const names = Object.values(LEDGER.players).map(p => p.name);
  assert.equal(new Set(Object.keys(LEDGER.players)).size, names.length, 'keyed by ESPN id only');
});

test('missing history: Travis Kelce is TRACKED HISTORY, 2013 named as missing, never CAREER', () => {
  const body = career('15847');
  assert.equal(body.label, 'TRACKED HISTORY');
  assert.equal(body.coverage.complete, false);
  assert.ok(body.coverage.missing_seasons.some(m => m.season === 2013));
  assert.ok(body.coverage.why_not_career.some(w => w.startsWith('2013')));
});

test('current season unreadable -> TRACKED HISTORY with the reason, even for a proven history', () => {
  const body = career('3139477', { currentAvailable: false });
  assert.equal(body.label, 'TRACKED HISTORY');
  assert.equal(body.coverage.current_season.available, false);
  assert.ok(body.coverage.why_not_career.some(w => w.startsWith('2026')));
});

/* ---- current season, live, final, correction -------------------------------- */
const MAHOMES = '3139477';
const current2026 = () => parseGamelog(clone(GAMELOG_2026), 2026).rows;

test('2026 completed game is included exactly once (game log + final box score of the same event)', () => {
  const hist = career(MAHOMES);
  const body = career(MAHOMES, { currentRows: current2026(), summary: SUMMARY_FINAL });
  assert.equal(body.label, 'CAREER');
  assert.equal(body.game_log.filter(g => g.event_id === MNF).length, 1);
  assert.equal(body.game_log[0].event_id, MNF);
  assert.equal(body.game_log[0].source, 'ledger');
  assert.equal(body.totals.regular_season.games, hist.totals.regular_season.games + 1);
  assert.equal(body.totals.regular_season.pyd, hist.totals.regular_season.pyd + 184);
  assert.equal(body.live, null);
  assertSumsReconcile(body);
});

test('the real box score line equals the real game-log row for the same game (provider parity)', () => {
  const line = boxScoreLine(SUMMARY_FINAL, MAHOMES);
  const row = current2026().find(r => r.e === MNF);
  for (const k of Object.keys(row.x)) assert.equal(line.x[k], row.x[k], k);
});

test('LIVE: prior career + published live box score = live career totals; verified totals exclude it', () => {
  const prior = career(MAHOMES);
  const body = career(MAHOMES, { currentRows: [], summary: liveSummary(), boxFetchedAt: '2026-09-15T01:40:00Z' });
  assert.ok(body.live);
  assert.equal(body.live.state, 'LIVE');
  assert.equal(body.live.through, 'Q3 · 8:21');
  assert.equal(body.live.box_score_fetched_at, '2026-09-15T01:40:00Z');
  assert.deepEqual(body.totals, prior.totals, 'verified career is exactly the prior final');
  const lt = body.live.totals.regular_season;
  assert.equal(lt.games, prior.totals.regular_season.games + 1);
  assert.equal(lt.pyd, prior.totals.regular_season.pyd + 131);
  assert.equal(lt.cmp, prior.totals.regular_season.cmp + 11);
  assert.equal(lt.att, prior.totals.regular_season.att + 19);
  assert.equal(body.game_log[0].status, 'LIVE');
  assert.equal(body.game_log[0].source, 'live_box_score');
  assert.equal(body.seasons.find(s => s.season === 2026).provisional, true);
  assert.deepEqual(Object.keys(body.game_log[0].stats).sort(), Object.keys(prior.game_log[0].stats).sort(), 'live row has the game-log shape');
});

test('LIVE update: a newer published line moves live totals by exactly the delta', () => {
  const a = career(MAHOMES, { summary: liveSummary({ pyd: 131, att: 19, cmp: 11 }) });
  const b = career(MAHOMES, { summary: liveSummary({ period: 4, clock: '2:03', pyd: 170, att: 25, cmp: 14 }) });
  assert.equal(b.live.totals.regular_season.pyd - a.live.totals.regular_season.pyd, 39);
  assert.equal(b.live.totals.regular_season.games, a.live.totals.regular_season.games);
  assert.equal(b.live.through, 'Q4 · 2:03');
});

test('FINAL transition: provisional row -> final box score -> game-log row; totals converge, never double count', () => {
  const live = career(MAHOMES, { summary: liveSummary() });
  const finalNoLog = career(MAHOMES, { currentRows: [], summary: SUMMARY_FINAL });
  const finalLogged = career(MAHOMES, { currentRows: current2026(), summary: SUMMARY_FINAL });
  assert.equal(finalNoLog.live, null, 'provisional contribution is gone once final');
  assert.equal(finalNoLog.game_log[0].source, 'final_box_score');
  assert.equal(finalNoLog.game_log[0].status, 'FINAL');
  assert.equal(finalNoLog.totals.regular_season.games, live.live.totals.regular_season.games, 'same game count as while live');
  assert.deepEqual(finalLogged.totals, finalNoLog.totals, 'final box score and game-log row converge exactly');
  assert.equal(finalLogged.game_log.filter(g => g.event_id === MNF).length, 1);
  assertSumsReconcile(finalLogged);
});

test('correction: an upstream stat correction in the game log propagates deterministically', () => {
  const before = career(MAHOMES, { currentRows: current2026() });
  const corrected = clone(GAMELOG_2026);
  const names = corrected.names;
  const ev = corrected.seasonTypes.flatMap(s => s.categories.flatMap(c => c.events)).find(e => e.eventId === MNF);
  ev.stats[names.indexOf('passingYards')] = '186';
  const after = career(MAHOMES, { currentRows: parseGamelog(corrected, 2026).rows, summary: SUMMARY_FINAL });
  assert.equal(after.totals.regular_season.pyd - before.totals.regular_season.pyd, 2);
  assert.equal(after.totals.regular_season.games, before.totals.regular_season.games);
  assert.equal(after.game_log[0].stats.pyd, 186, 'game log (corrected) outranks the box score');
  const again = career(MAHOMES, { currentRows: parseGamelog(clone(corrected), 2026).rows, summary: SUMMARY_FINAL });
  assert.deepEqual(again.totals, after.totals, 'same input, same output');
});

test('athlete not in the box score (inactive) -> no live contribution', () => {
  const body = career('2330', { summary: liveSummary() });
  assert.equal(body.live, null);
});

test('totals: a field is null unless every row publishes it', () => {
  const t = totals([{ x: { pyd: 10, tgt: 3 } }, { x: { pyd: 5, tgt: null } }, { x: { pyd: 1 } }]);
  assert.equal(t.pyd, 16);
  assert.equal(t.tgt, null);
  assert.equal(t.games, 3);
  assert.equal(t.starts, null);
});

/* ---- client: freshness ticks locally, no one-second fetch loop --------------- */
test('client polling: live -> 15s cadence, never 1s; final/hidden/no game -> no polling', () => {
  const sandbox = { window: {}, document: { addEventListener() {}, visibilityState: 'visible', getElementById: () => null, querySelector: () => null }, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => { throw new Error('no fetch at load'); }, console };
  sandbox.window.addEventListener = () => {};
  vm.runInNewContext(readFileSync(new URL('../player-career-ledger-v1.js', import.meta.url), 'utf8'), sandbox);
  const cl = sandbox.window.PBECareerLedger;
  const liveBody = career(MAHOMES, { summary: liveSummary() });
  assert.equal(cl.nextPollDelay(liveBody, Date.now(), true), 15000);
  assert.ok(cl.nextPollDelay(liveBody, Date.now(), true) >= 10000, 'no one-second network loop');
  assert.equal(cl.nextPollDelay(liveBody, Date.now(), false), null, 'hidden tab stops polling');
  const finalBody = career(MAHOMES, { currentRows: current2026(), summary: SUMMARY_FINAL });
  assert.equal(cl.nextPollDelay({ ...finalBody, today: { state: 'FINAL' } }, Date.now(), true), null, 'final stops polling');
  assert.equal(cl.nextPollDelay({ ...finalBody, today: null }, Date.now(), true), null);
  const kick = Date.parse('2026-09-18T00:15:00Z');
  assert.equal(cl.nextPollDelay({ ...finalBody, today: { state: 'SCHEDULE', kickoff: '2026-09-18T00:15:00Z' } }, kick - 3600000, true), null, 'an hour before kickoff: nothing');
  assert.equal(cl.nextPollDelay({ ...finalBody, today: { state: 'SCHEDULE', kickoff: '2026-09-18T00:15:00Z' } }, kick - 300000, true), 60000, 'kickoff discovery: once a minute in the last ten minutes');
});

/* ---- ROOKIE · NO PRIOR NFL HISTORY (contract revision 1.1) --------------------- */
const RK = {
  haynesKing: '4428993',      // ESPN "Rookie", no stats, no 2026 game
  zachBranch: '4870612',      // ESPN "Rookie", 2026 returning row, one 2026 game
  jordanWaters: '4428803',    // ESPN "1st Season": must stay TRACKED
  xavierGuillory: '4695910'   // ESPN "1st Season": must stay TRACKED
};
const ev = (over = {}) => ({ provider_experience: 'Rookie', provider_debut_year: null, provider_stat_seasons: [], stats_read: true, fetched_at: '2026-09-15T16:00:00Z', ...over });
const rookieBody = (id, evidence, extra = {}) => composeCareer({ player: P(id), currentSeason: 2026, currentRows: [], currentAvailable: true, historyMeta: LEDGER.meta, rookieEvidence: evidence, ...extra });

test('ROOKIE: every non-candidate keeps v1 label/coverage exactly; CAREER and TRACKED unchanged across all 1,203 players', () => {
  let career = 0, tracked = 0, candidates = 0;
  for (const [id, player] of Object.entries(LEDGER.players)) {
    const base = composeCareer({ player, currentSeason: 2026, currentRows: [], currentAvailable: true, historyMeta: LEDGER.meta });
    /* the most rookie-looking evidence possible, applied to everyone */
    const withEv = composeCareer({ player, currentSeason: 2026, currentRows: [], currentAvailable: true, historyMeta: LEDGER.meta, rookieEvidence: ev() });
    assert.equal(withEv.label, base.label, `${id}: v1 label unchanged`);
    assert.equal(withEv.coverage.complete, base.coverage.complete, `${id}: completeness unchanged`);
    assert.ok(['CAREER', 'TRACKED HISTORY'].includes(withEv.label), 'label keeps v1 values only');
    if (base.label === 'CAREER') { career++; assert.equal(withEv.history_state, 'CAREER'); }
    else tracked++;
    if (isRookieCandidate(player)) candidates++;
    else assert.notEqual(withEv.history_state, 'ROOKIE_NO_PRIOR_HISTORY', `${id}: a player with any ledger history is never ROOKIE`);
    assert.equal(base.history_state, base.label === 'CAREER' ? 'CAREER' : 'TRACKED_HISTORY', 'without provider evidence nobody is ROOKIE');
    assert.equal(base.contract, 'player-career/v1');
    assert.equal(base.contract_revision, '1.1');
  }
  assert.equal(candidates, 172, 'exactly the no-history players are candidates');
  assert.ok(career > 400 && tracked > 600);
});

test('ROOKIE: strict criteria pass -> ROOKIE · NO PRIOR NFL HISTORY, still TRACKED in v1 label, never CAREER', () => {
  const b = rookieBody(RK.haynesKing, ev());
  assert.equal(b.history_state, 'ROOKIE_NO_PRIOR_HISTORY');
  assert.equal(b.display_label, 'ROOKIE · NO PRIOR NFL HISTORY');
  assert.equal(b.label, 'TRACKED HISTORY', 'v1 consumers see the unchanged v1 value');
  assert.equal(b.coverage.complete, false, 'no rookie is a proven career');
  assert.equal(b.rookie.qualifies, true);
  assert.equal(b.rookie.failed.length, 0);
  assert.deepEqual(plainJson(b.coverage.why_not_career), ['no NFL season before 2026 (provider: Rookie)']);
  assert.equal(b.totals.regular_season.games, 0);
  assert.equal(b.career_span, null);
});

test('ROOKIE: a rookie who has played keeps ROOKIE with his current-season games, never CAREER', () => {
  const rows = [{ e: '401872658', d: '2026-09-13T17:00:00Z', s: 2026, st: 'REG', w: 1, t: 'ATL', o: 'PIT', h: 0, r: 'L 13-20', x: { rec: 0, tgt: 0, recyd: 0, rectd: 0, car: 0, ryd: 0, rtd: 0 } }];
  const b = rookieBody(RK.zachBranch, ev({ provider_stat_seasons: [2026] }), { currentRows: rows });
  assert.equal(b.history_state, 'ROOKIE_NO_PRIOR_HISTORY');
  assert.equal(b.label, 'TRACKED HISTORY');
  assert.equal(b.coverage.complete, false);
  assert.equal(b.totals.regular_season.games, 1);
  assert.deepEqual(b.career_span, { from: 2026, to: 2026 });
});

test('ROOKIE: the two "1st Season" players remain TRACKED', () => {
  for (const id of [RK.jordanWaters, RK.xavierGuillory]) {
    const b = rookieBody(id, ev({ provider_experience: '1st Season' }));
    assert.equal(b.history_state, 'TRACKED_HISTORY', P(id).name);
    assert.equal(b.display_label, 'TRACKED HISTORY');
    assert.ok(b.rookie.failed.includes('provider_experience_is_rookie'));
  }
});

test('ROOKIE fails closed on every missing or contrary signal', () => {
  const cases = [
    ['no provider read', null, {}, 'provider_record_read'],
    ['stats not read', ev({ stats_read: false }), {}, 'provider_record_read'],
    ['a stat season before the current season', ev({ provider_stat_seasons: [2025, 2026] }), {}, 'no_provider_stat_season_before_current'],
    ['provider debut in an earlier season', ev({ provider_debut_year: 2024 }), {}, 'provider_debut_year_none_or_current'],
    ['experience not Rookie', ev({ provider_experience: '2nd Season' }), {}, 'provider_experience_is_rookie'],
    ['current season unavailable', ev(), { currentAvailable: false }, 'current_season_available'],
    ['ledger does not cover the prior season (2027 with history through 2025)', ev(), { currentSeason: 2027 }, 'no_ledger_games_before_current']
  ];
  for (const [name, evidence, extra, criterion] of cases) {
    const b = rookieBody(RK.haynesKing, evidence, extra);
    assert.equal(b.history_state, 'TRACKED_HISTORY', name);
    assert.ok(b.rookie.failed.includes(criterion), `${name}: ${b.rookie.failed}`);
  }
  const blocked = composeCareer({ player: P(RK.haynesKing), currentSeason: 2026, currentRows: [], currentAvailable: true,
    historyMeta: { ...LEDGER.meta, identity_audit: { ...LEDGER.meta.identity_audit, blocked_players: [RK.haynesKing] } }, rookieEvidence: ev() });
  assert.equal(blocked.history_state, 'TRACKED_HISTORY');
  assert.ok(blocked.rookie.failed.includes('identity_one_to_one'));
  const noGsis = composeCareer({ player: { ...P(RK.haynesKing), gsis_id: null }, currentSeason: 2026, currentRows: [], currentAvailable: true, historyMeta: LEDGER.meta, rookieEvidence: ev() });
  assert.equal(noGsis.history_state, 'TRACKED_HISTORY');
});

test('ROOKIE evidence reads every stat category (a special-teams row counts); no participation input exists', () => {
  const e = parseRookieEvidence({ athlete: { displayExperience: 'Rookie', debutYear: null } },
    { categories: [{ name: 'returning', statistics: [{ season: { year: 2025 }, stats: ['1'] }] }, { name: 'defensive', statistics: [{ season: { year: 2026 } }] }] }, 'x');
  assert.deepEqual(e.provider_stat_seasons, [2025, 2026]);
  const r = evaluateRookie({ player: P(RK.haynesKing), currentSeason: 2026, currentAvailable: true, evidence: e, historyMeta: LEDGER.meta });
  assert.equal(r.qualifies, false, 'a 2025 returning row means prior NFL history');
  assert.equal(parseRookieEvidence(null, null), null);
  for (const f of ['../api/_career/ledger-core.js', '../api/player-career.js', '../player-career-ledger-v1.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /pbp_participation|players_on_play|nflverse_game_id/, `${f}: no participation input`);
  }
});

function plainJson(v) { return JSON.parse(JSON.stringify(v)); }
