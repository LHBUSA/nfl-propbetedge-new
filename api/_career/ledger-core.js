/* Career Ledger core — pure composition, no I/O.
 *
 * A player's factual NFL history, composed from three layers keyed by ESPN
 * event id:
 *
 *   history   harvested ESPN game log through the last completed season
 *             (data/dist/career-ledger.json, coverage-proven per season)
 *   current   ESPN's own game log for the current season, read at request time,
 *             so a provider stat correction propagates on the next read
 *   box score the currently published box score of the player's game today:
 *             LIVE -> a provisional row; FINAL but not yet in the game log ->
 *             a final row until the game log carries it
 *
 * THE RULE THAT MATTERS: one event id contributes exactly once. Precedence is
 * current game log > history > final box score > live box score. When a live
 * game goes final, its provisional row is replaced by the final box score, and
 * that by the game-log row when the provider publishes it — the career total
 * moves only by genuine stat differences between those publications, never by
 * counting the game twice.
 *
 * Totals are sums of rows. A field is null (unknown) unless every row in the
 * set publishes it: a partial sum would read as a real total.
 */

export const CONTRACT = 'player-career/v1';

export const STAT_KEYS = ['cmp', 'att', 'pyd', 'ptd', 'int', 'sck', 'car', 'ryd', 'rtd', 'rec', 'tgt', 'recyd', 'rectd', 'fum', 'fuml'];

/* What each position leads with. Everything published is still in the rows. */
export const POSITION_FIELDS = {
  QB: ['games', 'starts', 'cmp', 'att', 'pyd', 'ptd', 'int', 'cmp_pct', 'ypa', 'car', 'ryd', 'rtd'],
  RB: ['games', 'starts', 'car', 'ryd', 'rtd', 'rec', 'tgt', 'recyd', 'rectd'],
  WR: ['games', 'starts', 'rec', 'tgt', 'recyd', 'rectd', 'car', 'ryd', 'rtd'],
  TE: ['games', 'starts', 'rec', 'tgt', 'recyd', 'rectd', 'car', 'ryd', 'rtd']
};
/* The provider's game logs do not publish games started. Unknown, never 0. */
export const UNSUPPORTED = ['starts'];

const A = v => (Array.isArray(v) ? v : []);
const num = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/* ---- ESPN athlete game log (one season) -> rows ------------------------- */
const GAMELOG_FIELD = {
  completions: 'cmp', passingAttempts: 'att', passingYards: 'pyd', passingTouchdowns: 'ptd', interceptions: 'int',
  sacks: 'sck', rushingAttempts: 'car', rushingYards: 'ryd', rushingTouchdowns: 'rtd', receptions: 'rec',
  receivingTargets: 'tgt', receivingYards: 'recyd', receivingTouchdowns: 'rectd', fumbles: 'fum', fumblesLost: 'fuml'
};

export function parseGamelog(body, season) {
  if (!body) return { rows: [], excluded: [] };
  const names = A(body.names);
  const events = body.events || {};
  const rows = [], excluded = [], seen = new Set();
  for (const stype of A(body.seasonTypes)) {
    const d = String(stype?.displayName || '');
    const kind = /postseason/i.test(d) ? 'POST' : /regular/i.test(d) ? 'REG' : null;
    for (const cat of A(stype?.categories)) {
      for (const ev of A(cat?.events)) {
        const e = String(ev?.eventId || '');
        if (!e || seen.has(e)) continue;
        seen.add(e);
        const meta = events[e] || {};
        const opp = meta?.opponent?.abbreviation || '';
        if (!kind) { excluded.push({ event_id: e, reason: `unrecognised season type ${d}` }); continue; }
        if (opp === 'AFC' || opp === 'NFC' || /pro\s*bowl/i.test(meta?.eventNote || '')) { excluded.push({ event_id: e, reason: 'pro_bowl' }); continue; }
        const x = {};
        names.forEach((n, i) => { if (GAMELOG_FIELD[n]) x[GAMELOG_FIELD[n]] = num(A(ev?.stats)[i]); });
        const teamId = String(meta?.team?.id || '');
        const home = teamId ? String(meta?.homeTeamId || '') === teamId : meta?.atVs === 'vs';
        const hs = num(meta?.homeTeamScore), as = num(meta?.awayTeamScore);
        const ts = home ? hs : as, os = home ? as : hs;
        rows.push({
          e, d: meta?.gameDate || null, s: Number(season), st: kind, w: meta?.week ?? null,
          t: meta?.team?.abbreviation || null, o: opp || null, h: home ? 1 : 0,
          r: meta?.gameResult && ts != null && os != null ? `${meta.gameResult} ${ts}-${os}` : null,
          x
        });
      }
    }
  }
  rows.sort((a, b) => String(a.d).localeCompare(String(b.d)));
  return { rows, excluded };
}

