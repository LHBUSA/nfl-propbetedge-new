/* PBE Touchdown Targets — view=hits, the PUBLIC read of live target hits.
 *
 * Shared by the Vercel function (api/pbe-touchdown-targets.js) and the
 * Cloudflare contract (workers/nfl-touchdown-targets-api/src/contract.js), so
 * the two cannot drift.
 *
 * WHO SEES WHAT (owner rule, V1 freeze 2026-09-29: live target signals are Pro only)
 * The entitlement tier is resolved SERVER-SIDE before anything is read:
 *   pro     the full hit: player, athlete ids, rank, probability, price, the
 *           play, clock, score, live stat line.
 *   locked  (free, signed out, or an entitlement check that failed) NOTHING.
 *           Not a generic notice, not a count, not a cursor: even the timing
 *           of an anonymous "a target scored" can be matched against the live
 *           scoreboard to name the player. The table is not queried for this
 *           tier at all, so the response is byte-identical before and after
 *           every hit.
 * The query reads only nfl_td_target_hit_events — never nfl_prop_picks — so an
 * open target that has not scored cannot leave through this door. No
 * model_snapshot, candidate pool, driver or selector internals are selected.
 *
 * ANNOUNCED ONLY. The table also persists hits observed late (live_stale) or
 * recovered after the final (final_backfill) so PBEcast can show a permanent
 * HIT. Those are never served here: every read filters detection=live_fresh,
 * so the rail can never celebrate an old touchdown.
 *
 * WHAT IT IS NOT
 * A grade. The final grader settles every target from the FINAL box score;
 * this is a live observation and says so on every response.
 */

export const HIT_FIELDS = [
  'id', 'pick_id', 'detected_at', 'espn_id', 'season', 'week',
  'away_team', 'home_team', 'away_score', 'home_score', 'period', 'clock',
  'player_name', 'espn_player_id', 'gsis_id', 'position', 'team', 'opponent', 'headshot_url',
  'target_rank', 'publication_scope', 'model_prob', 'market_price', 'confidence_bucket',
  'play_id', 'play_type', 'play_text', 'play_wallclock', 'live_stats', 'source',
].join(',');

/* Only fresh live observations are announcements. */
export const ANNOUNCED = 'detection=eq.live_fresh';
export const HITS_LIMIT = 25;
export const HITS_DEFAULT_WINDOW_MS = 30 * 60 * 1000;
export const HITS_MAX_WINDOW_MS = 24 * 3600 * 1000;

const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/* The cursor. Absent or unreadable -> the last 30 minutes; never further back
 * than 24 hours, so the endpoint cannot be asked to replay a season. */
export function parseSince(raw, nowMs = Date.now()) {
  const parsed = Date.parse(String(raw || ''));
  const floor = nowMs - HITS_MAX_WINDOW_MS;
  const value = Number.isFinite(parsed) ? Math.max(parsed, floor) : nowMs - HITS_DEFAULT_WINDOW_MS;
  return new Date(Math.min(value, nowMs)).toISOString();
}

/* Tracking is a verified live record, never the official one. The label is
 * decided here from the persisted row and nowhere else. */
export function scopeLabel(scope) {
  return scope === 'official' ? 'OFFICIAL TARGET' : 'TRACKING TARGET';
}

const STAT_KEYS = ['carries', 'rush_yards', 'rushing_td', 'targets', 'receptions', 'receiving_yards', 'receiving_td'];

export function shapeHit(row) {
  const stats = {};
  for (const key of STAT_KEYS) {
    const value = num(row?.live_stats?.[key]);
    if (value !== null) stats[key] = value;
  }
  const scope = row.publication_scope === 'official' ? 'official' : 'tracking';
  return {
    id: row.id,
    pick_id: row.pick_id,
    detected_at: row.detected_at,
    game: {
      espn_id: row.espn_id,
      away: row.away_team,
      home: row.home_team,
      away_score: num(row.away_score),
      home_score: num(row.home_score),
      period: num(row.period),
      clock: row.clock ?? null,
    },
    player: {
      name: row.player_name,
      espn_id: row.espn_player_id ?? null,
      gsis_id: row.gsis_id ?? null,
      position: row.position ?? null,
      team: row.team ?? null,
      opponent: row.opponent ?? null,
      headshot_url: typeof row.headshot_url === 'string' && /^https:\/\//.test(row.headshot_url) ? row.headshot_url : null,
    },
    target: {
      rank: row.target_rank === 'secondary' ? 'secondary' : 'primary',
      publication_scope: scope,
      scope_label: scopeLabel(scope),
      model_prob: num(row.model_prob),
      market_price: num(row.market_price),
      confidence_bucket: row.confidence_bucket ?? null,
    },
    play: {
      id: row.play_id ?? null,
      type: row.play_type ?? null,
      text: row.play_text ?? null,
      yards: num(row.source?.play_yards),
      wallclock: row.play_wallclock ?? null,
    },
    live_stats: stats,
  };
}

