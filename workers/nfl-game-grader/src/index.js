/* nfl-game-grader — settles official picks from authoritative final scores,
 * computes CLV, and creates the finalized learning observations the tuner is
 * allowed to see.
 *
 * Two properties the handoff requires and this file guarantees:
 *
 *   DETERMINISTIC — the same pick and the same final score always produce the
 *   same grade. No clock, no randomness, no "current" market state.
 *
 *   IDEMPOTENT — re-running produces no duplicates and no drift. Grades are
 *   upserted on pick_id. A grade that would CHANGE an existing one is treated
 *   as an authoritative correction: it writes a correction_regrade audit event
 *   carrying the previous values, so history is appended to, never rewritten.
 *
 * FINAL comes from nfl-current (/api/current-games) — the same authority the
 * rest of the product uses. The previous source, the gateway's /api/scores, is
 * a static nflverse schedule with "no live score provider attached": it never
 * reported a single 2026 final, so no game could ever be graded. The grader now
 * runs every 15 minutes; a tick with nothing FINAL and unresolved costs one
 * nfl-current read and one indexed query.
 */

import {
  select, upsert, patch, audit,
} from '../../nfl-picks-engine-shared/supabase.mjs';
import { loadSlate, gradable } from '../../nfl-picks-engine-shared/current-slate.mjs';
import { recordRun, readLane, laneHealth } from '../../nfl-picks-engine-shared/runs.mjs';
import {
  collectPlaysFromUrl, buildSeasonRatings, blendSeasons, toRatingRows,
  RATINGS_SOURCE, RATINGS_ALGO_VERSION,
} from '../../nfl-picks-engine-shared/ratings.mjs';
import {
  settleSpread, settleTotal, settleMoneyline,
  unitsDelta, brierScore, outcomeBit,
  clvPoints, clvProb, clvBeat, devigTwoWay,
} from '../../nfl-picks-engine-shared/pick-math.mjs';

const SERVICE = 'nfl-game-grader';
const VERSION = 'v1.1.0';
/* Ratings are rebuilt from full nflverse play-by-play files — heavy, and only
 * meaningful when a week's results change. Refresh when the latest completed
 * week moves, and at most once a day otherwise. */
const RATINGS_MAX_AGE_MS = 24 * 3600000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      /* Evidence comes from the persisted run ledger, never from this isolate. */
      const lane = laneHealth(SERVICE, await readLane(env, SERVICE));
      return json({
        service: SERVICE, version: VERSION,
        health: lane.state,
        health_reason: lane.reason,
        last_tick: lane.last_tick,
        last_work: lane.last_work,
        last_ok_at: lane.last_ok_at,
        last_error: lane.last_error,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          NFL_CURRENT_BINDING: Boolean(env.NFL_CURRENT),
          PICKS_KV_BINDING: Boolean(env.PICKS_KV),
        },
      });
    }
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runGrading(env, event?.cron));
  },
};

