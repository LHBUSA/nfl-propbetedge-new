/* GET /api/nfl-changes
 *   ?window_hours=48   how far back a source timestamp counts as "recent" (6..168)
 *
 * WHAT CHANGED — the NFL assumptions a bet rests on, and only the ones a
 * source actually published. One response, three independent sources, each
 * reported with its own availability so one failing never blanks the others:
 *
 *   injuries    ESPN league injury report (site.api — reachable from Vercel,
 *               403 from Cloudflare Worker egress; see nfl-current notes)
 *   scoreboard  ESPN current-week scoreboard: game identity + disruptions
 *   market      PropBetEdge market tape (nfl_odds_snapshots), service-role
 *               read; absent on preview deployments, which carry no key —
 *               reported as UNAVAILABLE with the reason, never as "no moves"
 *
 * Classification lives in ./_changes/core.js. This file only fetches.
 *
 * Caching: the report is content with its own timestamps, so a short shared
 * cache is honest (s-maxage 120). Every item carries the SOURCE time, and the
 * envelope carries fetched_at, so a cached copy can never pass for a newer one.
 */
import {
  parseScoreboard, teamGameIndex, gameStatusChanges, parseInjuryReport,
  recentInjuryChanges, availabilityByGame, marketMoves, rankChanges, MARKET_THRESHOLDS
} from './_changes/core.js';
import { nflverseCode, nflverseGameId } from '../workers/nfl-picks-engine-shared/current-slate.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const TAPE_LOOKBACK_DAYS = 8;

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

async function espn(path) {
  /* ESPN answers a plain accept header and refuses some browser UAs; this is
     the same request shape api/nfl-live.js has used in production. */
  const r = await fetch(`${SITE}${path}`, { headers: { accept: 'application/json,text/plain,*/*' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`espn_${r.status}`);
  return r.json();
}

async function tape() {
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) return { available: false, reason: 'market_tape_not_configured_on_this_deployment', rows: [] };
  const base = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const since = new Date(Date.now() - TAPE_LOOKBACK_DAYS * 86400000).toISOString();
  const q = `nfl_odds_snapshots?select=game_id,market,side,team,over_under,is_home,line,price,book,captured_at`
    + `&captured_at=gte.${encodeURIComponent(since)}&is_closing=eq.false&order=captured_at.asc&limit=5000`;
  const headers = { apikey: key, accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/rest/v1/${q}`, { headers, cache: 'no-store' });
  if (!r.ok) return { available: false, reason: `market_tape_${r.status}`, rows: [] };
  const rows = await r.json();
  return { available: true, reason: null, rows: Array.isArray(rows) ? rows : [] };
}

export default async function handler(req, res) {
  const now = Date.now();
  const fetchedAt = new Date(now).toISOString();
  const raw = Number(req?.query?.window_hours);
  const windowHours = Number.isFinite(raw) ? Math.max(6, Math.min(168, Math.round(raw))) : 48;

  const [injRes, sbRes, tapeRes] = await Promise.allSettled([
    espn('/injuries'),
    espn('/scoreboard?limit=100'),
    tape()
  ]);

  const sources = {};
  let games = [];
  if (sbRes.status === 'fulfilled') {
    games = parseScoreboard(sbRes.value);
    sources.scoreboard = { provider: 'espn_site_scoreboard', available: true, fetched_at: fetchedAt, games: games.length };
  } else {
    sources.scoreboard = { provider: 'espn_site_scoreboard', available: false, fetched_at: fetchedAt, error: String(sbRes.reason?.message || sbRes.reason) };
  }
  const teamGames = teamGameIndex(games);

  let injuryRows = [];
  if (injRes.status === 'fulfilled') {
    injuryRows = parseInjuryReport(injRes.value);
    sources.injuries = {
      provider: 'espn_injury_report', available: true, fetched_at: fetchedAt,
      source_timestamp: injRes.value?.timestamp || null, entries: injuryRows.length,
      note: 'Designation and the time ESPN last updated its note. Prior designations are not part of this report.'
    };
  } else {
    sources.injuries = { provider: 'espn_injury_report', available: false, fetched_at: fetchedAt, error: String(injRes.reason?.message || injRes.reason) };
  }

  let moves = [];
  if (tapeRes.status === 'fulfilled' && tapeRes.value.available) {
    const byTape = new Map();
    for (const g of games) {
      const id = nflverseGameId({ season: g.season, seasonType: g.season_type, week: g.week, away: nflverseCode(g.away.abbreviation), home: nflverseCode(g.home.abbreviation) });
      if (id) byTape.set(id, g);
    }
    moves = marketMoves(tapeRes.value.rows, byTape);
    const stamps = [...new Set(tapeRes.value.rows.map(r => r.captured_at))].sort();
    sources.market = {
      provider: 'pbe_market_tape', available: true, fetched_at: fetchedAt,
      batches: stamps.length, first_captured_at: stamps[0] || null, latest_captured_at: stamps.at(-1) || null,
      semantics: 'CROSS_BOOK_CONSENSUS_PER_SCHEDULED_INGEST', thresholds: MARKET_THRESHOLDS
    };
  } else {
    const reason = tapeRes.status === 'fulfilled' ? tapeRes.value.reason : String(tapeRes.reason?.message || tapeRes.reason);
    sources.market = { provider: 'pbe_market_tape', available: false, fetched_at: fetchedAt, reason };
  }

  const changes = rankChanges([
    ...gameStatusChanges(games, fetchedAt),
    ...recentInjuryChanges(injuryRows, teamGames, { now, windowHours }),
    ...moves
  ]);

  const counts = changes.reduce((acc, c) => { acc[c.kind] = (acc[c.kind] || 0) + 1; return acc; }, { total: changes.length });
  const anySource = sources.injuries.available || sources.scoreboard.available || sources.market.available;
  send(res, anySource ? 200 : 502, {
    ok: anySource,
    semantics: 'SOURCED_CHANGES',
    generated_at: fetchedAt,
    window_hours: windowHours,
    transitions: {
      available: false,
      reason: 'change_ledger_not_deployed',
      note: 'Status transitions (e.g. QUESTIONABLE to OUT) need a durable ledger of prior observations. Items here are current designations with their source update time.'
    },
    sources,
    games: games.map(g => ({ id: g.id, matchup: g.matchup, kickoff: g.kickoff, semantics: g.semantics, detail: g.detail, week: g.week, away: g.away, home: g.home })),
    counts,
    changes,
    availability: availabilityByGame(injuryRows, games)
  }, anySource ? 120 : 0);
}
