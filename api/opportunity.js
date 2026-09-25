/* Opportunity data (pbe-opportunity/v1) for the browser, same origin.
 *
 *   GET /api/opportunity?season=2026&view=radar[&team=KC]
 *   GET /api/opportunity?season=2026&view=script&team=KC
 *
 * A pass-through to nfl-replay's /api/replay/opportunity, which owns the data
 * (Cloudflare: ingest, rollup, read). This file decides nothing: it validates
 * the query, forwards it, and lets the CDN hold the answer for five minutes.
 * NFL_OPPORTUNITY_ORIGIN points a preview deployment at the isolated preview
 * Worker; production reads the public gateway. A season is never inferred
 * here — the client asks for the season the season contract names.
 */
const DEFAULT_ORIGIN = 'https://nfl-api.propbetedge.ai';
const TIMEOUT_MS = 8000;

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cache || 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function upstreamUrl(query, origin = process.env.NFL_OPPORTUNITY_ORIGIN || DEFAULT_ORIGIN) {
  const season = String(query.season || '');
  const view = String(query.view || 'radar');
  const team = query.team ? String(query.team) : '';
  if (!/^20\d\d$/.test(season)) return { error: 'season required (YYYY)' };
  if (!['radar', 'script'].includes(view)) return { error: 'view must be radar or script' };
  if (team && !/^[A-Za-z]{2,3}$/.test(team)) return { error: 'team must be a 2-3 letter abbreviation' };
  if (view === 'script' && !team) return { error: 'team required for the script view' };
  const u = new URL('/api/replay/opportunity', origin);
  u.searchParams.set('season', season);
  u.searchParams.set('view', view);
  if (team) u.searchParams.set('team', team.toUpperCase());
  return { url: u.toString() };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('allow', 'GET'); return send(res, 405, { error: 'method_not_allowed' }); }
  const target = upstreamUrl(req.query || {});
  if (target.error) return send(res, 400, { contract: 'pbe-opportunity/v1', state: 'BAD_REQUEST', error: target.error });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(target.url, { headers: { accept: 'application/json', 'user-agent': 'pbe-nfl-web/opportunity' }, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) return send(res, 503, { contract: 'pbe-opportunity/v1', state: 'UNAVAILABLE', upstream_status: r.status });
    return send(res, 200, text, 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  } catch (error) {
    return send(res, 503, { contract: 'pbe-opportunity/v1', state: 'UNAVAILABLE', error: error?.name === 'AbortError' ? 'timeout' : 'upstream_unreachable' });
  } finally {
    clearTimeout(timer);
  }
}
