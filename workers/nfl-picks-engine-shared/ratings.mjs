/* Opponent-adjusted NFL team ratings from nflverse play-by-play.
 *
 * SOURCE
 *   https://github.com/nflverse/nflverse-data/releases/download/pbp/
 *     play_by_play_<season>.csv.gz
 *   Factual, public, updated nightly after games. 2025 measured at 19.1 MB
 *   gzipped / 93.4 MB raw / 48,771 rows / 371 columns.
 *
 * MEMORY
 *   The file is streamed and decompressed incrementally; the full text is
 *   never held. Only per-play accumulators survive, which is a few MB for a
 *   whole season. Column positions are resolved from the header BY NAME, never
 *   hardcoded, so an upstream column insertion cannot silently shift `epa`.
 *
 * DETERMINISM
 *   No clock, no randomness, fixed iteration count. The same input file always
 *   produces the same ratings, which is what makes the refresh idempotent.
 *
 * AVAILABILITY
 *   Every rating carries an explicit status. A team with too little data is
 *   returned as `unavailable` with a reason. It is NEVER returned as a
 *   zero-valued rating, because a genuine 0.0 EPA/play is a real, meaningful
 *   value and must stay distinguishable from "we don't know".
 */

export const RATINGS_SOURCE = 'nflverse_pbp';
export const RATINGS_ALGO_VERSION = 'v1.0.0';

/* Rolling window and prior-season decay, per the brief. */
export const ROLLING_GAMES = 10;
export const PRIOR_SEASON_DECAY = 0.5;
export const MIN_PLAYS_FOR_RATING = 100;
export const ADJUST_ITERATIONS = 20;

export const REQUIRED_COLUMNS = [
  'game_id', 'home_team', 'away_team', 'season_type', 'week',
  'posteam', 'defteam', 'epa', 'play', 'pass_oe',
];

/* ---------------------------------------------------------------------------
 * CSV
 * ------------------------------------------------------------------------ */

/* Quote-aware split of a single CSV record. */
export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
      continue;
    }
    if (c === ',' && !quoted) { out.push(field); field = ''; continue; }
    field += c;
  }
  out.push(field);
  return out;
}

export function resolveColumns(headerLine) {
  const cols = splitCsvLine(headerLine);
  const index = {};
  for (const name of REQUIRED_COLUMNS) {
    const at = cols.indexOf(name);
    if (at < 0) throw new Error(`pbp_missing_column:${name}`);
    index[name] = at;
  }
  return { index, total: cols.length };
}

/* ---------------------------------------------------------------------------
 * Aggregation
 * ------------------------------------------------------------------------ */

export function createPlayCollector() {
  const plays = [];          // { off, def, epa, week, game_id, pass_oe }
  const teams = new Set();

  return {
    add(fields, index) {
      if (fields[index.season_type] !== 'REG') return false;
      if (fields[index.play] !== '1') return false;
      const off = fields[index.posteam];
      const def = fields[index.defteam];
      if (!off || !def) return false;
      const epa = Number(fields[index.epa]);
      if (!Number.isFinite(epa)) return false;
      const week = Number(fields[index.week]);
      if (!Number.isFinite(week)) return false;

      const rawOe = fields[index.pass_oe];
      const passOe = rawOe === '' || rawOe === 'NA' ? null : Number(rawOe);

      teams.add(off); teams.add(def);
      plays.push({
        off, def, epa, week,
        game_id: fields[index.game_id],
        pass_oe: Number.isFinite(passOe) ? passOe : null,
      });
      return true;
    },
    result() {
      return { plays, teams: [...teams].sort() };
    },
  };
}

/* Streams a gzipped pbp file and collects plays without buffering the whole
 * decompressed text. Works in Workers (DecompressionStream) and Node 18+. */
