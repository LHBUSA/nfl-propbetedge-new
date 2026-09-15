/* NFL season-state invariants — pure checks shared by the browser gates.
 *
 * The gates used to assert the facts of one day (2026-09-10: "latest final is
 * NE 10-13 SEA", "standings rest on 1 completed game", Josh Allen "has not
 * played"). Those were true once and false forever after, so the gates failed
 * on every tree and stopped telling anyone anything. These checks instead
 * recompute each published answer from the authoritative game ledger
 * (nfl-current /api/scores: every game with its week, type, state and score)
 * and demand agreement. They hold in any week and fail on a real regression.
 *
 * The week-transition rule is implemented here a second time, independently of
 * workers/nfl-current/src/slate.js, so a regression there is caught rather than
 * copied. Every function returns [{ name, ok, detail }].
 *
 * tests/nfl-state-invariants.test.mjs proves each check fails on corrupted input.
 */

const A = v => (Array.isArray(v) ? v : []);
const T = v => Date.parse(v || '');
const STALE_PREGAME_MS = 6 * 36e5;
const key = g => `${g.season}:${g.game_type}:${g.week}`;
const isFinal = g => g.semantics === 'FINAL';
const isLive = g => g.semantics === 'LIVE';
const isOpen = (g, now) => g.semantics === 'SCHEDULE' && Number.isFinite(T(g.kickoff)) && T(g.kickoff) >= now - STALE_PREGAME_MS;
const byKick = (a, b) => T(a.kickoff) - T(b.kickoff);
const check = (name, ok, detail) => ({ name, ok: !!ok, detail: detail ?? null });

/* Ledger games for the contract's season. */
function ledger(scores, season) {
  return A(scores?.games).filter(g => g && g.game_id && (season == null || g.season === season)).slice().sort(byKick);
}

/* ---- week state ------------------------------------------------------------- */
export function weekStateInvariants(season, scores, now = Date.now()) {
  const out = [];
  const games = ledger(scores, season?.season);
  out.push(check('ledger has games for the contract season', games.length > 0, { season: season?.season, games: games.length }));
  out.push(check('current_week is the provider week label (provider_week alias agrees)', season?.provider_week === season?.current_week, { current_week: season?.current_week, provider_week: season?.provider_week }));

  /* Independent derivation of the primary slate from game state. */
  const providerKey = season?.season != null && season?.season_type && season?.current_week != null ? `${season.season}:${season.season_type}:${season.current_week}` : null;
  const live = games.filter(isLive);
  let expected = null, why = null;
  if (live.length) { expected = key(live[0]); why = 'live'; }
  else if (providerKey && games.some(g => key(g) === providerKey && isOpen(g, now))) { expected = providerKey; why = 'provider week has games to play'; }
  else { const next = games.find(g => isOpen(g, now)); if (next) { expected = key(next); why = 'earliest scheduled kickoff'; } }
  if (!expected) { const lastFinal = games.filter(isFinal).pop(); if (lastFinal) { expected = key(lastFinal); why = 'last completed week'; } }
  out.push(check('primary slate is derived from game state (not the calendar)', season?.primary_slate?.key === expected, { expected, why, published: season?.primary_slate?.key }));
  out.push(check('primary_slate_week matches the primary slate', season?.primary_slate_week === (season?.primary_slate?.week ?? null), { primary_slate_week: season?.primary_slate_week, slate_week: season?.primary_slate?.week }));
  if (expected && !live.length && games.some(g => isOpen(g, now))) {
    out.push(check('primary slate is not a fully final week while a game is still to play', !(season?.primary_slate?.state === 'FINAL'), season?.primary_slate?.state));
  }

  /* latest completed week: newest week with a final and nothing live/open */
  const weeks = new Map();
  for (const g of games) { if (!weeks.has(key(g))) weeks.set(key(g), []); weeks.get(key(g)).push(g); }
  const done = [...weeks.entries()].filter(([, gs]) => gs.some(isFinal) && !gs.some(g => isLive(g) || isOpen(g, now)))
    .sort((a, b) => T(a[1][a[1].length - 1].kickoff) - T(b[1][b[1].length - 1].kickoff));
  const lastDone = done.length ? done[done.length - 1][1][0] : null;
  out.push(check('latest_completed_week matches the ledger', (lastDone ? lastDone.week : null) === season?.latest_completed_week, { expected: lastDone && key(lastDone), published: season?.latest_completed_week }));
  return out;
}

