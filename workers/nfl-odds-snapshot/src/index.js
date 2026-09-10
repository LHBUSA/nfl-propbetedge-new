/* nfl-odds-snapshot — the picks engine's market tape and closing-line owner.
 *
 *   nfl-odds scheduled ingest (3x/day ET) → KV snapshot
 *        ↓ service binding, zero provider spend
 *   nfl-odds-snapshot  → nfl_odds_snapshots (append-only game market tape)
 *                      → is_closing marks once a game has kicked off
 *                      → nfl_prop_closing_snapshots (pre-kick prop quotes)
 *
 * ODDS SOURCE: the EXISTING nfl-odds Worker through a service binding. This
 * Worker holds no provider credential and every read it makes is served from
 * nfl-odds' persisted snapshot, so no tick — however frequent — spends a credit.
 *
 * TAPE SEMANTICS. A tape row's captured_at is the moment nfl-odds observed the
 * market (the batch's captured_at), not the moment this Worker copied it. A
 * batch is persisted exactly once: re-reading an unchanged snapshot every 15
 * minutes used to write the same 72 rows again under a new timestamp, which
 * made an unchanged market look freshly observed.
 *
 * PRE-KICK ONLY. A market observed at or after a game's kickoff is never
 * written to the tape, and a closing line is always the last observation
 * strictly before the REAL kickoff (from nfl-current — the old code parsed an
 * Eastern schedule time as UTC and closed every game four hours early).
 *
 * GAME IDENTITY comes from nfl-current, matched on team pair + nearest kickoff.
 * Joining on the UTC calendar date dropped every primetime game.
 *
 * Never logs a key.
 */

import { select, insert, patch } from '../../nfl-picks-engine-shared/supabase.mjs';
import {
  normalizeEvent, consensusByside, teamCodeFromName,
} from '../../nfl-picks-engine-shared/odds-normalize.mjs';
import { loadSlate, matchGameForEvent } from '../../nfl-picks-engine-shared/current-slate.mjs';
import { recordRun, readLane, laneHealth } from '../../nfl-picks-engine-shared/runs.mjs';
import { playerKey, PROP_MARKET } from '../../nfl-prop-picks-shared/prop-math.mjs';

const SERVICE = 'nfl-odds-snapshot';
const VERSION = 'v2.0.0';
const LOOKAHEAD_DAYS = 8;
/* A game's closing line is marked on the first tick after kickoff; the window
 * lets a missed tick (or a deploy gap) recover without re-scanning the season. */
const CLOSING_WINDOW_MS = 36 * 3600000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const lane = laneHealth(SERVICE, await readLane(env, SERVICE));
      return json({
        service: SERVICE,
        version: VERSION,
        health: lane.state,
        health_reason: lane.reason,
        last_tick: lane.last_tick,
        last_work: lane.last_work,
        last_ok_at: lane.last_ok_at,
        last_error: lane.last_error,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          NFL_ODDS_BINDING: Boolean(env.NFL_ODDS),
          NFL_CURRENT_BINDING: Boolean(env.NFL_CURRENT),
          PICKS_KV_BINDING: Boolean(env.PICKS_KV),
        },
      });
    }
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, event?.cron));
  },
};

async function run(env, cron) {
  const startedAt = new Date();
  const base = { version: VERSION, cron: cron || null, started_at: startedAt.toISOString() };
  const counts = {
    tape_rows: 0, unmapped_events: 0, post_kick_skipped: 0,
    closings: 0, prop_closing: 0, prop_closing_unavailable: 0,
  };
  let freshness = null;
  try {
    const slate = await loadSlate(env);
    const odds = await fetchOdds(env);
    freshness = {
      batch_id: odds.batch_id,
      market_captured_at: odds.captured_at,
      ingest_status: odds.ingest_status,
      current_state_updated: slate.last_updated,
    };

    const capture = await captureSnapshots(env, odds, slate, startedAt);
    Object.assign(counts, capture.counts);
    counts.closings = await markClosings(env, slate, startedAt);
    if (capture.persisted_batch) {
      const prop = await capturePropClosing(env, odds);
      counts.prop_closing = prop.captured;
      counts.prop_closing_unavailable = prop.unavailable;
    }

    const worked = capture.persisted_batch || counts.closings > 0;
    await recordRun(env, SERVICE, {
      ...base,
      status: worked ? 'ok' : 'skipped',
      reason: capture.persisted_batch ? 'new_market_batch'
        : counts.closings ? 'closings_marked' : 'batch_already_persisted',
      counts,
      source_freshness: freshness,
      detail: { public: { batch_id: odds.batch_id, tape_games: capture.games } },
    });
  } catch (error) {
    console.error(`[${SERVICE}] run failed class=${errorClass(error)}`);
    await recordRun(env, SERVICE, {
      ...base, status: 'failed', error_class: errorClass(error), counts, source_freshness: freshness,
    });
  }
}

