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
 */

import {
  select, insert, upsert, patch, audit,
} from '../../nfl-picks-engine-shared/supabase.mjs';
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
const VERSION = 'v1.0.0';

const health = { last_cron_run: null, last_error_class: null, last_result: null };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return json({
        service: SERVICE, version: VERSION,
        last_cron_run: health.last_cron_run,
        last_error_class: health.last_error_class,
        last_result: health.last_result,
        requirements: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        },
      });
    }
    return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runGrading(env));
  },
};

async function runGrading(env) {
  health.last_cron_run = new Date().toISOString();
  try {
    const finals = await finalScores(env);
    /* Killed picks are graded for CLV only: a kill is a model decision and the
     * tuner must see it. Superseded picks are NOT graded — the pick that
     * replaced them is the live decision. */
    const pending = await select(
      env, 'nfl_game_picks',
      'or=(status.eq.open,status.eq.killed)&select=*&limit=1000',
    ) || [];

    let graded = 0, corrected = 0, skipped = 0;

    for (const pick of pending) {
      const final = finals.get(pick.game_id);
      if (!final) { skipped += 1; continue; }

      const outcome = await gradeOne(env, pick, final);
      if (outcome === 'corrected') corrected += 1;
      else if (outcome === 'graded') graded += 1;
      else skipped += 1;
    }

    /* Ratings change exactly when games complete, so the refresh lives here.
     * It is deliberately AFTER grading and independently guarded: a ratings
     * failure must not lose a grade, and it must not be silently swallowed
     * either — it is recorded as its own error class. */
    let ratings = 'skipped';
    try {
      ratings = await refreshRatings(env);
    } catch (error) {
      ratings = `failed:${errorClass(error)}`;
      health.last_ratings_error_class = errorClass(error);
      console.error(`[${SERVICE}] ratings refresh failed class=${errorClass(error)}`);
    }

    health.last_result = `graded=${graded} corrected=${corrected} skipped=${skipped} ratings=${ratings}`;
    health.last_error_class = null;
  } catch (error) {
    health.last_error_class = errorClass(error);
    console.error(`[${SERVICE}] grading failed class=${health.last_error_class}`);
  }
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

async function refreshRatings(env) {
  const { season, week } = await completedSeasonWeek(env);
  if (!Number.isFinite(week) || week < 1) return 'no_completed_week';

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

  const currentRatings = current ? buildSeasonRatings(current.plays, week) : new Map();
  const priorRatings = prior ? buildSeasonRatings(prior.plays, 99) : new Map();
  const blended = blendSeasons({ current: currentRatings, prior: priorRatings, week });

  const qbTiers = await qbTierMap(env);
  const rows = toRatingRows(blended, {
    season, asOfWeek: week,
    sourceTimestamp: new Date().toISOString(),
    qbTiers,
  });
  if (!rows.length) return 'no_rows';

  await upsert(env, 'nfl_team_ratings', rows, 'team,season,as_of_week', { returning: 'minimal' });

  const usable = rows.filter(r => r.status === 'ok' || r.status === 'prior_only').length;
  await audit(env, {
    event_type: 'training_run',
    detail: {
      kind: 'ratings_refresh', season, as_of_week: week,
      source: RATINGS_SOURCE, source_version: RATINGS_ALGO_VERSION,
      teams: rows.length, usable, unavailable: rows.length - usable,
    },
  });
  return `${usable}/${rows.length}@w${week}`;
}

/* The most recent week with completed games — ratings are only refreshed for
 * weeks that actually finished. */
async function completedSeasonWeek(env) {
  const base = String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
  const response = await fetch(`${base}/api/scores`, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`gateway_${response.status}`);
  const body = await response.json();
  const games = Array.isArray(body?.games) ? body.games : [];
  const finals = games.filter(g => {
    const s = String(g?.semantics || '').toUpperCase();
    const st = String(g?.status || '').toUpperCase();
    return s === 'FINAL' || /FINAL|COMPLETE|CLOSED/.test(st);
  });
  const season = Number(body?.season || new Date().getUTCFullYear());
  const week = finals.length ? Math.max(...finals.map(g => Number(g.week) || 0)) : 0;
  return { season, week };
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
  } else {
    const selectedIsHome = pick.side_is_home !== false;
    const teamScore = selectedIsHome ? final.home_score : final.away_score;
    const oppScore = selectedIsHome ? final.away_score : final.home_score;

    if (pick.market === 'spread') {
      result = settleSpread({ side: pick.side, pickLine: Number(pick.market_line), teamScore, oppScore });
    } else if (pick.market === 'total') {
      result = settleTotal({
        side: pick.side, pickLine: Number(pick.market_line),
        homeScore: final.home_score, awayScore: final.away_score,
      });
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
    await audit(env, {
      pick_id: pick.id, event_type: 'official_final_result', model_version: pick.model_version,
      detail: { home_score: final.home_score, away_score: final.away_score },
    });
    await audit(env, {
      pick_id: pick.id, event_type: 'first_grade', model_version: pick.model_version,
      detail: { result: grade.result, units_delta: grade.units_delta, clv_beat: grade.clv_beat },
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

async function finalScores(env) {
  const base = String(env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
  const response = await fetch(`${base}/api/scores`, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`gateway_${response.status}`);
  const body = await response.json();
  const games = Array.isArray(body?.games) ? body.games : [];

  const out = new Map();
  for (const game of games) {
    const semantics = String(game?.semantics || '').toUpperCase();
    const status = String(game?.status || '').toUpperCase();
    const isFinal = semantics === 'FINAL' || /FINAL|COMPLETE|CLOSED/.test(status);
    if (!isFinal) continue;
    const home = Number(game.home_score), away = Number(game.away_score);
    if (!Number.isFinite(home) || !Number.isFinite(away)) continue;
    out.set(game.game_id, {
      home_score: home,
      away_score: away,
      cancelled: /CANCEL|POSTPON/.test(status),
    });
  }
  return out;
}

async function closingFor(env, pick) {
  const rows = await select(
    env, 'nfl_odds_snapshots',
    `game_id=eq.${encodeURIComponent(pick.game_id)}&market=eq.${pick.market}`
    + '&is_closing=is.true&select=side,line,price&limit=10',
  ) || [];
  if (!rows.length) return null;

  const mine = rows.find(r => r.side === pick.side) || rows[0];
  const other = rows.find(r => r.side !== mine.side) || null;
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