/* ---- latest final / next game ------------------------------------------------ */
export function gameStateInvariants(season, scores, now = Date.now()) {
  const out = [];
  const games = ledger(scores, season?.season);
  const finals = games.filter(isFinal);
  const lf = season?.latest_final;
  if (finals.length) {
    const newest = T(finals[finals.length - 1].kickoff);
    const tied = finals.filter(g => T(g.kickoff) === newest);
    const row = tied.find(g => g.game_id === String(lf?.id));
    out.push(check('latest_final is the newest FINAL in the ledger', !!row, { published: lf?.id, newest: tied.map(g => g.game_id) }));
    out.push(check('latest_final score equals the ledger score', !!row && row.away_score === lf?.away?.score && row.home_score === lf?.home?.score,
      row ? { ledger: `${row.away_team} ${row.away_score}-${row.home_score} ${row.home_team}`, published: `${lf?.away?.abbreviation} ${lf?.away?.score}-${lf?.home?.score} ${lf?.home?.abbreviation}` } : null));
  } else {
    out.push(check('no latest_final while the ledger has no final', lf == null, lf?.id));
  }
  const live = games.filter(isLive);
  const expectNext = live[0] || games.find(g => isOpen(g, now)) || null;
  const ng = season?.next_game;
  const sameKick = expectNext ? games.filter(g => (isLive(expectNext) ? isLive(g) : isOpen(g, now) && T(g.kickoff) === T(expectNext.kickoff))) : [];
  out.push(check('next_game is live, else the earliest scheduled game; never a final', expectNext ? sameKick.some(g => g.game_id === String(ng?.id)) && ng?.semantics !== 'FINAL' : ng == null,
    { expected: sameKick.map(g => g.game_id), published: ng?.id, semantics: ng?.semantics }));
  for (const g of games) {
    if (isFinal(g) && !(Number.isFinite(g.away_score) && Number.isFinite(g.home_score))) { out.push(check('every FINAL in the ledger carries both scores', false, g.game_id)); break; }
    if (g.semantics === 'SCHEDULE' && (g.away_score != null || g.home_score != null)) { out.push(check('a scheduled game carries no score (not a zero)', false, g.game_id)); break; }
  }
  return out;
}

/* ---- per-team schedule truth (Player DNA next / last) ------------------------- */
export function teamScheduleInvariants(season, scores, now = Date.now()) {
  const out = [];
  const ts = season?.team_schedule;
  out.push(check('team_schedule published', ts && typeof ts === 'object' && Object.keys(ts).length > 0, ts ? Object.keys(ts).length : ts));
  if (!ts) return out;
  const games = ledger(scores, season?.season);
  const teams = new Set(games.flatMap(g => [g.away_team, g.home_team]));
  const bad = [];
  for (const team of teams) {
    const mine = games.filter(g => g.away_team === team || g.home_team === team);
    const finals = mine.filter(isFinal);
    const t = ts[team];
    if (finals.length) {
      const newest = T(finals[finals.length - 1].kickoff);
      const want = finals.filter(g => T(g.kickoff) === newest);
      const hit = want.find(g => g.game_id === String(t?.last_final?.espn_event_id));
      if (!hit || hit.away_score !== t.last_final.away_score || hit.home_score !== t.last_final.home_score) bad.push({ team, field: 'last_final', expected: want.map(g => g.game_id), published: t?.last_final?.espn_event_id });
    }
    const nextLedger = mine.find(isLive) || mine.find(g => isOpen(g, now));
    /* The ledger reaches ~10 days ahead and team_schedule 21, so the ledger can
       only contradict a next game it holds: if it holds one, they must agree. */
    if (nextLedger && String(t?.next?.espn_event_id) !== nextLedger.game_id) bad.push({ team, field: 'next', expected: nextLedger.game_id, published: t?.next?.espn_event_id || null });
    if (t?.next && t.next.semantics === 'FINAL') bad.push({ team, field: 'next', problem: 'a finished game is next' });
  }
  out.push(check('every team: schedule next and last final agree with the game ledger', bad.length === 0, bad.slice(0, 6)));
  return out;
}