async function runGrading(env, cron) {
  const base = { version: VERSION, cron: cron || null, started_at: new Date().toISOString() };
  const counts = { finals_in_window: 0, eligible: 0, graded: 0, corrected: 0, unchanged: 0, awaiting_final: 0 };
  let slate = null;
  try {
    slate = await loadSlate(env);
    const finals = finalScores(slate);
    counts.finals_in_window = finals.size;

    /* Killed picks are graded for CLV only: a kill is a model decision and the
     * tuner must see it. Superseded picks are NOT graded — the pick that
     * replaced them is the live decision. Only decisions whose game is FINAL
     * are fetched at all. */
    const finalIds = [...finals.keys()];
    const pending = finalIds.length
      ? (await select(
        env, 'nfl_game_picks',
        `game_id=in.(${finalIds.map(id => `"${id}"`).join(',')})`
        + '&or=(status.eq.open,status.eq.killed)&select=*&limit=1000',
      ) || [])
      : [];
    counts.eligible = pending.length;

    for (const pick of pending) {
      const outcome = await gradeOne(env, pick, finals.get(pick.game_id));
      if (outcome === 'corrected') counts.corrected += 1;
      else if (outcome === 'graded') counts.graded += 1;
      else counts.unchanged += 1;
    }

    /* Unresolved decisions on games that have kicked off but are not FINAL
     * yet. Visible so "waiting for a final" is distinguishable from "stuck". */
    const liveIds = slate.games.filter(g => g.state === 'LIVE').map(g => `"${g.game_id}"`);
    if (liveIds.length) {
      const waiting = await select(
        env, 'nfl_game_picks',
        `game_id=in.(${liveIds.join(',')})&or=(status.eq.open,status.eq.killed)&select=id&limit=1000`,
      ) || [];
      counts.awaiting_final = waiting.length;
    }

    /* Ratings change exactly when games complete, so the refresh lives here.
     * It is deliberately AFTER grading and independently guarded: a ratings
     * failure must not lose a grade, and it must not be silently swallowed
     * either — it is recorded as its own error class. */
    let ratings = 'not_due';
    let ratingsError = null;
    try {
      ratings = await maybeRefreshRatings(env, slate);
    } catch (error) {
      ratings = 'failed';
      ratingsError = errorClass(error);
      console.error(`[${SERVICE}] ratings refresh failed class=${ratingsError}`);
    }

    const worked = counts.graded || counts.corrected || (ratings !== 'not_due');
    await recordRun(env, SERVICE, {
      ...base,
      status: ratingsError ? 'degraded' : 'ok',
      reason: ratingsError ? `ratings_refresh_failed:${ratingsError}` : worked ? 'graded_or_refreshed' : 'nothing_final_unresolved',
      error_class: ratingsError,
      counts,
      source_freshness: {
        current_state_updated: slate.last_updated,
        current_state_freshness: slate.freshness?.state || null,
      },
      detail: { public: { ratings, season: slate.season, week: slate.week } },
    });
  } catch (error) {
    console.error(`[${SERVICE}] grading failed class=${errorClass(error)} detail=${String(error?.message || error).slice(0, 160)}`);
    await recordRun(env, SERVICE, {
      ...base, status: 'failed', error_class: errorClass(error), counts,
      source_freshness: slate ? { current_state_updated: slate.last_updated } : null,
    });
  }
}

/* The completed-week signal the ratings job keys on, from nfl-current. */
export function completedWeek(slate) {
  const finals = (slate?.games || []).filter(g => g.state === 'FINAL' && g.season === slate.season && g.season_type === 'REG');
  return { season: slate?.season, week: finals.length ? Math.max(...finals.map(g => Number(g.week) || 0)) : 0 };
}

async function maybeRefreshRatings(env, slate) {
  const signal = completedWeek(slate);
  let last = null;
  try { last = await env.PICKS_KV?.get('ratings:last', { type: 'json' }); } catch (_) { last = null; }
  const age = Date.now() - (Date.parse(last?.at || '') || 0);
  const moved = !last || last.season !== signal.season || last.week !== signal.week;
  if (!moved && age < RATINGS_MAX_AGE_MS) return 'not_due';
  const result = await refreshRatings(env, signal);
  try {
    await env.PICKS_KV?.put('ratings:last', JSON.stringify({ ...signal, at: new Date().toISOString(), result }),
      { expirationTtl: 30 * 86400 });
  } catch (_) { /* next tick simply refreshes again */ }
  return result;
}

/* ---------------------------------------------------------------------------
 * Ratings refresh — deterministic and idempotent.
 *
 * Upserts on (team, season, as_of_week), so re-running the same completed week
 * rewrites identical values rather than accumulating rows. Teams without
 * enough data are written with status 'unavailable' and NO metrics, never
 * zeros, so the orchestrator can tell "unknown" from a real 0.0 EPA/play.
 * ------------------------------------------------------------------------ */

const PBP_BASE = 'https://github.com/nflverse/nflverse-data/releases/download/pbp';

export function pbpUrl(season) {
  return `${PBP_BASE}/play_by_play_${season}.csv.gz`;
}