/* ---------------------------------------------------------------------------
 * Capture
 * ------------------------------------------------------------------------ */

/* Reads through the nfl-odds service binding. The envelope carries the batch's
 * own captured_at and batch_id alongside the provider event array. */
async function fetchOdds(env) {
  if (!env.NFL_ODDS) throw new Error('odds_binding_missing');
  const response = await env.NFL_ODDS.fetch(
    new Request('https://nfl-odds.internal/api/odds', { method: 'GET' }),
  );
  if (!response.ok) throw new Error(`odds_service_${response.status}`);
  const body = await response.json();
  const events = Array.isArray(body?.events) ? body.events : [];
  if (!events.length) throw new Error('odds_service_empty');
  const capturedMs = Date.parse(body?.captured_at || '');
  if (!Number.isFinite(capturedMs)) throw new Error('odds_snapshot_undated');
  return {
    events,
    captured_at: new Date(capturedMs).toISOString(),
    batch_id: body?.batch_id || null,
    ingest_status: body?.ingest?.status || null,
  };
}

/* Pure: which rows a batch contributes to the tape. Exported for tests. */
export function tapeRowsForBatch(odds, games, nowMs, lookaheadDays = LOOKAHEAD_DAYS) {
  const capturedMs = Date.parse(odds.captured_at);
  const horizon = nowMs + lookaheadDays * 86400000;
  const rows = [];
  const covered = [];
  let unmapped = 0, postKick = 0;

  for (const event of odds.events) {
    const kickoff = Date.parse(event?.commence_time || '');
    if (!Number.isFinite(kickoff) || kickoff > horizon) continue;
    /* Observed at or after kickoff: an in-game price, never tape. */
    if (kickoff <= capturedMs) { postKick += 1; continue; }

    const game = matchGameForEvent(games, {
      away: teamCodeFromName(event?.away_team),
      home: teamCodeFromName(event?.home_team),
      commenceMs: kickoff,
    });
    if (!game) { unmapped += 1; continue; }

    const selections = consensusByside(normalizeEvent(event, odds.captured_at));
    if (!selections.length) continue;
    covered.push({ game_id: game.game_id, rows: selections.length });

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
        captured_at: odds.captured_at,
      });
    }
  }
  return { rows, covered, unmapped, postKick };
}

async function captureSnapshots(env, odds, slate, now) {
  const { rows, covered, unmapped, postKick } = tapeRowsForBatch(odds, slate.games, now.getTime());
  const counts = { tape_rows: 0, unmapped_events: unmapped, post_kick_skipped: postKick };
  if (unmapped) console.log(`[${SERVICE}] unmapped_events=${unmapped}`);

  /* One batch, persisted once. The database — not isolate memory, not KV — is
   * the idempotency authority, so a retried or overlapping tick cannot double it. */
  const existing = await select(
    env, 'nfl_odds_snapshots',
    `captured_at=eq.${encodeURIComponent(odds.captured_at)}&select=id&limit=1`,
  );
  if (Array.isArray(existing) && existing.length) {
    return { persisted_batch: false, counts, games: covered.length };
  }
  if (!rows.length) return { persisted_batch: false, counts, games: 0 };

  /* Chunked so a large slate cannot exceed the request body limit. */
  for (let i = 0; i < rows.length; i += 200) {
    await insert(env, 'nfl_odds_snapshots', rows.slice(i, i + 200), { returning: 'minimal' });
  }
  counts.tape_rows = rows.length;
  return { persisted_batch: true, counts, games: covered.length };
}

/* ---------------------------------------------------------------------------
 * Closing capture
 *
 * On the first tick at or after the REAL kickoff, the most recent pre-kickoff
 * observation per (market, side, book) becomes the closing line. The partial
 * unique index one_closing_per_side makes a second attempt a no-op, so this is
 * idempotent.
 * ------------------------------------------------------------------------ */

async function markClosings(env, slate, now) {
  const nowMs = now.getTime();
  const started = slate.games.filter(g =>
    Number.isFinite(g.kickoff_ms) && g.kickoff_ms <= nowMs && nowMs - g.kickoff_ms < CLOSING_WINDOW_MS);
  if (!started.length) return 0;

  let marked = 0;
  for (const game of started) {
    const doneKey = `closing:done:${game.game_id}`;
    if (await kvGet(env, doneKey)) continue;

    const existing = await select(
      env, 'nfl_odds_snapshots',
      `game_id=eq.${encodeURIComponent(game.game_id)}&is_closing=is.true&select=id&limit=1`,
    );
    if (Array.isArray(existing) && existing.length) {
      await kvPut(env, doneKey);
      continue;
    }

    const pre = await select(
      env, 'nfl_odds_snapshots',
      `game_id=eq.${encodeURIComponent(game.game_id)}`
      + `&captured_at=lt.${encodeURIComponent(game.kickoff_ts)}`
      + '&select=id,market,side,book,captured_at&order=captured_at.desc&limit=500',
    );
    if (!Array.isArray(pre) || !pre.length) {
      /* No pre-kick tape exists for this game. Nothing to close — and nothing
       * will appear later, because post-kick observations are never taped. */
      await kvPut(env, doneKey);
      continue;
    }

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
    await kvPut(env, doneKey);
  }
  return marked;
}