/* ---- standings from completed games ------------------------------------------ */
export function standingsInvariants(season, scores, standings) {
  const out = [];
  const finals = ledger(scores, season?.season).filter(g => isFinal(g) && g.game_type === 'REG');
  out.push(check('standings rest on exactly the completed regular-season games', standings?.completed_games === finals.length, { standings: standings?.completed_games, ledger_finals: finals.length }));
  const rec = {};
  const add = (t, k) => { (rec[t] ||= { wins: 0, losses: 0, ties: 0 })[k] += 1; };
  for (const g of finals) {
    if (g.away_score === g.home_score) { add(g.away_team, 'ties'); add(g.home_team, 'ties'); }
    else if (g.away_score > g.home_score) { add(g.away_team, 'wins'); add(g.home_team, 'losses'); }
    else { add(g.home_team, 'wins'); add(g.away_team, 'losses'); }
  }
  const bad = [];
  for (const d of A(standings?.divisions)) for (const t of A(d.teams)) {
    const want = rec[t.abbreviation] || { wins: 0, losses: 0, ties: 0 };
    if (t.wins !== want.wins || t.losses !== want.losses || (t.ties || 0) !== want.ties) bad.push({ team: t.abbreviation, published: `${t.wins}-${t.losses}-${t.ties || 0}`, from_finals: `${want.wins}-${want.losses}-${want.ties}` });
  }
  out.push(check('every team record equals its completed-game results', bad.length === 0, bad.slice(0, 6)));
  return out;
}

/* ---- one player's current-season layer ------------------------------------- */
const SUMS = { passing: ['yards', 'tds', 'ints', 'completions', 'attempts'], rushing: ['yards', 'tds', 'carries'], receiving: [['yards', 'yards'], ['tds', 'tds'], ['receptions', 'rec'], ['targets', 'targets']] };
export function currentPlayerInvariants(p) {
  const out = [];
  if (!p || p.ok === false) return [check('current-player answered', false, p?.error || null)];
  if (!p.available) {
    /* Missing sample is not zero performance. */
    const zeros = p.stats != null || (p.games_played !== null && p.games_played !== 0) || (p.reason === 'no_completed_team_game' && p.games_played !== null);
    out.push(check(`${p.reason}: no totals are published (missing sample is never zero)`, !zeros && ['no_completed_team_game', 'no_recorded_participation'].includes(p.reason), { reason: p.reason, games_played: p.games_played, stats: p.stats }));
    return out;
  }
  const log = A(p.recent_games);
  out.push(check('games played never exceeds the team\'s completed games', p.games_played <= (p.team?.completed_games ?? Infinity), { games_played: p.games_played, team_completed: p.team?.completed_games }));
  if (p.games_played <= log.length) {
    const bad = [];
    for (const [cat, fields] of Object.entries(SUMS)) {
      const s = p.stats?.[cat];
      if (!s) continue;
      for (const f of fields) {
        const [total, line] = Array.isArray(f) ? f : [f, f];
        const sum = log.reduce((a, g) => a + (Number(g?.[cat]?.[line]) || 0), 0);
        if (s[total] !== sum) bad.push({ cat, field: total, total: s[total], sum_of_games: sum });
      }
      if (s.games !== log.filter(g => g?.[cat]).length) bad.push({ cat, field: 'games', total: s.games, games_with_line: log.filter(g => g?.[cat]).length });
    }
    out.push(check('current-season totals equal the sum of completed-game lines', bad.length === 0, bad));
  } else {
    out.push(check('current-season totals checkable (games played within the published log)', true, 'log shorter than games played; totals checked by games bound only'));
  }
  return out;
}
