/* GET /api/player-career?espn_id=3139477
 *
 * One position-aware Career Ledger for QB / RB / WR / TE: factual game history,
 * not the analytical DNA sample. Contract: player-career/v1 (see
 * api/_career/ledger-core.js for the composition rules).
 *
 *   history         data/dist/career-ledger.json (harvested ESPN game logs through
 *                   the last completed season, coverage proven per season)
 *   current season  ESPN athlete game log for the season the nfl-current contract
 *                   names, read here so a provider stat correction propagates
 *   live            the player's game today: its currently published box score
 *
 * Identity is the ESPN athlete id only. An id the ledger does not track is a
 * 404, never a name search. Label is CAREER only when debut -> today is proven;
 * otherwise TRACKED HISTORY with the missing seasons named.
 *
 * Revision 1.1 (additive): history_state / display_label add
 * ROOKIE · NO PRIOR NFL HISTORY for a player with no NFL season before the current
 * one, under strict fail-closed criteria (ledger-core.js evaluateRookie). `label`
 * keeps its v1 values; CAREER and TRACKED HISTORY semantics are unchanged.
 *
 * Freshness: a live response is no-store and carries box_score_fetched_at; the
 * client counts its age up every second locally and re-reads on the existing
 * live cadence, never on a one-second loop.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeCareer, parseGamelog, boxScoreLine, eventState, isRookieCandidate, parseRookieEvidence } from './_career/ledger-core.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ATHLETE = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes';
const GATEWAY = process.env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai';

let LEDGER = null;
function ledger() {
  if (LEDGER) return LEDGER;
  LEDGER = JSON.parse(readFileSync(join(process.cwd(), 'data', 'dist', 'career-ledger.json'), 'utf8'));
  return LEDGER;
}

/* Small per-instance memo so concurrent viewers of one live game share reads. */
const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  if (hit?.pending) return hit.pending;
  const pending = fn().then(value => { memo.set(key, { at: Date.now(), value }); return value; })
    .catch(e => { memo.delete(key); throw e; });
  memo.set(key, { at: 0, pending });
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  return pending;
}

async function getJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal, cache: 'no-store' });
    const text = await r.text();
    if (!r.ok) throw new Error(`upstream_${r.status}`);
    try { return JSON.parse(text); } catch { throw new Error('upstream_non_json'); }
  } finally { clearTimeout(t); }
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 ? cache : 'no-store');
  res.end(JSON.stringify(body));
}

/* The player's team game on the current board, if it is live or has finished
   and the game log has not caught up. Joined on team abbreviation, then the
   athlete id must be in that game's box score. */
async function todaysGame(team) {
  if (!team) return null;
  const board = await cached('board', 10000, () => getJson(`${SITE}/scoreboard?limit=100`));
  for (const ev of Array.isArray(board?.events) ? board.events : []) {
    const comp = ev?.competitions?.[0];
    const abbrs = (comp?.competitors || []).map(c => c?.team?.abbreviation);
    if (!abbrs.includes(team)) continue;
    const state = String(comp?.status?.type?.state || ev?.status?.type?.state || '').toLowerCase();
    return { id: String(ev.id), state, kickoff: ev.date };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader('access-control-allow-origin', '*'); return res.end(); }
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method_not_allowed' });
  const espnId = String(req.query?.espn_id || '').trim();
  if (!/^\d{1,12}$/.test(espnId)) return send(res, 400, { ok: false, error: 'espn_id_required', detail: 'identity is the ESPN athlete id; names are never accepted' });

  let data;
  try { data = ledger(); } catch (e) { return send(res, 503, { ok: false, error: 'career_ledger_unavailable', detail: String(e?.message || e) }); }
  const player = data.players?.[espnId];
  if (!player) {
    return send(res, 404, { ok: false, error: 'not_tracked', espn_id: espnId,
      unavailable_reason: 'this ESPN athlete id is not in the Career Ledger (QB/RB/WR/TE Player DNA players only); nothing is matched by name' }, 'public, s-maxage=300');
  }

  /* Which season is current comes from the season authority, not a calendar. */
  let currentSeason = null, currentRows = [], currentAvailable = false, currentError = null, currentFetchedAt = null;
  try {
    const season = await cached('season', 60000, () => getJson(`${GATEWAY}/api/season`, 5000));
    currentSeason = Number(season?.season) || null;
    if (!currentSeason) throw new Error('season_unresolved');
  } catch (e) { currentError = `current season could not be resolved (${e.message})`; }

  if (currentSeason && currentSeason > Number(data.meta?.history_through_season)) {
    try {
      const body = await cached(`gl:${espnId}:${currentSeason}`, 120000, () => getJson(`${ATHLETE}/${espnId}/gamelog?season=${currentSeason}`));
      currentRows = parseGamelog(body, currentSeason).rows;
      currentAvailable = true;
      currentFetchedAt = new Date(memo.get(`gl:${espnId}:${currentSeason}`)?.at || Date.now()).toISOString();
    } catch (e) { currentError = `${currentSeason} game log unavailable (${e.message})`; }
  } else if (currentSeason) {
    currentAvailable = true; // history already runs through the current season
  }

  /* Live contribution: only the game on today's board, only if the athlete is
     in its published box score, only if the game log does not already hold it. */
  let boxScore = null, boxFetchedAt = null, liveGame = null;
  try {
    const team = (currentRows[currentRows.length - 1] || {}).t || player.current_team;
    liveGame = await todaysGame(team);
    if (liveGame && (liveGame.state === 'in' || liveGame.state === 'post') && !currentRows.some(r => r.e === liveGame.id)) {
      const ttl = liveGame.state === 'in' ? 8000 : 60000;
      const summary = await cached(`sum:${liveGame.id}`, ttl, () => getJson(`${SITE}/summary?event=${liveGame.id}`));
      boxFetchedAt = new Date(memo.get(`sum:${liveGame.id}`)?.at || Date.now()).toISOString();
      const line = boxScoreLine(summary, espnId);
      const event = eventState(summary);
      if (line && event.event_id === liveGame.id) boxScore = { event, line };
    }
  } catch (_) { /* no live contribution rather than a guessed one */ }

  /* ROOKIE evidence (contract 1.1): only for players the ledger holds no history
     for. The provider's own athlete record and stat seasons across every
     category. Any failure leaves evidence null, which fails closed to TRACKED. */
  let rookieEvidence = null;
  if (isRookieCandidate(player)) {
    try {
      const [athlete, stats] = await Promise.all([
        cached(`ath:${espnId}`, 6 * 3600000, () => getJson(`${ATHLETE}/${espnId}`)),
        cached(`stats:${espnId}`, 6 * 3600000, () => getJson(`${ATHLETE}/${espnId}/stats`))
      ]);
      rookieEvidence = parseRookieEvidence(athlete, stats, new Date(memo.get(`stats:${espnId}`)?.at || Date.now()).toISOString());
    } catch (_) { rookieEvidence = null; }
  }

  const body = composeCareer({
    player, currentSeason, currentRows, currentAvailable, currentError,
    boxScore, boxFetchedAt, currentFetchedAt, historyMeta: data.meta, rookieEvidence
  });
  body.today = liveGame ? { event_id: liveGame.id, state: liveGame.state === 'in' ? 'LIVE' : liveGame.state === 'post' ? 'FINAL' : 'SCHEDULE', kickoff: liveGame.kickoff } : null;
  const cache = body.live ? 'no-store'
    : liveGame ? 'public, s-maxage=15, stale-while-revalidate=15'
      : 'public, s-maxage=300, stale-while-revalidate=600';
  return send(res, 200, body, cache);
}