async function kvGet(env, key) {
  try { return await env.PICKS_KV?.get(key); } catch (_) { return null; }
}
async function kvPut(env, key) {
  try { await env.PICKS_KV?.put(key, '1', { expirationTtl: 14 * 86400 }); } catch (_) { /* next tick re-checks the DB */ }
}

/* ---------------------------------------------------------------------------
 * Prop closing tape
 *
 * For every live prop decision whose kickoff is still after this batch's
 * observation time, record the exact book's current two-way quote for that
 * player. observed_at is the batch time, so the grader's "last observation
 * before kickoff" is a real pre-kick market state. (pick_id, observed_at) is
 * unique, so one batch yields at most one row per decision.
 * ------------------------------------------------------------------------ */

async function capturePropClosing(env, odds) {
  const picks = await select(
    env, 'nfl_prop_picks',
    `market=eq.${PROP_MARKET}&status=in.(open,killed)`
      + `&kickoff_ts=gt.${encodeURIComponent(odds.captured_at)}`
      + '&select=id,event_id,kickoff_ts,player_name,player_key,market,book,side'
      + '&order=kickoff_ts.asc&limit=500',
  ) || [];
  let captured = 0, unavailable = 0;
  const boards = new Map();

  for (const pick of picks) {
    if (!boards.has(pick.event_id)) boards.set(pick.event_id, await propBoard(env, pick.event_id).catch(() => null));
    const board = boards.get(pick.event_id);
    const quote = board ? exactPropQuote(board.quotes, pick) : null;
    const observedMs = Date.parse(board?.captured_at || '');
    if (!quote || !Number.isFinite(observedMs) || observedMs >= Date.parse(pick.kickoff_ts)) {
      unavailable += 1;
      continue;
    }
    try {
      await insert(env, 'nfl_prop_closing_snapshots', {
        pick_id: pick.id,
        event_id: pick.event_id,
        player_key: pick.player_key,
        market: pick.market,
        book: pick.book,
        side: pick.side,
        point: quote.point,
        price: quote.price,
        opposite_price: quote.opposite_price,
        observed_at: new Date(observedMs).toISOString(),
        source: 'nfl-odds-snapshot',
      }, { returning: 'minimal' });
      captured += 1;
    } catch (error) {
      if (!String(error?.message || '').startsWith('supabase_409:')) throw error;
    }
  }
  return { captured, unavailable };
}

async function propBoard(env, eventId) {
  const response = await env.NFL_ODDS.fetch(new Request(
    `https://nfl-odds.internal/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${PROP_MARKET}`,
  ));
  if (!response.ok) return null;
  const body = await response.json();
  return { quotes: Array.isArray(body?.quotes) ? body.quotes : [], captured_at: body?.captured_at || null };
}

/* Same book, same player, same side; the opposite side at the SAME point from
 * the same book. No cross-book pairing and no line interpolation. */
export function exactPropQuote(quotes, pick) {
  const list = Array.isArray(quotes) ? quotes : [];
  const book = String(pick?.book || '').trim().toLowerCase();
  const side = String(pick?.side || '').trim().toUpperCase();
  const opposite = side === 'OVER' ? 'UNDER' : side === 'UNDER' ? 'OVER' : null;
  const target = playerKey(pick?.player_key || pick?.player_name);
  if (!book || !opposite || !target) return null;
  const same = q => String(q?.book || '').trim().toLowerCase() === book
    && playerKey(q?.player) === target && q?.market === PROP_MARKET;
  const mine = list.find(q => same(q) && String(q?.direction || '').toUpperCase() === side
    && finiteOrNull(q?.point) !== null && finiteOrNull(q?.price) !== null);
  if (!mine) return null;
  const point = finiteOrNull(mine.point);
  const other = list.find(q => same(q) && String(q?.direction || '').toUpperCase() === opposite
    && finiteOrNull(q?.point) === point && finiteOrNull(q?.price) !== null);
  const price = finiteOrNull(mine.price);
  const oppositePrice = finiteOrNull(other?.price);
  if (!other || !price || !oppositePrice) return null;
  return { point, price: Math.round(price), opposite_price: Math.round(oppositePrice) };
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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