/* ---- ESPN event summary box score -> one player's line ------------------- */
function splitPair(v) {
  const m = /^\s*(-?\d+)\s*[\/-]\s*(-?\d+)\s*$/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}
const BOX = {
  passing: (lab, v, x) => {
    if (lab === 'C/ATT') { const [c, a] = splitPair(v); x.cmp = c; x.att = a; }
    else if (lab === 'YDS') x.pyd = num(v);
    else if (lab === 'TD') x.ptd = num(v);
    else if (lab === 'INT') x.int = num(v);
    else if (lab === 'SACKS') x.sck = splitPair(v)[0];
  },
  rushing: (lab, v, x) => { if (lab === 'CAR') x.car = num(v); else if (lab === 'YDS') x.ryd = num(v); else if (lab === 'TD') x.rtd = num(v); },
  receiving: (lab, v, x) => { if (lab === 'REC') x.rec = num(v); else if (lab === 'TGTS') x.tgt = num(v); else if (lab === 'YDS') x.recyd = num(v); else if (lab === 'TD') x.rectd = num(v); },
  fumbles: (lab, v, x) => { if (lab === 'FUM') x.fum = num(v); else if (lab === 'LOST') x.fuml = num(v); }
};

/* Returns null when the athlete is not in the published box score. The box
   score only lists a stat group for a player who recorded one, so within a
   listed game a missing group is a true zero for that group's counting stats. */
export function boxScoreLine(summary, espnId) {
  const id = String(espnId);
  let found = false, team = null;
  const x = {};
  for (const tb of A(summary?.boxscore?.players)) {
    for (const grp of A(tb?.statistics)) {
      const apply = BOX[String(grp?.name || '').toLowerCase()];
      const labels = A(grp?.labels);
      for (const row of A(grp?.athletes)) {
        if (String(row?.athlete?.id || '') !== id) continue;
        found = true; team = tb?.team?.abbreviation || team;
        if (apply) labels.forEach((lab, i) => apply(lab, A(row?.stats)[i], x));
      }
    }
  }
  if (!found) return null;
  for (const k of ['cmp', 'att', 'pyd', 'ptd', 'int', 'car', 'ryd', 'rtd', 'rec', 'tgt', 'recyd', 'rectd']) if (!(k in x)) x[k] = 0;
  return { team, x };
}

export function eventState(summary) {
  const comp = A(summary?.header?.competitions)[0] || {};
  const st = comp?.status || {};
  const state = String(st?.type?.state || '').toLowerCase();
  const semantics = state === 'in' ? 'LIVE' : state === 'post' || st?.type?.completed ? 'FINAL' : state === 'pre' ? 'SCHEDULE' : 'UNAVAILABLE';
  const period = num(st?.period);
  const clock = st?.displayClock || null;
  const season = summary?.header?.season || {};
  const sides = A(comp?.competitors);
  const home = sides.find(c => c?.homeAway === 'home'), away = sides.find(c => c?.homeAway === 'away');
  return {
    event_id: String(summary?.header?.id || comp?.id || ''),
    semantics,
    period, clock,
    /* The truthful game-state stamp the provider exposes: quarter and clock. */
    clock_text: semantics === 'LIVE' ? (period ? `${period > 4 ? 'OT' : `Q${period}`}${clock ? ` · ${clock}` : ''}` : (st?.type?.shortDetail || null)) : (st?.type?.shortDetail || null),
    date: comp?.date || null,
    season: num(season?.year),
    season_type: num(season?.type) === 3 ? 'POST' : num(season?.type) === 2 ? 'REG' : null,
    week: num(summary?.header?.week),
    home: home ? { abbreviation: home?.team?.abbreviation, score: num(home?.score) } : null,
    away: away ? { abbreviation: away?.team?.abbreviation, score: num(away?.score) } : null
  };
}

