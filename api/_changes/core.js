/* What Changed — pure classification core.
 *
 * Every change this module emits traces to a field a source published:
 *
 *   INJURY_STATUS  ESPN league injury report: status + ESPN's own `date`
 *   GAME_STATUS    ESPN scoreboard status.type.name (delay / postponement)
 *   MARKET_MOVE    the PropBetEdge market tape (nfl_odds_snapshots): the
 *                  cross-book consensus the odds snapshot pipeline persisted
 *                  per scheduled ingest, compared batch to batch
 *
 * What it deliberately does NOT do:
 *   - It does not claim a status TRANSITION ("Questionable -> Out"). ESPN's
 *     report carries the current designation and the time its note was last
 *     updated, not the previous designation. A transition needs a durable
 *     ledger of earlier observations (see workers/nfl-changes). Until that is
 *     deployed the surface says "updated", never "changed from".
 *   - It does not infer workload, snap counts or depth from a note's prose.
 *   - It never invents a game for a player: a team without a game on the
 *     current scoreboard is reported with game=null.
 *
 * No I/O here — api/nfl-changes.js fetches, this file decides.
 */

export const PROP_POSITIONS = new Set(['QB', 'RB', 'FB', 'WR', 'TE', 'K']);

/* ESPN report status -> product vocabulary. Anything unrecognised is kept
   verbatim rather than squeezed into a bucket it may not belong to. */
