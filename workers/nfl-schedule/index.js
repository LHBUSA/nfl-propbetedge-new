/* nfl-schedule — canonical 2026 NFL schedule + broadcast authority.
 *
 * Reached in production only through nfl-gateway's NFL_SCHEDULE service
 * binding (/api/schedule*). The routes, filters and game fields below are the
 * ones the deployed Worker (version 1a88cfca, captured byte-for-byte in the
 * previous commit) served; everything added is additive:
 *
 *   every game      + espn_event_id, + broadcast (normalized object)
 *   every response  + broadcast_source (authority, snapshot freshness)
 *   /api/schedule/broadcast/health    internal diagnostics (joins, lanes, counts)
 *   /api/schedule/broadcast/registry  the verified broadcaster registry
 *
 * The fetch path never contacts a source. It reads one KV snapshot that only
 * the cron trigger (refresh.js) writes. If that snapshot is missing or
 * unreadable the schedule still answers and every broadcast is UNAVAILABLE.
 */
import { SCHEDULE } from './schedule-2026.js';
import { SNAPSHOT_KEY, buildBroadcast, unavailableBroadcast, joinSummary } from './broadcast-core.js';
import { BROADCASTERS, REGISTRY_VERSION, allowedHostsById } from './broadcasters.js';
import { scheduledRefresh, planRefresh } from './refresh.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const SOURCE = {
  provider: 'nflverse',
  dataset: 'schedules/games.csv',
  season: 2026,
  semantics: 'SCHEDULE'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function todayET(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function resolveCurrentWeek(games, today) {
  const upcoming = games.filter(g => g.gameday >= today);
  if (!upcoming.length) return 18;
  return Math.min(...upcoming.map(g => Number(g.week)));
}

/* One KV read per isolate per 30s. The value is the cron's snapshot, so a
   short in-memory hold cannot make it meaningfully older. */
const SNAPSHOT_MEMO_MS = 30000;
let memo = { at: 0, value: undefined, error: null };
export function resetSnapshotMemo() { memo = { at: 0, value: undefined, error: null }; }
async function readSnapshot(env, now) {
  if (memo.value !== undefined && now - memo.at < SNAPSHOT_MEMO_MS) return memo;
  try {
    if (!env?.NFL_KV) throw new Error('kv_binding_missing');
    const value = await env.NFL_KV.get(SNAPSHOT_KEY, { type: 'json' });
    memo = { at: now, value: value || null, error: value ? null : 'broadcast_snapshot_not_yet_written' };
  } catch (e) {
    memo = { at: now, value: null, error: `broadcast_snapshot_unreadable:${String(e?.message || e).slice(0, 80)}` };
  }
  return memo;
}

function sourceMeta(snap, error) {
  if (!snap) return { authority: 'nfl-schedule', status: 'UNAVAILABLE', reason: error, registry_version: REGISTRY_VERSION };
  const lanes = snap.lanes || {};
  return {
    authority: 'nfl-schedule',
    status: 'OK',
    providers: ['espn_cdn_scoreboard', 'espn_site_scoreboard_via_relay'],
    snapshot_updated_at: snap.updated_at || null,
    last_full_sweep_at: lanes.sweep?.completed_at || null,
    last_near_refresh_at: lanes.near?.last_success_at || null,
    last_gameday_refresh_at: lanes.gameday?.last_success_at || null,
    registry_version: REGISTRY_VERSION
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    const p = url.searchParams;
    const now = Date.now();

    if (path.endsWith('/schedule/broadcast/registry')) {
      return json({ registry_version: REGISTRY_VERSION, broadcasters: BROADCASTERS, allowed_hosts: allowedHostsById() });
    }

    if (path.endsWith('/schedule/broadcast/health')) {
      const { value: snap, error } = await readSnapshot(env, now);
      return json({
        service: 'nfl-schedule',
        broadcast_source: sourceMeta(snap, error),
        lanes: snap?.lanes || null,
        last_tick: snap?.last_tick || null,
        next_plan: planRefresh(snap, SCHEDULE, now),
        joins: joinSummary(SCHEDULE, snap, now),
        observed_events: snap ? Object.keys(snap.events || {}).length : 0,
        generated_at: new Date(now).toISOString()
      });
    }

    if (path.endsWith('/health')) {
      return json({ status: 'ok', service: 'nfl-schedule', games: SCHEDULE.length, season: 2026, source: SOURCE, generated_at: new Date(now).toISOString() });
    }

    if (!path.includes('schedule')) return json({ error: 'Unknown route', path }, 404);

    const requestedSeason = Number(p.get('season') || 2026);
    if (requestedSeason !== 2026) {
      return json({ error: 'Season unavailable', requested_season: requestedSeason, available_seasons: [2026] }, 404);
    }

    const today = todayET(new Date(now));
    const week = p.get('week');
    const date = p.get('date');
    const team = (p.get('team') || '').toUpperCase();
    const type = (p.get('type') || '').toLowerCase();
    let games = [...SCHEDULE];
    if (week === 'current') {
      const resolvedWeek = resolveCurrentWeek(games, today);
      games = games.filter(g => Number(g.week) === resolvedWeek);
    }
    if (week && week !== 'current') {
      const requestedWeek = Number(week);
      games = games.filter(g => Number(g.week) === requestedWeek);
    }
    if (date) games = games.filter(g => g.gameday === date);
    if (type === 'today') games = games.filter(g => g.gameday === today);
    if (type === 'upcoming') games = games.filter(g => g.gameday >= today).slice(0, 32);
    if (team) games = games.filter(g => g.home_team === team || g.away_team === team);

    const { value: snap, error } = await readSnapshot(env, now);
    const enriched = games.map(g => {
      let broadcast;
      try { broadcast = snap ? buildBroadcast(g, snap, now) : unavailableBroadcast(error || 'broadcast_snapshot_unavailable'); }
      catch (e) { broadcast = unavailableBroadcast(`broadcast_build_failed:${String(e?.message || e).slice(0, 60)}`); }
      return { ...g, broadcast };
    });

    return json({
      season: 2026,
      count: enriched.length,
      games: enriched,
      source: SOURCE,
      broadcast_source: sourceMeta(snap, error),
      as_of: today,
      generated_at: new Date(now).toISOString()
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduledRefresh(env, SCHEDULE, controller?.scheduledTime || Date.now()).then(out => {
      console.log(JSON.stringify({ lane: 'broadcast_refresh', ran: out.ran, error: out.error || null, requests: out.requests || 0, weeks: out.plan?.weeks || [], joins: out.snapshot?.last_joins?.counts || null }));
    }).catch(e => console.error(JSON.stringify({ lane: 'broadcast_refresh', error: String(e?.message || e) }))));
  }
};
