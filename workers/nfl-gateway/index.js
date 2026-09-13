// ═══════════════════════════════════════════════
// nfl-gateway — API Gateway for NFL Platform
// Routes: /api/season /api/standings /api/current-stats /api/changes /api/best-line /api/replay/*
//         /api/scores /api/stats /api/picks
//         /api/odds /api/injuries /api/schedule
//         /api/news /api/historical
// Deploy: D:\Workers\nfl-data-harvest\workers\nfl-gateway (wrangler deploy)
//
// PAID DATA LOCK. The browser no longer calls this gateway: nfl.propbetedge.ai
// reads it through its same-origin /api/gw route, which verifies the NFL
// session and a current NFL entitlement first, then forwards with the
// server-only token. With REQUIRE_GATEWAY_TOKEN = "true" every route except
// /api/health requires x-pbe-gateway-token == NFL_GATEWAY_TOKEN:
//   token missing / wrong      -> 401, no data
//   enforcement on, secret unset -> 503, no data (fail closed)
// Rollout order is in docs/NFL_PAYWALL_ROLLOUT.md; enabling this before the
// Vercel route and the Worker callers carry the token takes production down.
// ═══════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': 'https://nfl.propbetedge.ai',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export const GATEWAY_TOKEN_HEADER = 'x-pbe-gateway-token';

function sameSecret(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** null = allowed; otherwise the refusal to send. Exported for tests. */
export function gatewayAccess(req, env) {
  if (String(env?.REQUIRE_GATEWAY_TOKEN || '').toLowerCase() !== 'true') return null;
  const expected = String(env?.NFL_GATEWAY_TOKEN || '');
  if (!expected) return { status: 503, body: { error: 'gateway_access_not_configured' } };
  const presented = req.headers.get(GATEWAY_TOKEN_HEADER) || '';
  if (!sameSecret(presented, expected)) return { status: 401, body: { error: 'gateway_token_required' } };
  return null;
}

// In dev/staging allow localhost
const DEV_CORS = {
  ...CORS,
  'Access-Control-Allow-Origin': '*',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = env.ENV === 'production' ? CORS : DEV_CORS;

    // Handle preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // Health check
    if (path === '/api/health') {
      return json({ status: 'ok', workers: 9, ts: Date.now(), token_required: String(env.REQUIRE_GATEWAY_TOKEN || '').toLowerCase() === 'true' }, cors);
    }

    const refusal = gatewayAccess(req, env);
    if (refusal) return json(refusal.body, { ...cors, 'Cache-Control': 'no-store' }, refusal.status);

    /* The token authorizes this hop only; upstream Workers never see it. */
    if (req.headers.has(GATEWAY_TOKEN_HEADER)) {
      const headers = new Headers(req.headers);
      headers.delete(GATEWAY_TOKEN_HEADER);
      req = new Request(req, { headers });
    }

    try {
      // Route to correct service binding
      // Scores and stats now go through the current-season authority. nfl-scores
      // served a hardcoded array (every score null, every status "scheduled") and
      // nfl-stats answered ?season=2026 with 2025 finals. nfl-current knows which
      // season is current; it serves that one from observed results and hands
      // past seasons to the archive worker itself.
      if (path.startsWith('/api/scores'))     return await env.NFL_CURRENT.fetch(req);
      if (path.startsWith('/api/stats'))      return await env.NFL_CURRENT.fetch(req);
      if (path.startsWith('/api/picks'))      return await env.NFL_PICKS.fetch(req);
      if (path.startsWith('/api/odds'))       return await env.NFL_ODDS.fetch(req);
      if (path.startsWith('/api/schedule'))   return await env.NFL_SCHEDULE.fetch(req);
      if (path.startsWith('/api/news'))       return await env.NFL_NEWS.fetch(req);
      if (path.startsWith('/api/historical')) return await env.NFL_HISTORICAL.fetch(req);

      // Current-season authority. /api/season is the one contract the product
      // reads for "what season, week and game state is it"; standings and
      // current-season stats are derived from it on a schedule, never from
      // page traffic and never from another season's numbers.
      if (path.startsWith('/api/season'))         return await env.NFL_CURRENT.fetch(req);
      if (path.startsWith('/api/standings'))      return await env.NFL_CURRENT.fetch(req);
      if (path.startsWith('/api/current-stats'))  return await env.NFL_CURRENT.fetch(req);
      if (path.startsWith('/api/current-player')) return await env.NFL_CURRENT.fetch(req);
      if (path.startsWith('/api/current/'))       return await env.NFL_CURRENT.fetch(req);

      // Product intelligence. Injuries, What Changed and Best Line all read
      // nfl-intel's persisted scheduled snapshots; page traffic never fans out
      // to the source. PBE Replay remains owned by nfl-replay.
      if (path.startsWith('/api/injuries'))      return await env.NFL_INTEL.fetch(req);
      if (path.startsWith('/api/changes'))       return await env.NFL_INTEL.fetch(req);
      if (path.startsWith('/api/best-line'))     return await env.NFL_INTEL.fetch(req);
      if (path.startsWith('/api/replay/'))       return await env.NFL_REPLAY.fetch(req);

      return json({ error: 'Unknown route', path }, cors, 404);
    } catch (err) {
      return json({ error: 'Worker error', message: err.message, path }, cors, 500);
    }
  }
};

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}