/* ---- composition ----------------------------------------------------------- */
/* A box-score row publishes exactly the fields the player's game log does, so
   the provisional/final row and the game-log row that later replaces it are
   the same shape: a QB's game log carries no receiving columns, and a box
   score row that did would change which totals are known mid-game. */
function shapeLike(x, template) {
  const keys = template && template.x ? Object.keys(template.x) : null;
  if (!keys || !keys.length) return { ...x };
  const out = {};
  for (const k of keys) out[k] = Object.prototype.hasOwnProperty.call(x, k) && x[k] !== null ? x[k] : 0;
  return out;
}

export function composeRows({ history = [], current = [], boxScore = null }) {
  const byEvent = new Map();
  const put = (row, source, status) => { byEvent.set(String(row.e), { ...row, source, status }); };
  for (const r of A(history)) put(r, 'ledger', 'FINAL');
  for (const r of A(current)) put(r, 'ledger', 'FINAL');
  let live = null;
  if (boxScore?.event?.event_id && boxScore?.line) {
    const ev = boxScore.event;
    const id = String(ev.event_id);
    if (!byEvent.has(id) && (ev.semantics === 'LIVE' || ev.semantics === 'FINAL')) {
      const team = boxScore.line.team;
      const home = ev.home?.abbreviation === team;
      const us = home ? ev.home : ev.away, them = home ? ev.away : ev.home;
      const row = {
        e: id, d: ev.date, s: ev.season, st: ev.season_type, w: ev.week, t: team, o: them?.abbreviation || null, h: home ? 1 : 0,
        r: ev.semantics === 'FINAL' && us?.score != null && them?.score != null ? `${us.score > them.score ? 'W' : us.score < them.score ? 'L' : 'T'} ${us.score}-${them.score}` : null,
        x: shapeLike(boxScore.line.x, [...byEvent.values()].pop())
      };
      put(row, ev.semantics === 'LIVE' ? 'live_box_score' : 'final_box_score', ev.semantics);
      if (ev.semantics === 'LIVE') live = { event_id: id, clock_text: ev.clock_text, score: us && them ? `${team} ${us.score ?? 0}-${them.score ?? 0} ${them.abbreviation}` : null };
    }
  }
  const rows = [...byEvent.values()].sort((a, b) => String(a.d).localeCompare(String(b.d)));
  return { rows, live };
}

function round(n, d) { return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }

export function totals(rows) {
  const list = A(rows);
  const out = { games: list.length, starts: null };
  for (const k of STAT_KEYS) {
    if (!list.length) { out[k] = null; continue; }
    const vals = list.map(r => (r.x && Object.prototype.hasOwnProperty.call(r.x, k) ? r.x[k] : null));
    out[k] = vals.every(v => v !== null && v !== undefined) ? vals.reduce((a, b) => a + b, 0) : null;
  }
  out.cmp_pct = out.cmp != null && out.att ? round(out.cmp * 100 / out.att, 1) : null;
  out.ypa = out.pyd != null && out.att ? round(out.pyd / out.att, 2) : null;
  out.ypc = out.ryd != null && out.car ? round(out.ryd / out.car, 2) : null;
  out.ypr = out.recyd != null && out.rec ? round(out.recyd / out.rec, 2) : null;
  return out;
}

const byType = (rows, st) => A(rows).filter(r => r.st === st);

export function seasonsOf(rows) {
  const map = new Map();
  for (const r of A(rows)) {
    const k = `${r.s}:${r.st}`;
    if (!map.has(k)) map.set(k, { season: r.s, season_type: r.st, rows: [] });
    map.get(k).rows.push(r);
  }
  return [...map.values()]
    .sort((a, b) => b.season - a.season || (a.season_type === 'REG' ? -1 : 1))
    .map(s => {
      const teams = [];
      for (const r of s.rows) if (r.t && teams[teams.length - 1] !== r.t) teams.push(r.t);
      return { season: s.season, season_type: s.season_type, teams, provisional: s.rows.some(r => r.status === 'LIVE'), ...totals(s.rows) };
    });
}

export function gameLogOut(rows) {
  return A(rows).slice().reverse().map(r => ({
    event_id: r.e, date: r.d, season: r.s, season_type: r.st, week: r.w, team: r.t, opponent: r.o,
    home: r.h === 1, result: r.r, status: r.status, source: r.source, stats: r.x
  }));
}