async function refreshRatings(env, { season, week }) {
  if (!Number.isFinite(week) || week < 0) return 'no_week_signal';

  /* WEEK-1 BOOTSTRAP. Before any regular-season week has completed, Week 1
   * still needs ratings. Write a factual prior-season-only baseline at
   * as_of_week = 0, which any real regular-season week then outranks, since
   * the orchestrator takes the highest as_of_week. No current-season metric is
   * fabricated: every row is labelled prior_only. */
  const isBaseline = week === 0;
  const asOfWeek = isBaseline ? 0 : week;

  /* The current season file does not exist until the season starts. That is a
   * normal pre-season state, not a failure — the prior season carries the
   * ratings and prior_blend_weight fades it out by week 8. */
  const current = await collectPlaysFromUrl(pbpUrl(season)).catch(error => {
    console.log(`[${SERVICE}] current-season pbp unavailable class=${errorClass(error)}`);
    return null;
  });
  const prior = await collectPlaysFromUrl(pbpUrl(season - 1)).catch(error => {
    console.log(`[${SERVICE}] prior-season pbp unavailable class=${errorClass(error)}`);
    return null;
  });

  if (!current && !prior) throw new Error('pbp_unavailable_both_seasons');

  /* On the baseline pass there is by definition no completed current-season
   * data, so the current map is empty and every team resolves to prior_only. */
  const currentRatings = (!isBaseline && current)
    ? buildSeasonRatings(current.plays, week)
    : new Map();
  const priorRatings = prior ? buildSeasonRatings(prior.plays, 99) : new Map();
  const blended = blendSeasons({
    current: currentRatings, prior: priorRatings,
    week: isBaseline ? 1 : week,
  });

  const qbTiers = await qbTierMap(env);
  const rows = toRatingRows(blended, {
    season, asOfWeek,
    sourceTimestamp: new Date().toISOString(),
    qbTiers,
  });
  if (!rows.length) return 'no_rows';

  await upsert(env, 'nfl_team_ratings', rows, 'team,season,as_of_week', { returning: 'minimal' });

  const usable = rows.filter(r => r.status === 'ok' || r.status === 'prior_only').length;
  await audit(env, {
    event_type: 'training_run',
    detail: {
      kind: isBaseline ? 'ratings_baseline' : 'ratings_refresh',
      season, as_of_week: asOfWeek,
      source: RATINGS_SOURCE, source_version: RATINGS_ALGO_VERSION,
      teams: rows.length, usable, unavailable: rows.length - usable,
    },
  });
  return `${usable}/${rows.length}@w${asOfWeek}${isBaseline ? ' (prior_only baseline)' : ''}`;
}

/* QB tier comes from the injury/role source already feeding Injury
 * Intelligence. If it is unavailable the tier is left null rather than
 * defaulted to a middle value that would look like real information. */
async function qbTierMap(env) {
  try {
    const base = String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
    const response = await fetch(`${base}/api/injuries`, { cf: { cacheTtl: 600 } });
    if (!response.ok) return {};
    const body = await response.json();
    const rows = Array.isArray(body?.injuries) ? body.injuries : [];
    const out = {};
    for (const row of rows) {
      if (String(row?.position || '').toUpperCase() !== 'QB') continue;
      const team = String(row?.team || '').toUpperCase();
      if (!team) continue;
      const status = String(row?.status || '').toUpperCase();
      const tier = /OUT|IR|DOUBTFUL/.test(status) ? 4
        : /QUESTIONABLE/.test(status) ? 3
        : /PROBABLE|ACTIVE/.test(status) ? 2 : null;
      if (tier !== null) out[team] = Math.max(out[team] || 0, tier);
    }
    return out;
  } catch (_) {
    return {};
  }
}

/* Pure settlement, exported for fixture tests. Given a pick and an
 * authoritative final, returns the complete grade with no I/O. */
