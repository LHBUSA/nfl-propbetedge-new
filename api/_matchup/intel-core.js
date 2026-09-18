/* Matchup intelligence — composition rules, with no I/O so tests never boot a server.
 *
 * Contract: matchup-intel/v1.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: null is not zero.
 *
 * A team with no usable rating is not a league-average team. A split with no
 * plays is not 0.0 EPA. A player with no injury row is not "healthy" — he is a
 * player we have no report for. Every accessor in this file returns an explicit
 * state, and the renderer prints the state rather than a number it invented.
 *
 * The two words that must never be confused:
 *
 *   MATCHUP ADVANTAGE  one team's efficiency against the other's. It is a
 *                      statement about football.
 *   PBE EDGE           a model's fair value against the current market price.
 *                      It is a statement about a price.
 *
 * They live in different sections, they are computed from different inputs, and
 * nothing in this file returns them in the same object.
 */

export const CONTRACT = 'matchup-intel/v1';

/* A split below this many plays is reported, never hidden, as LIMITED SAMPLE. */
export const LIMITED_SAMPLE_PLAYS = 50;

/* Percentile thresholds for the strength/weakness engine. Deterministic, and
   stated on the page so a reader can check the classification themselves. */
export const STRENGTH_PERCENTILE = 75;
export const WEAKNESS_PERCENTILE = 25;

export const STATE = {
  OK: 'OK',
  UNAVAILABLE: 'UNAVAILABLE',
  LIMITED_SAMPLE: 'LIMITED_SAMPLE',
  PRIOR_BASELINE: 'PRIOR_BASELINE',
  NO_MARKET: 'NO_CURRENT_MARKET',
};

/* ---------------------------------------------------------------- ratings */

/**
 * The guard from workers/nfl-picks-engine-shared/ratings.mjs, restated here so
 * the web layer cannot accidentally be more permissive than the picks engine.
 * A rating is usable only when it is explicitly ok/prior_only AND carries real
 * numbers. A missing row, an unavailable status or a null metric is unusable —
 * never a zero.
 */
export function ratingUsable(rating) {
  if (!rating) return { usable: false, reason: 'no_rating_row' };
  if (rating.status !== 'ok' && rating.status !== 'prior_only') {
    return { usable: false, reason: rating.status_reason || `status:${rating.status || 'unknown'}` };
  }
  for (const metric of ['off_epa_play', 'def_epa_play']) {
    if (!Number.isFinite(Number(rating[metric])) || rating[metric] === null || rating[metric] === '') {
      return { usable: false, reason: `missing_metric:${metric}` };
    }
  }
  return { usable: true, reason: null };
}

/**
 * How a rating should be LABELLED, so the page never prints a blended or
 * prior-season number as though it were fully 2026.
 *
 * The ratings engine fades the prior season out by week 8 (see
 * PRIOR_SEASON_DECAY). `blend_prior_weight` is computed there but is not a
 * column on nfl_team_ratings, so it is recomputed here from the same formula
 * rather than guessed — and when the week is unknown it is reported unknown.
 */
export function ratingLabel(rating, week) {
  const check = ratingUsable(rating);
  if (!check.usable) {
    return { state: STATE.UNAVAILABLE, label: 'RATING UNAVAILABLE', reason: check.reason, prior_weight: null };
  }
  if (rating.status === 'prior_only') {
    return {
      state: STATE.PRIOR_BASELINE, label: 'PRIOR-SEASON BASELINE', reason: rating.status_reason || null,
      prior_weight: 1,
      note: 'No usable current-season sample yet. This is last season carried forward, not 2026 form.',
    };
  }
  const w = priorWeight(week);
  if (w === null) {
    return { state: STATE.OK, label: `${rating.season || ''} CURRENT`.trim(), prior_weight: null };
  }
  if (w > 0) {
    return {
      state: STATE.OK, label: `${rating.season || ''} + PRIOR BASELINE`.trim(), prior_weight: w,
      note: `Blended: the prior season still carries ${Math.round(w * 100)}% weight this early in the year.`,
    };
  }
  return { state: STATE.OK, label: `${rating.season || ''} CURRENT`.trim(), prior_weight: 0 };
}

/* PRIOR_SEASON_DECAY * ((8 - week) / 7), fading to 0 at week 8. */
export function priorWeight(week) {
  const w = Number(week);
  if (!Number.isFinite(w) || w < 1) return null;
  if (w >= 8) return 0;
  return Math.round(0.5 * ((8 - w) / 7) * 1000) / 1000;
}