/* The whole response body, given the three layers. */
export function composeCareer({ player, currentSeason, currentRows, currentAvailable, currentError, boxScore, boxFetchedAt, currentFetchedAt, historyMeta, now = Date.now() }) {
  const history = A(player?.games);
  const { rows, live } = composeRows({ history, current: currentAvailable ? currentRows : [], boxScore });
  const verifiedRows = rows.filter(r => r.status !== 'LIVE');
  const cov = player?.coverage || {};
  const coverageComplete = cov.complete === true && currentAvailable === true;
  const seasonsCovered = [...new Set(rows.map(r => r.s))].sort((a, b) => a - b);
  const position = String(player?.position || '').toUpperCase();

  const reg = totals(byType(verifiedRows, 'REG'));
  const post = totals(byType(verifiedRows, 'POST'));
  let liveBlock = null;
  if (live) {
    const liveRow = rows.find(r => r.e === live.event_id);
    const st = liveRow.st === 'POST' ? 'POST' : 'REG';
    liveBlock = {
      state: 'LIVE',
      event_id: live.event_id,
      season_type: st,
      through: live.clock_text,
      score: live.score,
      line: liveRow.x,
      box_score_fetched_at: boxFetchedAt || null,
      /* verified career (through the prior final) + this published box score line */
      totals: { [st === 'POST' ? 'postseason' : 'regular_season']: totals(byType(rows, st)) }
    };
  }
  const first = rows[0], last = rows[rows.length - 1];
  return {
    ok: true,
    contract: CONTRACT,
    label: coverageComplete ? 'CAREER' : 'TRACKED HISTORY',
    player: {
      espn_id: player.espn_id, gsis_id: player.gsis_id || null, name: player.name, position,
      dna_positions: player.dna_positions || [], active: player.active_2026 === true, current_team: player.current_team || (last && last.t) || null,
      teams: (() => { const t = []; for (const r of rows) if (r.t && !t.includes(r.t)) t.push(r.t); return t; })()
    },
    coverage: {
      complete: coverageComplete,
      debut_season: player.debut_season ?? null,
      debut_sources: player.debut_sources || null,
      history_through_season: player.history_through_season ?? historyMeta?.history_through_season ?? null,
      seasons_covered: seasonsCovered,
      missing_seasons: A(cov.gaps).map(g => ({ season: g.season, reason: g.reason })),
      game_count_mismatches: A(cov.mismatches).filter(m => m.blocking),
      provider_reconciliation: {
        status: A(cov.mismatches).filter(m => !m.blocking).length ? 'PROVIDER_SURFACES_DISAGREE' : 'EXACT',
        notes: A(cov.mismatches).filter(m => !m.blocking)
      },
      current_season: { season: currentSeason, available: currentAvailable === true, reason: currentAvailable ? null : (currentError || 'current season game log unavailable') },
      why_not_career: coverageComplete ? null : [
        ...A(cov.gaps).map(g => `${g.season}: ${g.reason}`),
        ...A(cov.mismatches).filter(m => m.blocking).map(m => `${m.season}: ledger has ${m.ledger} regular-season games, provider season row says ${m.provider}`),
        ...(currentAvailable ? [] : [`${currentSeason}: ${currentError || 'current season game log unavailable'}`])
      ]
    },
    stat_fields: POSITION_FIELDS[position] || POSITION_FIELDS.WR,
    unsupported_fields: UNSUPPORTED,
    career_span: first && last ? { from: first.s, to: last.s } : null,
    totals: { regular_season: reg, postseason: post },
    live: liveBlock,
    seasons: seasonsOf(rows),
    game_log: gameLogOut(rows),
    excluded_events: A(player?.excluded_events),
    source: {
      identity: 'ESPN athlete id (GSIS audited against nflverse); never joined on name',
      history: { provider: 'espn_athlete_gamelog', generated_at: historyMeta?.generated_at || null, through_season: historyMeta?.history_through_season || null },
      current_season: { provider: 'espn_athlete_gamelog', season: currentSeason, fetched_at: currentFetchedAt || null },
      live: { provider: 'espn_site_summary_boxscore', fetched_at: boxFetchedAt || null, semantics: 'current through the latest provider-published box score' }
    },
    last_updated: new Date(now).toISOString()
  };
}
