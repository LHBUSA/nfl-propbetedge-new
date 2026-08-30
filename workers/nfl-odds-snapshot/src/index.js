/* nfl-odds-snapshot — captures spread/total/moneyline for upcoming NFL games
 * and marks the closing line once a game kicks off.
 *
 * ODDS SOURCE: a Cloudflare service binding to the EXISTING nfl-odds Worker,
 * not a second copy of ODDS_API_KEY. nfl-odds already serves h2h/spreads/
 * totals for every event on /api/odds and caches the provider response
 * (verified live: cache "hit", usage.last_cost 3, 18,452 credits remaining).
 * Routing through it preserves one provider authority and one quota-control
 * point, and costs zero additional provider credits whenever the cache is
 * warm. This Worker holds no provider credential at all.
 *
 * Side attribution is delegated to the shared normalizer, which resolves team
 * identity and home/away from the event's own home_team/away_team. There is no
 * positional guessing here.
 *
 * Never logs a key.
 */

import { select, insert, patch } from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  normalizeEvent, consensusByside,
} from '../../nfl-picks-engine-shared/odds-normalize.mjs';

const SERVICE = 'nfl-odds-snapshot';
const VERSION = 'v1.1.0';
const LOOKAHEAD_DAYS = 8;

/* Kickoff windows in UTC, matching the brief. Sunday spans midnight, so it is
 * expressed as two ranges. */
const KICKOFF_WINDOWS = [
  { day: 4, from: 22 * 60, to: 24 * 60 },      // Thu 22:00-24:00
  { day: 5, from: 0, to: 1 * 60 + 30 },        // Fri 00:00-01:30 (Thu night)
  { day: 0, from: 16 * 60 + 30, to: 24 * 60 }, // Sun 16:30-24:00
  { day: 1, from: 0, to: 2 * 60 },             // Mon 00:00-02:00 (Sun night)
  { day: 1, from: 22 * 60, to: 24 * 60 },      // Mon 22:00-24:00
  { day: 2, from: 0, to: 1 * 60 + 30 },        // Tue 00:00-01:30 (Mon night)
];

/* Health state. Error CLASS only — never a payload, never a key. */
const health = {
  last_cron_run: null, last_cron: null, last_error_class: null, last_result: null,
  /* Provider budget as last reported upstream. Observable without spending a
   * credit, because it rides along on a response we already made. */
  provider_usage: null, provider_cache: null,
};

export function inKickoffWindow(date) {
  const day = date.getUTCDay();
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return KICKOFF_WINDOWS.some(w => w.day === day && minutes >= w.from && minutes < w.to);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return json({
        service: SERVICE,
        version: VERSION,
        last_cron_run: health.last_cron_run,
        last_cron: health.last_cron,
        last_error_class: health.last_error_class,
        last_result: health.last_result,
        provider_usage: health.provider_usage,
        provider_cache: health.provider_cache,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          NFL_ODDS_BINDING: Boolean(env.NFL_ODDS),
        },
      });
    }
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, event.cron));
  },
};

async function run(env, cron) {
  const startedAt = new Date();
  health.last_cron_run = startedAt.toISOString();
  health.last_cron = cron || null;
  try {
    /* The quarter-hourly trigger only does work inside a kickoff window;
     * outside one it exits immediately so the frequent schedule costs
     * nothing. */
    const frequent = cron === '*/15 * * * *';
    if (frequent && !inKickoffWindow(startedAt)) {
      health.last_result = 'skipped_outside_window';
      health.last_error_class = null;
      return;
    }

    const snapshots = await captureSnapshots(env, startedAt);
    const closings = await markClosings(env, startedAt);

    health.last_result = `snapshots=${snapshots} closings=${closings}`;
    health.last_error_class = null;
  } catch (error) {
    health.last_error_class = errorClass(error);
    console.error(`[${SERVICE}] run failed class=${health.last_error_class}`);
  }
}

/* ---------------------------------------------------------------------------
 * Capture
 * ------------------------------------------------------------------------ */

/* Reads through the nfl-odds service binding. The response envelope is
 * { markets, count, events, source, usage, cache, ... } — the provider's own
 * event array is under `events`. */
async function fetchOdds(env) {
  if (!env.NFL_ODDS) throw new Error('odds_binding_missing');
  const response = await env.NFL_ODDS.fetch(
    new Request('https://nfl-odds.internal/api/odds', { method: 'GET' }),
  );
  if (!response.ok) throw new Error(`odds_service_${response.status}`);
  const body = await response.json();
  const events = Array.isArray(body?.events) ? body.events : [];
  if (!events.length) throw new Error('odds_service_empty');
  return {
    events,
    usage: body?.usage || null,
    cache: body?.cache || null,
    provider_last_update: body?.provider_last_update || null,
  };
}

/* The gateway is the authority for game_id. The odds provider keys games by
 * its own event id, so map on kickoff date + team pair. A game we cannot map
 * is skipped rather than stored under a guessed id. */