/* ---------------------------------------------------------------- metrics */

/**
 * One displayable metric. `value` is null when unknown, and `state` says why —
 * so a renderer can never print 0 for "we do not know".
 */
export function metric(value, { plays = null, label = '', better = 'high', state = null } = {}) {
  const v = value === null || value === undefined || value === '' ? null : Number(value);
  const known = Number.isFinite(v);
  let resolved = state;
  if (!resolved) {
    if (!known) resolved = STATE.UNAVAILABLE;
    else if (Number.isFinite(Number(plays)) && Number(plays) < LIMITED_SAMPLE_PLAYS) resolved = STATE.LIMITED_SAMPLE;
    else resolved = STATE.OK;
  }
  return {
    value: known ? v : null,
    plays: Number.isFinite(Number(plays)) ? Number(plays) : null,
    state: resolved,
    limited: resolved === STATE.LIMITED_SAMPLE,
    label,
    better,
  };
}

/**
 * Percentile of one value within a league distribution.
 *
 * `better: 'low'` inverts, which is how a DEFENSIVE metric is handled: the
 * lowest EPA allowed is the best defence, so it must come out as the HIGHEST
 * percentile. Getting this backwards would label the best defence in the league
 * a weakness, so it is stated explicitly at every call site and tested in both
 * directions.
 */
export function percentileOf(value, distribution, better = 'high') {
  /* Number(null) is 0 and Number('') is 0, so a bare Number.isFinite check
     would turn "we have no value" into a real zero and rank it. The whole
     product rule is that null is not zero; it has to be enforced at the
     conversion, not after it. */
  if (value === null || value === undefined || value === '') return null;
  const v = Number(value);
  const pool = (distribution || []).map(Number).filter(Number.isFinite);
  if (!Number.isFinite(v) || pool.length < 4) return null;
  const below = pool.filter(x => (better === 'low' ? x > v : x < v)).length;
  return Math.round((below / pool.length) * 100);
}

/** Deterministic classification. The thresholds are constants, and printed. */
export function classify(percentile) {
  /* Same trap as percentileOf: Number(null) === 0 would classify an unknown as
     a bottom-quartile WEAKNESS, which is the most damaging possible reading of
     a missing number. */
  if (percentile === null || percentile === undefined || percentile === '') {
    return { band: STATE.UNAVAILABLE, label: 'NO RATING' };
  }
  if (!Number.isFinite(Number(percentile))) return { band: STATE.UNAVAILABLE, label: 'NO RATING' };
  const p = Number(percentile);
  if (p >= STRENGTH_PERCENTILE) return { band: 'STRENGTH', label: 'STRENGTH' };
  if (p <= WEAKNESS_PERCENTILE) return { band: 'WEAKNESS', label: 'WEAKNESS' };
  return { band: 'NEUTRAL', label: 'MIDDLE' };
}

/* ------------------------------------------------------------- collisions */

/**
 * A pressure point is one team's STRENGTH meeting the opponent's WEAKNESS in
 * the SAME dimension. Both sides must be classified from real numbers; if
 * either is unavailable there is no collision to report, because a collision
 * with an unknown is not a finding.
 *
 * This is MATCHUP ADVANTAGE. It is not an edge, it is not a pick, and the copy
 * it produces is descriptive: it says what the metrics are, not what will
 * happen.
 */
export const COLLISION_DIMENSIONS = ['overall', 'pass', 'rush', 'explosive'];

/* How each dimension reads in a sentence. 'overall' is the aggregate
   opponent-adjusted rating — the only one sourced today — and it is named
   "overall" rather than allowed to masquerade as a pass or rush split. */
export const DIMENSION_LABEL = {
  overall: 'overall', pass: 'pass', rush: 'rush', explosive: 'explosive-play',
};

export function collisions({ offense, defense, offenseTeam, defenseTeam }) {
  const out = [];
  for (const dimension of COLLISION_DIMENSIONS) {
    const off = offense?.[dimension];
    const def = defense?.[dimension];
    if (!off || !def) continue;
    if (off.state === STATE.UNAVAILABLE || def.state === STATE.UNAVAILABLE) continue;
    const offClass = classify(off.percentile);
    const defClass = classify(def.percentile);
    if (offClass.band !== 'STRENGTH' || defClass.band !== 'WEAKNESS') continue;
    out.push({
      dimension,
      offense_team: offenseTeam,
      defense_team: defenseTeam,
      offense_percentile: off.percentile,
      defense_percentile: def.percentile,
      offense_plays: off.plays ?? null,
      defense_plays: def.plays ?? null,
      limited: !!(off.limited || def.limited),
      /* Descriptive, traceable to the two numbers beside it. */
      statement: `${offenseTeam} ${DIMENSION_LABEL[dimension] || dimension} offence ranks `
        + `${ordinal(off.percentile)} percentile; ${defenseTeam} `
        + `${DIMENSION_LABEL[dimension] || dimension} defence allows at the `
        + `${ordinal(def.percentile)} percentile.`,
    });
  }
  return out;
}