export function computeGrade(pick, final, closing) {
  const killed = pick.status === 'killed';

  let result;
  if (killed) {
    result = 'void';
  } else if (final.cancelled) {
    result = 'void';
  } else if (pick.market === 'total') {
    /* Totals need no team attribution, but they DO need an explicit side. */
    const ou = String(pick.selection_over_under || '').toUpperCase();
    if (ou !== 'OVER' && ou !== 'UNDER') throw new Error('missing_attribution:selection_over_under');
    result = settleTotal({
      side: ou, pickLine: Number(pick.market_line),
      homeScore: final.home_score, awayScore: final.away_score,
    });
  } else {
    /* FAIL CLOSED. A missing side_is_home must never default to HOME — that
     * would silently grade every away pick against the wrong team. */
    if (typeof pick.side_is_home !== 'boolean') {
      throw new Error('missing_attribution:side_is_home');
    }
    if (!pick.selection_team) {
      throw new Error('missing_attribution:selection_team');
    }
    const selectedIsHome = pick.side_is_home;
    const teamScore = selectedIsHome ? final.home_score : final.away_score;
    const oppScore = selectedIsHome ? final.away_score : final.home_score;

    if (pick.market === 'spread') {
      result = settleSpread({ pickLine: Number(pick.market_line), teamScore, oppScore });
    } else {
      result = settleMoneyline({ teamScore, oppScore });
    }
  }

  const units = killed ? 0 : unitsDelta(pick.stake_units, pick.market_price, result);
  const brier = killed ? null : brierScore(pick.model_prob, result);

  const points = closing
    ? clvPoints({
        market: pick.market, side: pick.side,
        pickLine: pick.market_line, closeLine: closing.line,
      })
    : null;

  const closingProb = closing && closing.price !== null && closing.opposite_price !== null
    ? devigTwoWay(closing.price, closing.opposite_price)
    : null;
  const prob = clvProb({ closingProb, pickMarketProb: pick.market_prob });

  return {
    pick_id: pick.id,
    clv_points: points,
    clv_prob: prob,
    clv_beat: clvBeat(prob),
    result,
    units_delta: units,
    brier,
  };
}

async function gradeOne(env, pick, final) {
  const closing = await closingFor(env, pick);
  const grade = computeGrade(pick, final, closing);

  const existingRows = await select(
    env, 'nfl_pick_grades', `pick_id=eq.${pick.id}&select=*&limit=1`,
  );
  const existing = Array.isArray(existingRows) && existingRows.length ? existingRows[0] : null;

  if (existing && sameGrade(existing, grade)) {
    /* Idempotent re-run: nothing changed, so write nothing. */
    return 'skipped';
  }

  if (existing) {
    /* An authoritative correction. Record what it WAS before overwriting, so
     * the regrade is auditable rather than silent. */
    await audit(env, {
      pick_id: pick.id,
      event_type: 'correction_regrade',
      model_version: pick.model_version,
      detail: {
        previous: {
          result: existing.result, units_delta: existing.units_delta,
          clv_points: existing.clv_points, clv_prob: existing.clv_prob, brier: existing.brier,
        },
        corrected: {
          result: grade.result, units_delta: grade.units_delta,
          clv_points: grade.clv_points, clv_prob: grade.clv_prob, brier: grade.brier,
        },
      },
    });
  }

  await upsert(env, 'nfl_pick_grades', grade, 'pick_id', { returning: 'minimal' });

  if (!existing) {
    /* official_final_result is RESERVED for publication_scope='official'.
     * A finalized bootstrap decision emits tracking_final_result so the audit
     * trail never implies a customer-facing publication that never happened. */
    const scope = pick.publication_scope || 'tracking';
    await audit(env, {
      pick_id: pick.id,
      event_type: scope === 'official' ? 'official_final_result' : 'tracking_final_result',
      model_version: pick.model_version,
      detail: {
        publication_scope: scope,
        home_score: final.home_score, away_score: final.away_score,
      },
    });
    await audit(env, {
      pick_id: pick.id, event_type: 'first_grade', model_version: pick.model_version,
      detail: {
        publication_scope: scope,
        result: grade.result, units_delta: grade.units_delta, clv_beat: grade.clv_beat,
      },
    });
  }

  if (pick.status !== 'graded') {
    await patch(env, 'nfl_game_picks', `id=eq.${pick.id}`, { status: 'graded' });
  }

  /* The finalized learning observation. This is the ONLY row the tuner reads,
   * which makes it structurally impossible for a live or provisional result to
   * influence production weights. The features are the immutable decision-time
   * snapshot — never recomputed here, which would be look-ahead leakage. */
  await upsert(env, 'nfl_learning_observations', {
    pick_id: pick.id,
    season: pick.season,
    week: pick.week,
    market: pick.market,
    features: pick.features,
    model_version: pick.model_version,
    /* Carried straight from the pick. A finalized TRACKING decision is a
     * legitimate learning observation — it was timestamped before the outcome
     * was known — and recording its class keeps the tuner's sample auditable
     * rather than silently mixing bootstrap and official history. */
    publication_scope: pick.publication_scope || 'tracking',
    integrity_status: pick.integrity_status || 'eligible',
    integrity_reason: pick.integrity_reason || null,
    model_prob: pick.model_prob,
    clv_beat: grade.clv_beat,
    clv_prob: grade.clv_prob,
    result: grade.result,
    outcome: outcomeBit(grade.result),
    units_delta: grade.units_delta,
    brier: grade.brier,
    is_final: true,
  }, 'pick_id', { returning: 'minimal' });

  return existing ? 'corrected' : 'graded';
}