export async function collectPlaysFromUrl(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`pbp_fetch_${response.status}`);
  if (!response.body) throw new Error('pbp_no_body');

  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let index = null;
  const collector = createPlayCollector();
  let scanned = 0;

  const handleLine = line => {
    if (!line) return;
    if (!index) { index = resolveColumns(line).index; return; }
    scanned += 1;
    collector.add(splitCsvLine(line), index);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    /* A quoted field may legally contain a newline, so only split on newlines
     * that sit outside quotes. Track quote parity across the buffer. */
    let start = 0, quoted = false;
    for (let i = 0; i < buffer.length; i += 1) {
      const c = buffer[i];
      if (c === '"') quoted = !quoted;
      else if (c === '\n' && !quoted) {
        handleLine(buffer.slice(start, i).replace(/\r$/, ''));
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
  }
  handleLine(buffer.replace(/\r$/, '').trim());

  const { plays, teams } = collector.result();
  return { plays, teams, scanned };
}

/* ---------------------------------------------------------------------------
 * Opponent adjustment
 *
 * Two-way additive decomposition, solved by alternating means:
 *
 *     epa ~ mu + off[posteam] + def[defteam]
 *
 * off[t] is how much a team's offence adds over league average given who it
 * played; def[t] is how much a defence CONCEDES over league average, so lower
 * is better. Fixed iteration count keeps it deterministic.
 * ------------------------------------------------------------------------ */

export function opponentAdjust(plays, iterations = ADJUST_ITERATIONS) {
  if (!plays.length) return { mu: 0, off: {}, def: {} };

  const mu = plays.reduce((sum, p) => sum + p.epa, 0) / plays.length;
  const off = {}, def = {};
  for (const p of plays) { off[p.off] = 0; def[p.def] = 0; }

  for (let iter = 0; iter < iterations; iter += 1) {
    const offSum = {}, offCount = {}, defSum = {}, defCount = {};

    for (const p of plays) {
      const residualOff = p.epa - mu - def[p.def];
      offSum[p.off] = (offSum[p.off] || 0) + residualOff;
      offCount[p.off] = (offCount[p.off] || 0) + 1;
    }
    for (const team of Object.keys(off)) {
      if (offCount[team]) off[team] = offSum[team] / offCount[team];
    }

    for (const p of plays) {
      const residualDef = p.epa - mu - off[p.off];
      defSum[p.def] = (defSum[p.def] || 0) + residualDef;
      defCount[p.def] = (defCount[p.def] || 0) + 1;
    }
    for (const team of Object.keys(def)) {
      if (defCount[team]) def[team] = defSum[team] / defCount[team];
    }
  }

  return { mu, off, def };
}

/* ---------------------------------------------------------------------------
 * Ratings
 * ------------------------------------------------------------------------ */

function lastGamesForTeam(plays, team, asOfWeek) {
  const games = [];
  const seen = new Set();
  const relevant = plays
    .filter(p => (p.off === team || p.def === team) && p.week <= asOfWeek)
    .sort((a, b) => b.week - a.week);
  for (const p of relevant) {
    if (seen.has(p.game_id)) continue;
    seen.add(p.game_id);
    games.push(p.game_id);
    if (games.length >= ROLLING_GAMES) break;
  }
  return new Set(games);
}

/* Builds ratings for one season's plays as of a given week.
 *
 * Returns Map<team, rating>. A team without enough data gets
 * { status: 'unavailable', reason } and NO numeric fields — never zeros. */
export function buildSeasonRatings(plays, asOfWeek) {
  const inWindow = plays.filter(p => p.week <= asOfWeek);
  const adjustment = opponentAdjust(inWindow);
  const teams = [...new Set(inWindow.flatMap(p => [p.off, p.def]))].sort();

  const out = new Map();
  for (const team of teams) {
    const games = lastGamesForTeam(inWindow, team, asOfWeek);
    const teamPlays = inWindow.filter(p => games.has(p.game_id));
    const offPlays = teamPlays.filter(p => p.off === team);
    const defPlays = teamPlays.filter(p => p.def === team);

    if (offPlays.length + defPlays.length < MIN_PLAYS_FOR_RATING) {
      out.set(team, {
        team,
        status: 'unavailable',
        reason: `insufficient_plays:${offPlays.length + defPlays.length}/${MIN_PLAYS_FOR_RATING}`,
        plays_sample: offPlays.length + defPlays.length,
        games_sample: games.size,
      });
      continue;
    }

    const oeValues = offPlays.map(p => p.pass_oe).filter(v => Number.isFinite(v));

    out.set(team, {
      team,
      status: 'ok',
      /* Opponent-adjusted, expressed as EPA/play relative to league average
       * plus the league mean so the number reads on the familiar scale. */
      off_epa_play: round(adjustment.mu + adjustment.off[team]),
      def_epa_play: round(adjustment.mu + adjustment.def[team]),
      proe: oeValues.length ? round(mean(oeValues)) : null,
      pace: games.size ? round(offPlays.length / games.size) : null,
      plays_sample: offPlays.length + defPlays.length,
      games_sample: games.size,
    });
  }
  return out;
}

/* Blends the current season with the prior season, decaying the prior by 50%
 * and fading it out entirely by week 8 (matching prior_blend_weight).
 *
 * A team unavailable in BOTH seasons stays unavailable. A team available only
 * in the prior season is returned with status 'prior_only' so the caller can
 * decide — it is still not silently treated as a current rating. */
export function blendSeasons({ current, prior, week }) {
  const priorWeight = week >= 8 ? 0 : PRIOR_SEASON_DECAY * ((8 - week) / 7);
  const teams = [...new Set([...(current?.keys() || []), ...(prior?.keys() || [])])].sort();

  const out = new Map();
  for (const team of teams) {
    const now = current?.get(team);
    const before = prior?.get(team);
    const nowOk = now && now.status === 'ok';
    const beforeOk = before && before.status === 'ok';

    if (!nowOk && !beforeOk) {
      out.set(team, {
        team, status: 'unavailable',
        reason: now?.reason || before?.reason || 'no_data',
      });
      continue;
    }
    if (!nowOk && beforeOk) {
      out.set(team, { ...before, status: 'prior_only', blend_prior_weight: 1 });
      continue;
    }
    if (nowOk && (!beforeOk || priorWeight <= 0)) {
      out.set(team, { ...now, blend_prior_weight: 0 });
      continue;
    }

    const w = priorWeight;
    out.set(team, {
      team,
      status: 'ok',
      off_epa_play: round(blend(now.off_epa_play, before.off_epa_play, w)),
      def_epa_play: round(blend(now.def_epa_play, before.def_epa_play, w)),
      proe: blendNullable(now.proe, before.proe, w),
      pace: blendNullable(now.pace, before.pace, w),
      plays_sample: now.plays_sample,
      games_sample: now.games_sample,
      blend_prior_weight: round(w),
    });
  }
  return out;
}

/* Rows ready for an idempotent upsert on (team, season, as_of_week). Only
 * rows with a usable status carry numbers; unavailable rows carry the status
 * and reason so the orchestrator can SEE that a rating is missing. */
export function toRatingRows(ratings, { season, asOfWeek, sourceTimestamp, qbTiers = {} }) {
  const rows = [];
  for (const rating of ratings.values()) {
    const usable = rating.status === 'ok' || rating.status === 'prior_only';
    rows.push({
      team: rating.team,
      season,
      as_of_week: asOfWeek,
      off_epa_play: usable ? rating.off_epa_play ?? null : null,
      def_epa_play: usable ? rating.def_epa_play ?? null : null,
      proe: usable ? rating.proe ?? null : null,
      pace: usable ? rating.pace ?? null : null,
      qb_tier: qbTiers[rating.team] ?? null,
      status: rating.status,
      status_reason: rating.reason || null,
      source: RATINGS_SOURCE,
      source_version: RATINGS_ALGO_VERSION,
      source_timestamp: sourceTimestamp || null,
      plays_sample: rating.plays_sample ?? null,
      games_sample: rating.games_sample ?? null,
    });
  }
  return rows.sort((a, b) => a.team.localeCompare(b.team));
}

/* The guard the orchestrator uses. A rating is usable only when it is
 * explicitly ok/prior_only AND carries real numbers. Anything else — missing
 * row, unavailable status, null metric — is reported as unusable with a
 * reason, so a missing rating can never be mistaken for a neutral 0. */
export function ratingUsable(rating) {
  if (!rating) return { usable: false, reason: 'no_rating_row' };
  if (rating.status !== 'ok' && rating.status !== 'prior_only') {
    return { usable: false, reason: rating.status_reason || `status:${rating.status || 'unknown'}` };
  }
  for (const field of ['off_epa_play', 'def_epa_play']) {
    const raw = rating[field];
    /* Number(null) and Number('') are both 0, which would let a missing metric
     * pass as a legitimate 0.0 EPA/play — precisely the confusion this guard
     * exists to prevent. Require a real number before coercing. */
    if (raw === null || raw === undefined || raw === ''
        || !Number.isFinite(Number(raw))) {
      return { usable: false, reason: `missing_metric:${field}` };
    }
  }
  return { usable: true, reason: null };
}

function blend(now, before, w) { return (1 - w) * Number(now) + w * Number(before); }
function blendNullable(now, before, w) {
  const a = Number(now), b = Number(before);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  if (!Number.isFinite(a)) return round(b);
  if (!Number.isFinite(b)) return round(a);
  return round(blend(a, b, w));
}
function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function round(v) { return Number.isFinite(Number(v)) ? Number(Number(v).toFixed(6)) : null; }
