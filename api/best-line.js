/* GET /api/best-line
 *   ?days=8            upcoming window (1..21)
 *   ?event=<odds id>   one game
 *
 * Price shopping for NFL game markets (spread / total / moneyline) across
 * every book in the PropBetEdge market snapshot. Standalone value: a user who
 * ignores the model entirely still learns where the best number is.
 *
 * Source: the nfl-odds KV snapshot through the NFL gateway. That snapshot is
 * ingested on a schedule (3x/day ET); reading it never spends provider
 * credits, and this endpoint never calls the provider. Every response carries
 * the snapshot's captured_at and the latest ingest status so the page can say
 * how old the prices are — they are never labelled live.
 *
 * Player props are NOT reshaped here: the gateway's /api/odds/board already
 * returns best_price_same_line per player market, and the page reads it
 * directly for the event the user opens.
 */
import { summarizeEvent, bookLeaderboard } from './_bestline/core.js';

const NFL_GATEWAY = process.env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai';

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 3}` : 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  const now = Date.now();
  const rawDays = Number(req?.query?.days);
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(21, Math.round(rawDays))) : 8;
  const only = typeof req?.query?.event === 'string' ? req.query.event.trim() : '';
  let snap;
  try {
    const r = await fetch(`${NFL_GATEWAY}/api/odds`, { headers: { accept: 'application/json' }, cache: 'no-store' });
    const text = await r.text();
    if (!r.ok) return send(res, r.status === 503 ? 503 : 502, { ok: false, semantics: 'UNAVAILABLE', error: `odds_snapshot_${r.status}`, detail: text.slice(0, 160) });
    snap = JSON.parse(text);
  } catch (error) {
    return send(res, 502, { ok: false, semantics: 'UNAVAILABLE', error: 'odds_snapshot_unreachable', detail: String(error?.message || error) });
  }
  const horizon = now + days * 86400000;
  const events = (Array.isArray(snap?.events) ? snap.events : [])
    .filter(e => (only ? String(e.id) === only : true))
    .filter(e => { const k = Date.parse(e?.commence_time || ''); return Number.isFinite(k) && k <= horizon && k > now - 5 * 3600000; })
    .map(e => summarizeEvent(e, { now }))
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const open = events.filter(e => !e.started);
  send(res, 200, {
    ok: true,
    semantics: snap?.semantics || 'LAST_VERIFIED_MARKET',
    price_semantics: 'SCHEDULED_SNAPSHOT_NOT_LIVE',
    captured_at: snap?.captured_at || null,
    captured_at_et: snap?.captured_at_et || null,
    age_seconds: Number.isFinite(Number(snap?.age_seconds)) ? Number(snap.age_seconds) : null,
    ingest: snap?.ingest || null,
    source: { provider: snap?.source?.provider || 'the_odds_api', authority: 'nfl-odds scheduled ingest', read_path: 'kv-snapshot', region: snap?.source?.region || 'us' },
    window_days: days,
    definitions: {
      best: 'Most favourable number, then best price at it, from one named sportsbook.',
      consensus: 'Median line across books; vig-free probability averaged over books quoting both sides at that line.',
      fair: 'PropBetEdge model fair value. Not published on this surface; never approximated from consensus.',
      edge: 'Model fair value versus the best price. Exists only where a fair value is published.'
    },
    events,
    book_leaderboard: bookLeaderboard(open),
    generated_at: new Date(now).toISOString()
  }, 60);
}
