/* nfl-current — the current-season authority for PropBetEdge NFL.
 *
 * One deterministic contract for "what season, week and game state is it",
 * plus the two surfaces that have to follow from it: live standings and
 * current-season statistics. Everything here is derived from an authoritative
 * provider on a schedule; nothing is hardcoded, and nothing an LLM produced.
 *
 *   GET /api/season                       season/week/state contract
 *   GET /api/standings?season=2026        division standings, live
 *   GET /api/current-stats?season=2026    current-season leaders, accumulated
 *   GET /api/current/health
 *
 * Two rules the whole file is built around:
 *
 *   FAIL CLOSED. If a season's real data cannot be sourced, the payload says
 *   available:false and why. It never falls back to another season's numbers
 *   under this season's heading — that is how 2025 finals ended up being
 *   served as 2026 leaders in the worker this replaces.
 *
 *   FINAL MEANS FINAL. A game contributes to standings and statistics only
 *   when the provider says the game is over. Nothing is inferred from a clock.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

/* ESPN's site.api answers Vercel but 403s Cloudflare Worker egress under every
   header combination tried (verified: bare, browser UA, referer). Our own
   Vercel function already has working access and already normalises the
   payloads, so it is the provider adapter and this worker keeps what actually
   belongs to it: the schedule, the KV cache, the derivation and the contract. */
const PBE = 'https://nfl.propbetedge.ai/api/nfl-live';

/* How old a cached payload may be before we stop calling it fresh. Live games
   move fast; an empty Tuesday does not. */
const SLA_LIVE_S = 120;
const SLA_IDLE_S = 900;

const KEY = {
  season: s => `current:season:${s}`,
  standings: s => `current:standings:${s}`,
  stats: s => `current:stats:${s}`,
  tick: 'current:lasttick'
};

const A = v => (Array.isArray(v) ? v : []);
const S = v => (v == null ? '' : String(v));
/* Number(null) is 0 and 0 is finite, so a bare Number() check quietly turns a
   missing season into season 0 — and 0 is falsy, which then skipped standings
   and stats entirely. Absent stays absent. */
const N = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, ...extra } });
}