async function gatewayGames(env) {
  const base = String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
  const response = await fetch(`${base}/api/schedule`, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`gateway_${response.status}`);
  const body = await response.json();
  return Array.isArray(body?.games) ? body.games : [];
}

/* The gateway is the authority for game_id. The normalizer has already turned
 * provider full names into gateway codes, so the join is exact: kickoff date
 * plus the away/home code pair. A game that does not map is SKIPPED rather
 * than stored under a guessed id. */
function buildGameIndex(games) {
  const byKey = new Map();
  for (const g of games) byKey.set(`${g.gameday}|${g.away_team}|${g.home_team}`, g);
  return byKey;
}

async function captureSnapshots(env, now) {
  const [odds, games] = await Promise.all([fetchOdds(env), gatewayGames(env)]);
  health.provider_usage = odds.usage;
  health.provider_cache = odds.cache;
  const index = buildGameIndex(games);
  const horizon = now.getTime() + LOOKAHEAD_DAYS * 86400000;
  const capturedAt = now.toISOString();

  const rows = [];
  let unmapped = 0;

  for (const event of odds.events) {
    const kickoff = Date.parse(event?.commence_time);
    if (!Number.isFinite(kickoff) || kickoff > horizon) continue;

    const selections = consensusByside(normalizeEvent(event, capturedAt));
    if (!selections.length) continue;

    /* Codes come from the normalizer's explicit 32-team table. */
    const day = String(event.commence_time).slice(0, 10);
    const first = selections[0];
    const game = index.get(`${day}|${first.away_team}|${first.home_team}`);
    if (!game) { unmapped += 1; continue; }

    for (const s of selections) {
      rows.push({
        game_id: game.game_id,
        book: s.book,
        market: s.market,
        side: s.side,
        line: s.line,
        price: s.price,
        is_closing: false,
        provider_market: s.provider_market,
        provider_outcome_name: s.provider_outcome_name,
        team: s.team,
        over_under: s.over_under,
        is_home: s.is_home,
        captured_at: capturedAt,
      });
    }
  }

  if (unmapped) console.log(`[${SERVICE}] unmapped_events=${unmapped}`);
  if (!rows.length) return 0;

  /* Chunked so a large slate cannot exceed the request body limit. */
  for (let i = 0; i < rows.length; i += 200) {
    await insert(env, 'nfl_odds_snapshots', rows.slice(i, i + 200), { returning: 'minimal' });
  }
  return rows.length;
}

/* ---------------------------------------------------------------------------
 * Closing capture
 *
 * On the first run at or after kickoff, the most recent pre-kickoff snapshot
 * per (market, side, book) becomes the closing line. The partial unique index
 * one_closing_per_side makes a second attempt a no-op, so this is idempotent.
 * ------------------------------------------------------------------------ */

async function markClosings(env, now) {
  const games = await gatewayGames(env);
  const nowMs = now.getTime();

  const started = games.filter(g => {
    const kickoff = Date.parse(`${g.gameday}T${g.gametime || '00:00'}:00Z`);
    return Number.isFinite(kickoff) && kickoff <= nowMs && nowMs - kickoff < 7 * 86400000;
  });
  if (!started.length) return 0;

  let marked = 0;
  for (const game of started) {
    const kickoffIso = new Date(Date.parse(`${game.gameday}T${game.gametime || '00:00'}:00Z`)).toISOString();

    const existing = await select(
      env, 'nfl_odds_snapshots',
      `game_id=eq.${encodeURIComponent(game.game_id)}&is_closing=is.true&select=id&limit=1`,
    );
    if (Array.isArray(existing) && existing.length) continue;

    const pre = await select(
      env, 'nfl_odds_snapshots',
      `game_id=eq.${encodeURIComponent(game.game_id)}`
      + `&captured_at=lt.${encodeURIComponent(kickoffIso)}`
      + '&select=id,market,side,book,captured_at&order=captured_at.desc&limit=500',
    );
    if (!Array.isArray(pre) || !pre.length) continue;

    /* Rows arrive newest first, so the first sighting of each key is the last
     * pre-kickoff observation. */
    const latest = new Map();
    for (const row of pre) {
      const key = `${row.market}|${row.side}|${row.book}`;
      if (!latest.has(key)) latest.set(key, row.id);
    }

    for (const id of latest.values()) {
      try {
        await patch(env, 'nfl_odds_snapshots', `id=eq.${id}`, { is_closing: true });
        marked += 1;
      } catch (error) {
        /* 409 means another run already claimed this side. Expected, not a
         * failure — that is the idempotency guarantee doing its job. */
        if (!String(error?.message || '').includes('409')) throw error;
      }
    }
  }
  return marked;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function errorClass(error) {
  const message = String(error?.message || 'unknown');
  return message.split(':')[0].slice(0, 60);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
