// ═══════════════════════════════════════════════
// nfl-gateway — API Gateway for NFL Platform
// Routes: /api/season /api/standings /api/current-stats /api/changes /api/best-line /api/replay/*
//         /api/scores /api/stats /api/picks
//         /api/odds /api/injuries /api/schedule
//         /api/news /api/historical
// Deploy: C:\Workers\nfl-gateway\
// ═══════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': 'https://nfl.propbetedge.ai',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

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
      return json({ status: 'ok', workers: 9, ts: Date.now() }, cors);
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