async function pbe(qs) {
  const r = await fetch(`${PBE}?${qs}`, { headers: { accept: 'application/json' }, cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`adapter_${r.status}`);
  const body = await r.json();
  if (body && body.ok === false) throw new Error(`adapter_${body.error || 'unavailable'}`);
  return body;
}

/* ---- season type -------------------------------------------------------
   ESPN encodes 1 preseason, 2 regular, 3 postseason. We publish the word,
   because "REG" is what the rest of the product reasons about. */
const TYPE_NAME = { 1: 'PRE', 2: 'REG', 3: 'POST', 4: 'OFF' };

function ymd(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}${g('month')}${g('day')}`;
}

/* A window wide enough to hold the previous week's finals and the next
   week's kickoffs, so "latest final" and "next game" are both answerable
   from a single upstream call. */
function rangeAround(days = 10) {
  const now = Date.now();
  return `${ymd(new Date(now - days * 864e5))}-${ymd(new Date(now + days * 864e5))}`;
}

/* Our adapter already normalises a game; this only reshapes it into the
   contract's vocabulary. */
function readGame(g) {
  const st = g?.status || {};
  const side = t => ({
    id: S(t?.id), abbreviation: S(t?.abbreviation), display_name: S(t?.display_name),
    score: N(t?.score), winner: t?.winner === true
  });
  return {
    id: S(g?.id),
    name: S(g?.short_name || g?.name),
    kickoff: S(g?.date),
    week: N(g?.week),
    season: N(g?.season?.year),
    season_type: TYPE_NAME[N(g?.season?.type)] || null,
    semantics: S(st?.semantics || 'UNAVAILABLE').toUpperCase(),
    detail: S(st?.detail || st?.short_detail),
    away: side(g?.teams?.away),
    home: side(g?.teams?.home)
  };
}

/* ---- season contract ---------------------------------------------------- */
async function buildSeason() {
  const board = await pbe(`range=${rangeAround()}`);
  const games = A(board?.games).map(readGame).filter(g => g.id);
  const now = Date.now();

  /* Season identity comes from the provider's own labelling of the games it
     is serving, not from a calendar guess. */
  const cur = games.find(g => g.semantics === 'LIVE') || games.find(g => g.semantics === 'SCHEDULE') || games[games.length - 1] || null;
  const season = N(board?.season) ?? cur?.season ?? null;
  const seasonType = TYPE_NAME[N(board?.season_type)] || cur?.season_type || null;
  const week = N(board?.week) ?? cur?.week ?? null;

  const finals = games.filter(g => g.semantics === 'FINAL').sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const live = games.filter(g => g.semantics === 'LIVE');
  const upcoming = games.filter(g => g.semantics === 'SCHEDULE' && Date.parse(g.kickoff) >= now - 6 * 36e5)
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));

  const latestFinal = finals.length ? finals[finals.length - 1] : null;
  /* The event the product should default to: whatever is happening now, else
     whatever happens next. A finished game is never the default. */
  const nextGame = live[0] || upcoming[0] || null;

  return {
    ok: true,
    season,
    season_type: seasonType,
    season_started: !!(season && seasonType === 'REG' && (finals.length > 0 || live.length > 0 || week >= 1)),
    current_week: week,
    completed_games_in_window: finals.length,
    live_games: live.length,
    upcoming_games: upcoming.length,
    latest_final: latestFinal,
    next_game: nextGame,
    default_event_hint: nextGame ? { id: nextGame.id, name: nextGame.name, kickoff: nextGame.kickoff, semantics: nextGame.semantics } : null,
    window: rangeAround(),
    last_updated: new Date().toISOString(),
    source: { provider: 'espn_site_scoreboard', via: 'nfl.propbetedge.ai/api/nfl-live?range', transport: 'poll' }
  };
}

/* ---- standings ---------------------------------------------------------- */
async function buildStandings(season) {
  const wrapper = await pbe(`standings=${season}`);
  const raw = wrapper?.standings;
  const divisions = [];

  const walk = (node, conference) => {
    const name = S(node?.name || node?.displayName);
    const conf = /American Football Conference/i.test(name) ? 'AFC' : /National Football Conference/i.test(name) ? 'NFC' : conference;
    const entries = A(node?.standings?.entries);
    if (entries.length && /AFC|NFC/.test(name)) {
      divisions.push({
        conference: conf,
        division: name,
        teams: entries.map(e => {
          const st = Object.fromEntries(A(e?.stats).map(s => [s.name, s]));
          const num = k => N(st[k]?.value);
          return {
            id: S(e?.team?.id),
            abbreviation: S(e?.team?.abbreviation),
            display_name: S(e?.team?.displayName),
            logo: S(A(e?.team?.logos)[0]?.href || ''),
            wins: num('wins') ?? 0,
            losses: num('losses') ?? 0,
            ties: num('ties') ?? 0,
            record: S(st.overall?.displayValue || `${num('wins') ?? 0}-${num('losses') ?? 0}`),
            win_pct: num('winPercent'),
            points_for: num('pointsFor'),
            points_against: num('pointsAgainst'),
            differential: num('differential'),
            games_played: (num('wins') ?? 0) + (num('losses') ?? 0) + (num('ties') ?? 0)
          };
        }).sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.differential - a.differential || a.display_name.localeCompare(b.display_name))
      });
    }
    A(node?.children).forEach(ch => walk(ch, conf));
  };
  walk(raw, null);

  if (!divisions.length) throw new Error('standings_empty');

  const played = divisions.reduce((a, d) => a + d.teams.reduce((x, t) => x + t.games_played, 0), 0);
  return {
    ok: true,
    available: true,
    season: Number(season),
    season_type: 'REG',
    divisions,
    team_count: divisions.reduce((a, d) => a + d.teams.length, 0),
    /* Two team-games per completed game, so this is the league-wide count of
       finished regular-season games the standings actually rest on. */
    completed_games: Math.round(played / 2),
    last_updated: new Date().toISOString(),
    source: { provider: 'espn_site_standings', via: 'nfl.propbetedge.ai/api/nfl-live?standings', level: 'division', derived_from: 'completed regular-season results' }
  };
}

/* ---- current-season statistics -----------------------------------------
   Accumulated from the box score of every game the provider has called
   final, one game at a time, so the cost of a refresh is proportional to
   what is newly finished rather than to the size of the season. */
const STAT_GROUPS = {
  passing: { label: 'Passing', sort: 'yards', fields: { 'C/ATT': 'comp_att', YDS: 'yards', TD: 'tds', INT: 'ints' } },
  rushing: { label: 'Rushing', sort: 'yards', fields: { CAR: 'carries', YDS: 'yards', TD: 'tds' } },
  receiving: { label: 'Receiving', sort: 'yards', fields: { REC: 'rec', YDS: 'yards', TD: 'tds', TGTS: 'targets' } }
};

function addStats(acc, gameId, summary) {
  /* Our adapter hands back player_stats already grouped by team and category,
     with the provider's own column labels preserved, so nothing here has to
     guess at a stat line's meaning. */
  for (const tb of A(summary?.player_stats)) {
    const team = S(tb?.team?.abbreviation);
    for (const grp of A(tb?.groups)) {
      const key = S(grp?.name).toLowerCase();
      const spec = STAT_GROUPS[key];
      if (!spec) continue;
      const labels = A(grp?.labels).map(S);
      for (const row of A(grp?.athletes)) {
        if (row?.did_not_play) continue;
        const ath = row?.athlete || {};
        const id = S(ath?.id);
        if (!id) continue;
        const bucket = (acc[key] ||= {});
        const rec = (bucket[id] ||= { id, player: S(ath.name), team, headshot: S(ath?.headshot || ''), position: S(ath?.position || ''), games: 0, yards: 0, tds: 0, ints: 0, carries: 0, rec: 0, targets: 0, completions: 0, attempts: 0 });
        rec.team = team;
        if (!rec.player) rec.player = S(ath.name);
        rec.games += 1;
        const vals = A(row?.stats).map(S);
        labels.forEach((lab, i) => {
          const field = spec.fields[lab];
          if (!field) return;
          const raw = vals[i];
          if (field === 'comp_att') {
            const m = /^(\d+)\s*\/\s*(\d+)$/.exec(S(raw).trim());
            if (m) { rec.completions += Number(m[1]); rec.attempts += Number(m[2]); }
            return;
          }
          const n = Number(S(raw).replace(/[^0-9.-]/g, ''));
          if (Number.isFinite(n)) rec[field] = (rec[field] || 0) + n;
        });
      }
    }
  }
  acc.__processed = Array.from(new Set([...(acc.__processed || []), gameId]));
}

async function buildStats(env, season, prior) {
  const board = await pbe(`range=${rangeAround(120)}`);
  const games = A(board?.games).map(readGame).filter(g => g.id && g.season === Number(season) && g.season_type === 'REG');
  const finals = games.filter(g => g.semantics === 'FINAL');

  const acc = prior && prior.__season === Number(season) ? prior : { __season: Number(season), __processed: [] };
  const done = new Set(acc.__processed || []);
  const pending = finals.filter(g => !done.has(g.id));

  /* Bound the work a single invocation will do so a cold start after a full
     Sunday cannot time out; the next tick picks up the remainder. */
  for (const g of pending.slice(0, 12)) {
    try {
      const summary = await pbe(`event=${encodeURIComponent(g.id)}`);
      addStats(acc, g.id, summary);
    } catch (_) { /* leave it unprocessed; a later tick retries it */ }
  }
  acc.__updated = new Date().toISOString();
  return { acc, finalsCount: finals.length, processed: (acc.__processed || []).length, pendingCount: Math.max(0, finals.length - (acc.__processed || []).length) };
}

function statsPayload(acc, season, meta) {
  const categories = {};
  for (const [key, spec] of Object.entries(STAT_GROUPS)) {
    const rows = Object.values(acc?.[key] || {})
      .filter(r => Number(r[spec.sort]) > 0 || Number(r.games) > 0)
      .sort((a, b) => (b[spec.sort] || 0) - (a[spec.sort] || 0))
      .slice(0, 25)
      .map((r, i) => ({ rank: i + 1, ...r }));
    categories[key] = { label: spec.label, leaders: rows };
  }
  const total = Object.values(categories).reduce((a, c) => a + c.leaders.length, 0);
  return {
    ok: true,
    available: total > 0,
    unavailable_reason: total > 0 ? null : 'no completed regular-season games have produced published box scores yet',
    season: Number(season),
    season_type: 'REG',
    completed_games: meta.finalsCount,
    games_processed: meta.processed,
    games_pending: meta.pendingCount,
    categories,
    last_updated: acc?.__updated || new Date().toISOString(),
    source: { provider: 'espn_site_summary', via: 'nfl.propbetedge.ai/api/nfl-live?event', derived_from: 'published box scores of completed regular-season games' }
  };
}

/* ---- freshness ---------------------------------------------------------- */
function withFreshness(payload, liveNow) {
  const t = Date.parse(payload?.last_updated || '');
  const age = Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
  const sla = liveNow ? SLA_LIVE_S : SLA_IDLE_S;
  return {
    ...payload,
    freshness: {
      age_seconds: age,
      sla_seconds: sla,
      state: age == null ? 'UNKNOWN' : age <= sla ? 'FRESH' : 'STALE',
      /* The product must not put a LIVE label on data older than its SLA. */
      live_labeling_permitted: age != null && age <= sla
    }
  };
}

/* ---- refresh ------------------------------------------------------------ */
async function refreshAll(env, reason) {
  const out = { reason, at: new Date().toISOString(), ok: {}, errors: {} };
  let season = null, liveNow = false;

  try {
    const s = await buildSeason();
    season = s.season; liveNow = s.live_games > 0;
    await env.NFL_KV.put(KEY.season(s.season || 'current'), JSON.stringify(s), { expirationTtl: 86400 });
    await env.NFL_KV.put(KEY.season('current'), JSON.stringify(s), { expirationTtl: 86400 });
    out.ok.season = { season: s.season, week: s.current_week, live: s.live_games, finals: s.completed_games_in_window };
  } catch (e) { out.errors.season = String(e?.message || e); }

  if (season) {
    try {
      const st = await buildStandings(season);
      await env.NFL_KV.put(KEY.standings(season), JSON.stringify(st), { expirationTtl: 86400 });
      out.ok.standings = { divisions: st.divisions.length, completed_games: st.completed_games };
    } catch (e) { out.errors.standings = String(e?.message || e); }

    try {
      const prior = await env.NFL_KV.get(KEY.stats(season), { type: 'json' });
      const { acc, ...meta } = await buildStats(env, season, prior);
      await env.NFL_KV.put(KEY.stats(season), JSON.stringify(acc), { expirationTtl: 60 * 86400 });
      out.ok.stats = meta;
    } catch (e) { out.errors.stats = String(e?.message || e); }
  }

  await env.NFL_KV.put(KEY.tick, JSON.stringify({ at: out.at, reason, liveNow }), { expirationTtl: 86400 });
  return out;
}

/* Game-day cadence without game-day spend. The cron fires often; this decides
   whether there is anything worth spending an upstream call on. */
async function shouldRefresh(env) {
  const tick = await env.NFL_KV.get(KEY.tick, { type: 'json' });
  const season = await env.NFL_KV.get(KEY.season('current'), { type: 'json' });
  const last = Date.parse(tick?.at || '') || 0;
  const age = (Date.now() - last) / 1000;

  if (!season) return { go: true, reason: 'cold_start' };
  if (season.live_games > 0) return { go: age >= 60, reason: 'live_games' };

  const next = Date.parse(season?.next_game?.kickoff || '');
  if (Number.isFinite(next)) {
    const until = (next - Date.now()) / 1000;
    if (until > -4 * 3600 && until < 45 * 60) return { go: age >= 120, reason: 'kickoff_window' };
  }
  return { go: age >= 900, reason: 'idle' };
}

export default {
  async scheduled(event, env, ctx) {
    const decision = await shouldRefresh(env);
    if (!decision.go) return;
    ctx.waitUntil(refreshAll(env, decision.reason));
  },

  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    const p = url.searchParams;
    const force = p.get('force') === '1';

    try {
      if (path.endsWith('/current/health') || path.endsWith('/current/refresh')) {
        const tick = await env.NFL_KV.get(KEY.tick, { type: 'json' });
        if (path.endsWith('/refresh') && force) return json({ status: 'ok', refreshed: await refreshAll(env, 'manual') });
        return json({ status: 'ok', service: 'nfl-current', last_tick: tick, routes: ['/api/season', '/api/standings', '/api/current-stats'], generated_at: new Date().toISOString() });
      }

      if (path.endsWith('/current/diag')) {
        const tries = [
          ['bare', `${SITE}/scoreboard?limit=100`, {}],
          ['browser-ua', `${SITE}/scoreboard?limit=100`, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', accept: 'application/json' }],
          ['referer', `${SITE}/scoreboard?limit=100`, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', accept: 'application/json', referer: 'https://www.espn.com/' }],
          ['cdn', 'https://cdn.espn.com/core/nfl/scoreboard?xhr=1&limit=100', { accept: 'application/json' }],
          ['core', 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/types/2/weeks/1/events?limit=5', { accept: 'application/json' }],
          ['vercel', 'https://nfl.propbetedge.ai/api/nfl-live', { accept: 'application/json' }]
        ];
        const out = [];
        for (const [name, u, h] of tries) {
          try { const r = await fetch(u, { headers: h }); out.push({ name, status: r.status, len: (await r.text()).length }); }
          catch (e) { out.push({ name, error: String(e?.message || e) }); }
        }
        return json({ diag: out });
      }
      const cached = k => env.NFL_KV.get(k, { type: 'json' });

      if (path.startsWith('/api/season')) {
        let s = force ? null : await cached(KEY.season('current'));
        if (!s) { s = await buildSeason(); await env.NFL_KV.put(KEY.season('current'), JSON.stringify(s), { expirationTtl: 86400 }); }
        return json(withFreshness(s, s.live_games > 0));
      }

      if (path.startsWith('/api/standings')) {
        const season = Number(p.get('season')) || (await cached(KEY.season('current')))?.season;
        if (!season) return json({ ok: false, available: false, error: 'season_unresolved', unavailable_reason: 'current season could not be determined' }, 503);
        let st = force ? null : await cached(KEY.standings(season));
        if (!st) {
          try { st = await buildStandings(season); await env.NFL_KV.put(KEY.standings(season), JSON.stringify(st), { expirationTtl: 86400 }); }
          catch (e) {
            /* Fail closed: no standings rather than another season's standings. */
            return json({ ok: false, available: false, season, error: 'standings_unavailable', unavailable_reason: String(e?.message || e), last_updated: new Date().toISOString() }, 503);
          }
        }
        const sc = await cached(KEY.season('current'));
        return json(withFreshness(st, (sc?.live_games || 0) > 0));
      }

      if (path.startsWith('/api/current-stats')) {
        const season = Number(p.get('season')) || (await cached(KEY.season('current')))?.season;
        if (!season) return json({ ok: false, available: false, error: 'season_unresolved' }, 503);
        let acc = await cached(KEY.stats(season));
        let meta;
        if (!acc || force) {
          try { const built = await buildStats(env, season, acc); acc = built.acc; meta = built; await env.NFL_KV.put(KEY.stats(season), JSON.stringify(acc), { expirationTtl: 60 * 86400 }); }
          catch (e) {
            return json({ ok: false, available: false, season, error: 'current_stats_unavailable', unavailable_reason: String(e?.message || e), last_updated: new Date().toISOString() }, 503);
          }
        } else {
          const sc = await cached(KEY.season('current'));
          meta = { finalsCount: sc?.completed_games_in_window ?? (acc.__processed || []).length, processed: (acc.__processed || []).length, pendingCount: 0 };
        }
        const sc = await cached(KEY.season('current'));
        return json(withFreshness(statsPayload(acc, season, meta), (sc?.live_games || 0) > 0));
      }

      return json({ error: 'Unknown route', path }, 404);
    } catch (err) {
      return json({ ok: false, error: 'worker_error', message: String(err?.message || err), path }, 500);
    }
  }
};