const STATUS = {
  'out': 'OUT',
  'doubtful': 'DOUBTFUL',
  'questionable': 'QUESTIONABLE',
  'probable': 'PROBABLE',
  'active': 'ACTIVE',
  'injured reserve': 'INJURED_RESERVE',
  'suspension': 'SUSPENDED',
  'suspended': 'SUSPENDED',
  'physically unable to perform': 'PUP',
  'non football injury': 'NFI',
  'day-to-day': 'DAY_TO_DAY'
};
export function normalizeStatus(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  return STATUS[key] || key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/* Designations that restrict whether a player plays. ACTIVE is a real
   designation but it restricts nothing, so it is never ranked above LOW. */
export const RESTRICTIVE = new Set(['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'SUSPENDED', 'INJURED_RESERVE', 'PUP', 'NFI']);

export function injurySeverity(status, position) {
  const pos = String(position || '').toUpperCase();
  const prop = PROP_POSITIONS.has(pos);
  const qb = pos === 'QB';
  switch (status) {
    case 'OUT': case 'SUSPENDED':
      return prop ? 'HIGH' : 'MEDIUM';
    case 'DOUBTFUL':
      return qb || prop ? 'HIGH' : 'MEDIUM';
    case 'INJURED_RESERVE': case 'PUP': case 'NFI':
      return prop ? 'MEDIUM' : 'LOW';
    case 'QUESTIONABLE':
      return qb ? 'HIGH' : prop ? 'MEDIUM' : 'LOW';
    default:
      return 'LOW';
  }
}
const SEV_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const clean = v => {
  const s = String(v ?? '').trim();
  return s && !/^(null|undefined|n\/a)$/i.test(s) ? s : null;
};
const iso = v => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/* ---- scoreboard ------------------------------------------------------- */

/* ESPN status names that are themselves a change a bettor must know about.
   A normal SCHEDULED/IN_PROGRESS/FINAL is the lifecycle, not a change. */
export const DISRUPTED = {
  STATUS_DELAYED: 'DELAYED',
  STATUS_RAIN_DELAY: 'DELAYED',
  STATUS_WEATHER_DELAY: 'DELAYED',
  STATUS_POSTPONED: 'POSTPONED',
  STATUS_SUSPENDED: 'SUSPENDED',
  STATUS_CANCELED: 'CANCELED',
  STATUS_CANCELLED: 'CANCELED',
  STATUS_FORFEIT: 'FORFEIT'
};

function semanticsOf(type) {
  const state = String(type?.state || '').toLowerCase();
  const name = String(type?.name || '');
  if (DISRUPTED[name]) return DISRUPTED[name] === 'DELAYED' && state === 'in' ? 'LIVE' : 'SCHEDULE';
  if (state === 'in') return 'LIVE';
  if (state === 'post') return 'FINAL';
  return 'SCHEDULE';
}

export function parseScoreboard(payload) {
  const games = [];
  for (const ev of Array.isArray(payload?.events) ? payload.events : []) {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
    if (!comp) continue;
    const teams = {};
    for (const c of Array.isArray(comp.competitors) ? comp.competitors : []) {
      const side = c?.homeAway === 'home' ? 'home' : c?.homeAway === 'away' ? 'away' : null;
      if (!side) continue;
      teams[side] = {
        id: clean(c?.team?.id),
        abbreviation: clean(c?.team?.abbreviation),
        name: clean(c?.team?.displayName),
        logo: clean(c?.team?.logo),
        score: c?.score === undefined || c?.score === null || c?.score === '' ? null : Number(c.score)
      };
    }
    if (!teams.away?.abbreviation || !teams.home?.abbreviation) continue;
    const type = comp?.status?.type || ev?.status?.type || {};
    games.push({
      id: String(ev.id),
      matchup: `${teams.away.abbreviation} @ ${teams.home.abbreviation}`,
      kickoff: iso(ev.date || comp.date),
      season: Number(ev?.season?.year) || null,
      season_type: Number(ev?.season?.type) === 3 ? 'POST' : Number(ev?.season?.type) === 1 ? 'PRE' : 'REG',
      week: Number(ev?.week?.number) || null,
      status_name: clean(type.name),
      detail: clean(type.shortDetail) || clean(type.detail),
      semantics: semanticsOf(type),
      disrupted: DISRUPTED[String(type.name || '')] || null,
      away: teams.away,
      home: teams.home
    });
  }
  return games;
}

/* team abbreviation -> that team's game on the scoreboard. When a team has
   more than one (a week-spanning window), prefer the one not yet final. */
export function teamGameIndex(games) {
  const map = new Map();
  const rank = g => (g.semantics === 'LIVE' ? 0 : g.semantics === 'SCHEDULE' ? 1 : 2);
  for (const g of games) {
    for (const abbr of [g.away.abbreviation, g.home.abbreviation]) {
      const cur = map.get(abbr);
      if (!cur || rank(g) < rank(cur)) map.set(abbr, g);
    }
  }
  return map;
}

export function gameRef(g) {
  if (!g) return null;
  return { id: g.id, matchup: g.matchup, kickoff: g.kickoff, semantics: g.semantics, detail: g.detail };
}

export function gameStatusChanges(games, fetchedAt) {
  return games.filter(g => g.disrupted).map(g => ({
    id: `game:${g.id}:${g.disrupted}`,
    kind: 'GAME_STATUS',
    status: g.disrupted,
    severity: 'HIGH',
    observed_at: fetchedAt,
    observed_basis: 'OBSERVED_BY_PBE',
    source: { provider: 'espn_site_scoreboard', label: 'ESPN scoreboard' },
    headline: `${g.matchup} — ${g.disrupted}`,
    detail: g.detail || null,
    player: null,
    team: null,
    game: gameRef(g)
  }));
}

/* ---- injuries --------------------------------------------------------- */

function athleteOf(entry, teamFallback) {
  const a = entry?.athlete || {};
  const pos = clean(a?.position?.abbreviation);
  const idFromLink = (() => {
    const href = (Array.isArray(a?.links) ? a.links : []).map(l => l?.href || '').find(h => /\/id\/\d+/.test(h)) || '';
    const m = /\/id\/(\d+)/.exec(href);
    return m ? m[1] : null;
  })();
  const headshotId = (() => {
    const m = /\/players\/full\/(\d+)\./.exec(String(a?.headshot?.href || ''));
    return m ? m[1] : null;
  })();
  const team = a?.team || {};
  return {
    player: {
      espn_id: clean(a?.id) || idFromLink || headshotId,
      name: clean(a?.displayName) || [clean(a?.firstName), clean(a?.lastName)].filter(Boolean).join(' ') || null,
      short_name: clean(a?.shortName),
      position: pos,
      headshot: clean(a?.headshot?.href),
      prop_relevant: PROP_POSITIONS.has(String(pos || '').toUpperCase())
    },
    team: {
      id: clean(team?.id) || clean(teamFallback?.id),
      abbreviation: clean(team?.abbreviation) || null,
      name: clean(team?.displayName) || clean(teamFallback?.displayName)
    }
  };
}

/* Flatten ESPN's league report into one row per current designation. */
export function parseInjuryReport(payload) {
  const out = [];
  for (const block of Array.isArray(payload?.injuries) ? payload.injuries : []) {
    for (const entry of Array.isArray(block?.injuries) ? block.injuries : []) {
      const status = normalizeStatus(entry?.status || entry?.type?.description);
      if (!status) continue;
      const { player, team } = athleteOf(entry, block);
      if (!player.name || !team.abbreviation) continue;
      const d = entry?.details || {};
      out.push({
        report_id: clean(entry?.id),
        status,
        status_label: clean(entry?.status),
        updated_at: iso(entry?.date),
        note: clean(entry?.shortComment),
        injury: {
          type: clean(d?.type),
          location: clean(d?.location),
          detail: clean(d?.detail),
          side: clean(d?.side) === 'Not Specified' ? null : clean(d?.side),
          return_date: clean(d?.returnDate)
        },
        player,
        team
      });
    }
  }
  return out;
}

export function injuryChange(row, game) {
  const pos = row.player.position ? `${row.player.position}, ` : '';
  /* A designation attached to a game that is already over described that
     game. It stays visible as history but it is no longer actionable, so it
     never outranks a designation for a game still to be played. */
  const actionable = !game || game.semantics !== 'FINAL';
  return {
    id: `inj:${row.report_id || `${row.player.espn_id || row.player.name}:${row.team.abbreviation}`}:${row.status}`,
    kind: 'INJURY_STATUS',
    status: row.status,
    severity: actionable ? injurySeverity(row.status, row.player.position) : 'LOW',
    actionable,
    observed_at: row.updated_at,
    observed_basis: 'SOURCE_TIMESTAMP',
    source: { provider: 'espn_injury_report', label: 'ESPN injury report' },
    headline: `${row.player.name} (${pos}${row.team.abbreviation}) — ${row.status.replace(/_/g, ' ')}`,
    /* ESPN's own note, carried verbatim and attributed. It is the source's
       sentence, not ours, and the UI says so. */
    detail: row.note,
    injury: row.injury,
    player: row.player,
    team: row.team,
    game: gameRef(game)
  };
}

/* Recent designations: the report rows whose source timestamp is inside the
   window. ACTIVE rows are included (a designation), but restrictive
   designations are what the ranking puts first. */
export function recentInjuryChanges(rows, teamGames, { now = Date.now(), windowHours = 48 } = {}) {
  const floor = now - windowHours * 3600000;
  return rows
    .filter(r => {
      const t = Date.parse(r.updated_at || '');
      if (!Number.isFinite(t) || t < floor || t > now + 5 * 60000) return false;
      /* ACTIVE restricts nothing. It is worth a line only for a position that
         carries player markets; for everyone else it is roster noise (ESPN
         re-dates an ACTIVE note after every game recap). */
      return r.status !== 'ACTIVE' || r.player.prop_relevant;
    })
    .map(r => injuryChange(r, teamGames.get(r.team.abbreviation) || null));
}

/* Current availability for games that have not finished: every restrictive
   designation except long-term lists, grouped by game. */
export function availabilityByGame(rows, games) {
  const open = new Map(games.filter(g => g.semantics !== 'FINAL').map(g => [g.id, g]));
  const index = teamGameIndex([...open.values()]);
  const out = {};
  for (const r of rows) {
    if (!['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'SUSPENDED'].includes(r.status)) continue;
    const g = index.get(r.team.abbreviation);
    if (!g) continue;
    (out[g.id] ||= []).push({
      status: r.status,
      severity: injurySeverity(r.status, r.player.position),
      updated_at: r.updated_at,
      player: r.player,
      team: r.team,
      injury: r.injury
    });
  }
  for (const id of Object.keys(out)) out[id].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || String(a.player.name).localeCompare(String(b.player.name)));
  return out;
}

/* ---- market tape ------------------------------------------------------ */

/* Materiality thresholds — the only place they live. */
export const MARKET_THRESHOLDS = Object.freeze({
  spread_points: 1.0,
  total_points: 1.5,
  moneyline_prob_pp: 4.0,
  key_numbers: [3, 7, 10]
});

export function impliedProb(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a < 0 ? -a / (-a + 100) : 100 / (a + 100);
}

function crossedKey(from, to, keys) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null;
  const lo = Math.min(Math.abs(from), Math.abs(to));
  const hi = Math.max(Math.abs(from), Math.abs(to));
  /* A key number is crossed when it lies strictly inside the move, or when
     the line lands on / leaves it — 2.5 -> 3 and 3 -> 3.5 both matter. */
  return keys.find(k => lo < k && k < hi) ?? keys.find(k => (lo === k || hi === k) && lo !== hi) ?? null;
}

/* Tape rows -> per game/market/selection time series of consensus quotes. */
export function tapeSeries(rows) {
  const series = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const identity = r.market === 'total' ? r.over_under : r.team;
    if (!r.game_id || !r.market || !identity || !r.captured_at) continue;
    const key = `${r.game_id}|${r.market}|${identity}`;
    if (!series.has(key)) series.set(key, { game_id: r.game_id, market: r.market, identity, is_home: r.is_home ?? null, points: [] });
    const books = /^consensus:(\d+)$/.exec(String(r.book || ''));
    series.get(key).points.push({
      captured_at: iso(r.captured_at),
      line: r.line === null || r.line === undefined ? null : Number(r.line),
      price: Number(r.price),
      books: books ? Number(books[1]) : 1
    });
  }
  for (const s of series.values()) {
    s.points.sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
    /* one point per batch: the tape persists a batch exactly once, but guard anyway */
    s.points = s.points.filter((p, i, xs) => i === 0 || p.captured_at !== xs[i - 1].captured_at);
  }
  return [...series.values()];
}

function describeMove(s, from, to, T) {
  if (s.market === 'moneyline') {
    const a = impliedProb(from.price), b = impliedProb(to.price);
    if (a === null || b === null) return null;
    const pp = (b - a) * 100;
    if (Math.abs(pp) < T.moneyline_prob_pp) return null;
    return { delta: Number(pp.toFixed(1)), unit: 'pp', material: true, key_number: null };
  }
  if (!Number.isFinite(from.line) || !Number.isFinite(to.line)) return null;
  const delta = Number((to.line - from.line).toFixed(1));
  if (delta === 0) return null;
  const threshold = s.market === 'spread' ? T.spread_points : T.total_points;
  const key = s.market === 'spread' ? crossedKey(from.line, to.line, T.key_numbers) : null;
  if (Math.abs(delta) < threshold && key === null) return null;
  return { delta, unit: 'pts', material: true, key_number: key };
}

/* Material moves, judged two ways: since the previous tape batch (what just
   happened) and since the first tape observation in the window (the drift).
   A spread or moneyline is reported once, from the home side, because its two
   sides are the same fact; a total once, from the over. */
export function marketMoves(rows, gameByTapeId, T = MARKET_THRESHOLDS) {
  const out = [];
  for (const s of tapeSeries(rows)) {
    if (s.points.length < 2) continue;
    if ((s.market === 'spread' || s.market === 'moneyline') && s.is_home === false) continue;
    if (s.market === 'total' && s.identity !== 'OVER') continue;
    const first = s.points[0], prev = s.points.at(-2), last = s.points.at(-1);
    const recent = describeMove(s, prev, last, T);
    const drift = s.points.length > 2 ? describeMove(s, first, last, T) : null;
    const move = recent || drift;
    if (!move) continue;
    const basis = recent ? prev : first;
    const game = gameByTapeId.get(s.game_id) || null;
    const label = s.market === 'spread' ? `${s.identity} spread` : s.market === 'total' ? 'Total' : `${s.identity} moneyline`;
    const fmt = p => s.market === 'moneyline' ? `${p.price > 0 ? '+' : ''}${p.price}` : `${s.market === 'spread' && p.line > 0 ? '+' : ''}${p.line}`;
    out.push({
      id: `mkt:${s.game_id}:${s.market}:${s.identity}:${last.captured_at}`,
      kind: 'MARKET_MOVE',
      status: move.key_number !== null ? 'KEY_NUMBER' : 'MOVED',
      severity: move.key_number !== null || Math.abs(move.delta) >= (s.market === 'moneyline' ? 8 : s.market === 'spread' ? 2 : 3) ? 'HIGH' : 'MEDIUM',
      observed_at: last.captured_at,
      observed_basis: 'SOURCE_TIMESTAMP',
      source: { provider: 'pbe_market_tape', label: 'PropBetEdge market tape · cross-book consensus' },
      headline: `${game ? game.matchup : s.game_id} — ${label} ${fmt(basis)} → ${fmt(last)}`,
      detail: move.key_number !== null ? `Crossed the key number ${move.key_number}.` : null,
      market: {
        market: s.market,
        selection: s.identity,
        from: { line: basis.line, price: basis.price, captured_at: basis.captured_at, books: basis.books },
        to: { line: last.line, price: last.price, captured_at: last.captured_at, books: last.books },
        delta: move.delta,
        unit: move.unit,
        key_number: move.key_number,
        basis: recent ? 'PREVIOUS_BATCH' : 'FIRST_OBSERVATION',
        observations: s.points.length
      },
      player: null,
      team: s.market === 'total' ? null : { abbreviation: s.identity },
      game: gameRef(game)
    });
  }
  return out;
}

export function rankChanges(changes) {
  return [...changes].sort((a, b) =>
    SEV_RANK[a.severity] - SEV_RANK[b.severity]
    || (Date.parse(b.observed_at || 0) || 0) - (Date.parse(a.observed_at || 0) || 0));
}