/* ------------------------------------------------------------ availability */

/** Designations that matter enough to lead the availability section. */
export const DESIGNATION_RANK = { OUT: 0, DOUBTFUL: 1, QUESTIONABLE: 2, PROBABLE: 3 };

/** "82nd", not "82th". The statements are read by people. */
export function ordinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const mod100 = Math.abs(v) % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  switch (Math.abs(v) % 10) {
    case 1: return `${v}st`;
    case 2: return `${v}nd`;
    case 3: return `${v}rd`;
    default: return `${v}th`;
  }
}

/**
 * Order an injury board so a reader sees the decisions first.
 *
 * A missing report is NOT "healthy" — a player with no row simply does not
 * appear, and the section says how many rows it had rather than implying the
 * rest of the roster is fit.
 */
export function orderAvailability(rows, { limit = 8 } = {}) {
  return (rows || [])
    .filter(r => r && (r.status || r.bucket))
    .map(r => ({
      player: r.player?.name || r.athlete?.displayName || null,
      position: r.player?.position || null,
      status: String(r.status || r.bucket || '').toUpperCase() || null,
      detail: r.injury?.label || r.injury?.detail || null,
      practice: r.practice_status || null,
      updated_at: r.date || r.updated_at || null,
    }))
    .filter(r => r.player)
    .sort((a, b) => {
      const ra = DESIGNATION_RANK[a.status] ?? 9;
      const rb = DESIGNATION_RANK[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return String(a.player).localeCompare(String(b.player));
    })
    .slice(0, limit);
}

/* ------------------------------------------------------------- statements */

/**
 * "What matters most" — deterministic sentences, each traceable to a metric
 * that is displayed on the page. No prose model, no adjectives the numbers do
 * not support, and nothing emitted for a field that is unavailable.
 */
export function whatMattersMost({ away, home, pressurePoints, market, availability }) {
  const out = [];
  for (const point of (pressurePoints || []).slice(0, 2)) {
    out.push({
      kind: 'pressure_point',
      text: point.statement + (point.limited ? ' Both samples are still limited.' : ''),
    });
  }
  for (const side of [away, home]) {
    if (!side) continue;
    if (side.rating?.state === STATE.PRIOR_BASELINE) {
      out.push({
        kind: 'rating_state',
        text: `${side.team} has no usable 2026 sample yet; its numbers are a prior-season baseline.`,
      });
    } else if (side.rating?.prior_weight > 0) {
      out.push({
        kind: 'rating_state',
        text: `${side.team}'s rating still carries ${Math.round(side.rating.prior_weight * 100)}% prior-season weight at this point in the year.`,
      });
    }
  }
  if (market?.state === STATE.NO_MARKET) {
    out.push({ kind: 'market', text: 'No current market snapshot is available for this game.' });
  }
  for (const side of [away, home]) {
    const out_count = (side?.availability || []).filter(r => r.status === 'OUT').length;
    if (out_count > 0) {
      out.push({
        kind: 'availability',
        text: `${side.team} has ${out_count} player${out_count === 1 ? '' : 's'} ruled out on the current report.`,
      });
    }
  }
  return out.slice(0, 6);
}

/* --------------------------------------------------------------- free/pro */

/**
 * Strip every Pro value from a payload before it reaches a free browser.
 *
 * Removed, not hidden. A CSS-hidden fair value is still a fair value in the
 * response, and anyone can open the network tab.
 */
export function toFreePayload(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  clone.entitlement = { pro: false, withheld: ['model', 'pressure_points_detail', 'role', 'red_zone'] };
  clone.model = { state: 'PRO_REQUIRED', rows: [] };
  clone.role = { state: 'PRO_REQUIRED', players: [] };
  clone.red_zone = { state: 'PRO_REQUIRED' };
  for (const point of clone.pressure_points || []) {
    delete point.offense_plays;
    delete point.defense_plays;
  }
  return clone;
}
