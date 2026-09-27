/* PBE Touchdown Targets — view=hits, the PUBLIC read of live target hits.
 *
 * Shared by the Vercel function (api/pbe-touchdown-targets.js) and the
 * Cloudflare contract (workers/nfl-touchdown-targets-api/src/contract.js), so
 * the two cannot drift.
 *
 * WHY IT IS PUBLIC
 * Every row is a touchdown that has ALREADY happened, observed by the one
 * server-side detector (nfl-touchdown-target-hit-alerts). The query reads only
 * nfl_td_target_hit_events — never nfl_prop_picks — so an open target that has
 * not scored cannot leave through this door however it is called. No
 * model_snapshot, candidate pool, driver or selector internals are selected.
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

/* `sb(path, query, secret)` is the caller's PostgREST reader; `send` its
 * responder. Both callers pass their own. */
export async function hitsView({ res, send, sb, secret, query = {}, nowMs = Date.now() }) {
  const since = parseSince(query.since, nowMs);
  const rows = await sb(
    'nfl_td_target_hit_events',
    `detected_at=gt.${encodeURIComponent(since)}&select=${HIT_FIELDS}&order=detected_at.asc&limit=${HITS_LIMIT}`,
    secret,
  );
  const hits = (Array.isArray(rows) ? rows : []).map(shapeHit);
  return send(res, 200, {
    view: 'hits',
    since,
    count: hits.length,
    cursor: hits.length ? hits[hits.length - 1].detected_at : since,
    limit: HITS_LIMIT,
    hits,
    definition: 'at least one rushing or receiving touchdown credited to the target, observed live on a fresh scoring play',
    settlement: 'LIVE HIT — the final result settles after the game, from the official final box score',
  }, 'no-store');
}