function sameGrade(a, b) {
  const eq = (x, y) => (x === null || x === undefined) && (y === null || y === undefined)
    ? true
    : Number(x) === Number(y) || String(x) === String(y);
  return eq(a.result, b.result) && eq(a.units_delta, b.units_delta)
    && eq(a.clv_points, b.clv_points) && eq(a.clv_prob, b.clv_prob)
    && eq(a.brier, b.brier) && eq(a.clv_beat, b.clv_beat);
}

/* ---------------------------------------------------------------------------
 * Inputs
 * ------------------------------------------------------------------------ */

/* FINAL results keyed by nflverse game_id, from nfl-current. Only the
 * provider's own FINAL with both scores present counts — nothing is inferred
 * from a clock. */
export function finalScores(slate) {
  const out = new Map();
  for (const game of slate?.games || []) {
    if (!gradable(game)) continue;
    out.set(game.game_id, {
      home_score: game.home_score,
      away_score: game.away_score,
      cancelled: false,
      espn_id: game.espn_id,
    });
  }
  return out;
}

/* Matches the closing snapshot CANONICALLY.
 *
 * Never by the display side string: a moved line turns "SEA -2.5" into
 * "SEA -3.5", so string matching would miss the correct side and — with the
 * old rows[0] fallback — silently attach the OPPOSITE team's closing price.
 * Team markets match on selection_team, totals on over_under.
 *
 * If the exact selection is not present, CLV is unavailable (null). There is
 * no fallback, because a wrong CLV is worse than a missing one. */
async function closingFor(env, pick) {
  const rows = await select(
    env, 'nfl_odds_snapshots',
    `game_id=eq.${encodeURIComponent(pick.game_id)}&market=eq.${pick.market}`
    + '&is_closing=is.true'
    + '&select=side,line,price,team,over_under,is_home&limit=20',
  ) || [];
  if (!rows.length) return null;

  let mine = null;
  let other = null;

  if (pick.market === 'total') {
    const ou = String(pick.selection_over_under || '').toUpperCase();
    if (ou !== 'OVER' && ou !== 'UNDER') return null;
    const opposite = ou === 'OVER' ? 'UNDER' : 'OVER';
    mine = rows.find(r => String(r.over_under || '').toUpperCase() === ou) || null;
    other = rows.find(r => String(r.over_under || '').toUpperCase() === opposite) || null;
  } else {
    const team = pick.selection_team;
    if (!team) return null;
    mine = rows.find(r => r.team === team) || null;
    /* The exact opposite canonical selection: the other team in this market. */
    other = rows.find(r => r.team && r.team !== team) || null;
  }

  if (!mine) return null;

  return {
    line: mine.line,
    price: mine.price,
    opposite_price: other ? other.price : null,
  };
}

function errorClass(error) {
  return String(error?.message || 'unknown').split(':')[0].slice(0, 60);
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
