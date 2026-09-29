/* PBE Touchdown Targets — view=game, the PBEcast read for ONE game.
 *
 * Shared by the Vercel function (api/pbe-touchdown-targets.js) and the
 * Cloudflare contract (workers/nfl-touchdown-targets-api/src/contract.js), so
 * the two cannot drift. Each caller supplies only its own entitlement answer.
 *
 * WHAT A FREE READER RECEIVES
 * The module shell and the facts that name nobody: whether PBE evaluated the
 * game, how many targets it locked, and how many of them have hit, missed,
 * voided or are pending. The free branch's queries do not SELECT a player
 * name, probability, snapshot, price, reason or play — so there is nothing in
 * the response, the page source or devtools to recover. The tier is decided
 * here, server-side, before a single row is read.
 *
 * WHAT A PRO READER RECEIVES
 * Every locked target for the game, ranked (#1 = the primary; secondaries
 * after it in issuance order), with the frozen probability, confidence, the
 * reasons derived server-side from the frozen snapshot, the lock times, and
 * its lifecycle:
 *
 *   HIT      final grade = win, or (before the grade) a persisted hit event
 *   MISS     final grade = loss
 *   VOID     final grade = void (the grader's existing policy: an explicit
 *            did-not-play flag, or a target withdrawn before kickoff)
 *   PENDING  no grade and no hit event
 *
 * The grade is the settlement authority and always wins. A hit event carries
 * the real scoring play (ESPN play id, type, yards, quarter, clock); it is
 * never inferred from a name here.
 *
 * Targets are the rows the track record counts (status open or graded).
 * Nothing is ever issued, changed or re-ranked by this read.
 */

export const GAME_TARGET_FIELDS = [
  'id', 'event_id', 'season', 'week', 'kickoff_ts', 'player_name', 'player_key',
  'model_prob', 'market_prob', 'edge_pct', 'confidence_bucket', 'market_price', 'book',
  'target_rank', 'projection_model_version', 'selector_version',
  'publication_scope', 'status', 'created_at', 'model_snapshot',
].join(',');

/* Free branch: enough to count and nothing more. */
export const FREE_TARGET_FIELDS = 'id,target_rank,status';

export const GAME_HIT_FIELDS = [
  'pick_id', 'detected_at', 'detection', 'play_id', 'play_type', 'play_text', 'period', 'clock',
  'play_wallclock', 'away_score', 'home_score', 'headshot_url', 'live_stats', 'source',
].join(',');

const EVALUATION_FIELDS = [
  'espn_id', 'event_id', 'season', 'week', 'kickoff_ts', 'away_team', 'home_team',
  'outcome', 'reason', 'publication_scope', 'decided_at',
].join(',');

const arr = value => (Array.isArray(value) ? value : []);
const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const inList = values => values.map(value => `"${String(value).replace(/"/g, '')}"`).join(',');

export const ESPN_GAME_RE = /^\d{6,12}$/;

/* The tier is one of pro | anonymous | no_entitlement | unavailable. Only
 * exactly 'pro' unlocks; anything else, including an error, is locked. */
export function isPro(access) { return access?.tier === 'pro'; }

export function lifecycle({ status, grade, hit }) {
  const result = String(grade?.result || '').toLowerCase();
  if (result === 'win') return 'HIT';
  if (result === 'loss') return 'MISS';
  if (result === 'void') return 'VOID';
  if (hit) return 'HIT';
  return 'PENDING';
}

/* #1 is the primary; secondaries follow in issuance order. */
export function rankTargets(rows) {
  const primary = rows.filter(row => row.target_rank === 'primary').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const rest = rows.filter(row => row.target_rank !== 'primary').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return [...primary, ...rest].map((row, index) => ({ row, rank: index + 1 }));
}

export function touchdownType(playType) {
  const type = String(playType || '').toLowerCase();
  if (type === 'passing touchdown') return 'receiving';
  if (type === 'rushing touchdown') return 'rushing';
  return null;
}