/* after_id: a non-negative integer event id, or null when absent/unreadable. */
export function parseAfterId(raw) {
  const value = String(raw ?? '').trim();
  if (!/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/* THE CURSOR IS THE EVENT ID.
 *
 *   ?after_id=<n>  the incremental read: id > n, ascending, bounded. The
 *                  identity column orders events durably, so two hits in the
 *                  same millisecond (or microsecond) each arrive exactly once,
 *                  and nothing is ever re-served. next_cursor = the largest id
 *                  returned, or n itself when nothing is newer — never past an
 *                  event that was not returned.
 *   ?since=<ISO>   BOOTSTRAP / COMPATIBILITY ONLY. A browser's first read asks
 *                  for the last few minutes so opening the site never replays
 *                  an old touchdown; its next_cursor hands the browser an id
 *                  and every later read is after_id. Older clients that still
 *                  poll with since keep working (the `cursor` timestamp field
 *                  is kept for them).
 *   both           after_id wins.
 *
 * A bootstrap that finds nothing must still hand back an id cursor, and it
 * cannot be 0: after_id=0 would return every historical hit. So the table's
 * current high-water id is read FIRST and bounds the window read; next_cursor
 * is that high-water mark when the window is empty, and any event inserted
 * after it is by construction > it and arrives on the first after_id read. */
/* The whole response a locked reader ever gets. Frozen: it cannot vary with a hit. */
export const LOCKED_HITS_BODY = Object.freeze({
  view: 'hits',
  access: 'locked',
  events: [],
  hits: [],
  next_cursor: null,
  note: 'Live Touchdown Target signals are All Access Pro. Settled results are public in the Track Record.',
});

export async function hitsView({ res, send, sb, secret, query = {}, nowMs = Date.now(), resolveAccess = async () => ({ tier: 'anonymous' }) }) {
  const TABLE = 'nfl_td_target_hit_events';
  const afterId = parseAfterId(query.after_id);
  if (query.after_id !== undefined && query.after_id !== '' && afterId === null) {
    return send(res, 400, { error: 'invalid_after_id', expected: 'non-negative integer event id' }, 'no-store');
  }

  let access;
  try { access = await resolveAccess(); } catch (_) { access = { tier: 'unavailable' }; }
  const pro = access?.tier === 'pro';
  /* No live target signal of any kind leaves for a locked reader: no rows,
     no count, no cursor. Constant response; the table is never read. */
  if (!pro) return send(res, 200, LOCKED_HITS_BODY, 'private, no-store, max-age=0');
  const fields = HIT_FIELDS;

  let rows;
  let since = null;
  let nextCursor;
  if (afterId !== null) {
    rows = await sb(TABLE, `id=gt.${afterId}&${ANNOUNCED}&select=${fields}&order=id.asc&limit=${HITS_LIMIT}`, secret);
    rows = Array.isArray(rows) ? rows : [];
    nextCursor = rows.length ? Math.max(...rows.map(row => Number(row.id))) : afterId;
  } else {
    since = parseSince(query.since, nowMs);
    const top = await sb(TABLE, 'select=id&order=id.desc&limit=1', secret);
    const highWater = Array.isArray(top) && top.length ? Number(top[0].id) : 0;
    rows = await sb(
      TABLE,
      `detected_at=gt.${encodeURIComponent(since)}&id=lte.${highWater}&${ANNOUNCED}&select=${fields}&order=id.asc&limit=${HITS_LIMIT}`,
      secret,
    );
    rows = Array.isArray(rows) ? rows : [];
    nextCursor = rows.length ? Math.max(...rows.map(row => Number(row.id))) : highWater;
  }

  const events = rows.map(row => ({ ...shapeHit(row), access: 'pro' }));
  return send(res, 200, {
    view: 'hits',
    access: 'pro',
    mode: afterId !== null ? 'after_id' : 'since_bootstrap',
    after_id: afterId,
    since,
    count: events.length,
    next_cursor: nextCursor,
    limit: HITS_LIMIT,
    events,
    /* compatibility for clients that predate after_id */
    hits: events,
    cursor: events.length ? events[events.length - 1].detected_at : since,
    definition: 'at least one rushing or receiving touchdown credited to the target, observed live on a fresh scoring play',
    settlement: 'LIVE HIT — the final result settles after the game, from the official final box score',
  }, 'private, no-store, max-age=0');
}