const headshotOk = url => (typeof url === 'string' && /^https:\/\/a\.espncdn\.com\//.test(url) ? url : null);
const idHeadshot = espnId => (/^\d+$/.test(String(espnId || '')) ? `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png` : null);

export function shapeHitForGame(hit) {
  if (!hit) return null;
  const type = touchdownType(hit.play_type);
  return {
    play_id: hit.play_id ?? null,
    play_type: hit.play_type ?? null,
    touchdown_type: type,
    yards: num(hit.source?.play_yards),
    period: num(hit.period),
    clock: hit.clock ?? null,
    text: hit.play_text ?? null,
    wallclock: hit.play_wallclock ?? null,
    away_score: num(hit.away_score),
    home_score: num(hit.home_score),
    detected_at: hit.detected_at ?? null,
    detection: hit.detection || 'live_fresh',
    /* only a fresh live observation may be celebrated */
    announce: (hit.detection || 'live_fresh') === 'live_fresh',
  };
}

export function shapeGameTarget({ row, rank, grade, hit, driversFrom }) {
  const snapshot = row?.model_snapshot || {};
  const player = snapshot.player || {};
  const reasons = typeof driversFrom === 'function' ? arr(driversFrom(snapshot)) : [];
  const scope = row.publication_scope === 'official' ? 'official' : 'tracking';
  const shapedHit = shapeHitForGame(hit);
  return {
    pick_id: row.id,
    rank,
    target_rank: row.target_rank === 'primary' ? 'primary' : 'secondary',
    state: lifecycle({ status: row.status, grade, hit }),
    publication_scope: scope,
    scope_label: scope === 'official' ? 'OFFICIAL TARGET' : 'TRACKING TARGET',
    player: {
      name: row.player_name,
      espn_id: player.espn_id ?? null,
      gsis_id: player.gsis_id ?? null,
      position: player.position ?? null,
      team: player.team ?? null,
      opponent: player.opponent ?? null,
      /* by ESPN athlete id only, never by name */
      headshot_url: headshotOk(hit?.headshot_url) || idHeadshot(player.espn_id),
    },
    model: {
      probability: num(row.model_prob),
      market_probability: num(row.market_prob),
      edge_pp: num(row.edge_pct) === null ? null : Number((num(row.edge_pct) * 100).toFixed(2)),
      confidence: row.confidence_bucket ?? null,
      version: row.projection_model_version ?? null,
      selector_version: row.selector_version ?? null,
      expected_touchdowns: num(snapshot.probability?.lambda),
    },
    reasons: reasons.map(driver => ({ key: driver.key, label: driver.label, direction: driver.direction, detail: driver.detail ?? null })),
    primary_reason: reasons.find(driver => driver.detail)?.detail ?? null,
    locked: {
      issued_at: row.created_at,
      locked_at: row.kickoff_ts,
      before_kickoff: Date.parse(row.created_at) < Date.parse(row.kickoff_ts),
    },
    hit: shapedHit,
    grade: grade ? {
      result: grade.result,
      offensive_td: num(grade.final_value),
      graded_at: grade.graded_at ?? null,
      settlement_note: grade.settlement_note ?? null,
    } : null,
  };
}

function countStates(states) {
  const counts = { targets: states.length, hit: 0, miss: 0, void: 0, pending: 0 };
  for (const state of states) {
    if (state === 'HIT') counts.hit += 1;
    else if (state === 'MISS') counts.miss += 1;
    else if (state === 'VOID') counts.void += 1;
    else counts.pending += 1;
  }
  return counts;
}

/**
 * @param {object}   args
 * @param {Function} args.resolveAccess  async () => ({ tier }) — the caller's entitlement authority
 * @param {Function} args.driversFrom    the caller's server-side reason derivation
 */
export async function gameView({ res, send, sb, secret, query = {}, resolveAccess, driversFrom, nowMs = Date.now() }) {
  const espnId = String(query.espn_id ?? query.event ?? '').trim();
  if (!ESPN_GAME_RE.test(espnId)) return send(res, 400, { error: 'invalid_espn_id', expected: 'ESPN game id' });

  let access;
  try { access = await resolveAccess(); } catch (_) { access = { tier: 'unavailable' }; }
  const pro = isPro(access);
  const tier = pro ? 'pro' : ['anonymous', 'no_entitlement', 'unavailable'].includes(access?.tier) ? access.tier : 'unavailable';

  const evaluation = arr(await sb(
    'nfl_td_final_pregame_evaluation',
    `espn_id=eq.${espnId}&select=${EVALUATION_FIELDS}&order=decided_at.desc&limit=1`,
    secret,
  ))[0] || null;

  const base = {
    view: 'game',
    espn_id: espnId,
    access: pro ? 'pro' : 'locked',
    access_reason: pro ? null : tier,
    entitlement: 'nfl_pro_or_all_access',
    definition: 'at least one rushing or receiving touchdown credited to the target in the official final box score',
  };

  if (!evaluation) {
    return send(res, 200, {
      ...base,
      evaluated: false,
      game: null,
      evaluation: { outcome: 'not_evaluated' },
      counts: countStates([]),
      ...(pro ? { targets: [] } : {}),
    });
  }

  const kickoffMs = Date.parse(evaluation.kickoff_ts);
  const game = {
    espn_id: espnId,
    season: evaluation.season,
    week: evaluation.week,
    kickoff_ts: evaluation.kickoff_ts,
    away_team: evaluation.away_team,
    home_team: evaluation.home_team,
    /* The set locks at kickoff; the database refuses any change after it. */
    locked: Number.isFinite(kickoffMs) && nowMs >= kickoffMs,
    locked_at: evaluation.kickoff_ts,
  };
  const evaluationOut = {
    outcome: evaluation.outcome,
    reason: evaluation.outcome === 'target_issued' ? null : evaluation.reason ?? null,
    publication_scope: evaluation.publication_scope ?? null,
    decided_at: evaluation.decided_at ?? null,
  };

  const eventFilter = `event_id=eq.${encodeURIComponent(evaluation.event_id)}&market=eq.player_anytime_td&status=in.(open,graded)`;
  const rows = arr(await sb('nfl_prop_picks', `${eventFilter}&select=${pro ? GAME_TARGET_FIELDS : FREE_TARGET_FIELDS}&limit=12`, secret));
  const ids = rows.map(row => row.id).filter(Boolean);
  const [grades, hits] = ids.length ? await Promise.all([
    sb('nfl_prop_pick_grades', `pick_id=in.(${inList(ids)})&select=${pro ? 'pick_id,result,final_value,graded_at,settlement_note' : 'pick_id,result'}`, secret).then(arr),
    sb('nfl_td_target_hit_events', `pick_id=in.(${inList(ids)})&select=${pro ? GAME_HIT_FIELDS : 'pick_id'}`, secret).then(arr),
  ]) : [[], []];
  const gradeBy = new Map(grades.map(row => [row.pick_id, row]));
  const hitBy = new Map(hits.map(row => [row.pick_id, row]));

  const ranked = rankTargets(rows);
  const states = ranked.map(({ row }) => lifecycle({ status: row.status, grade: gradeBy.get(row.id), hit: hitBy.get(row.id) }));
  const counts = countStates(states);

  if (!pro) {
    return send(res, 200, { ...base, evaluated: true, game, evaluation: evaluationOut, counts });
  }

  const targets = ranked.map(({ row, rank }) => shapeGameTarget({ row, rank, grade: gradeBy.get(row.id) || null, hit: hitBy.get(row.id) || null, driversFrom }));
  return send(res, 200, {
    ...base,
    evaluated: true,
    game,
    evaluation: evaluationOut,
    counts,
    targets,
    settlement: 'LIVE HIT is a live observation; the final result settles from the official final box score',
  });
}
