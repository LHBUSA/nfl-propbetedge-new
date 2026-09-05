/* Season gating for advanced (participation / NGS-derived) fields.
 * =============================================================================
 * A column existing in the source is NOT evidence that a season contains the
 * data. nflverse participation coverage varies wildly by season and by field —
 * measured, not assumed:
 *
 *   offense_personnel   2019-2022 ~76%   2023 100%   2024 not published
 *   number_of_pass_rushers  2019-2022 ~43%   2023 97.2%   2024 not published
 *   ngs_air_yards       2019-2022 ~37%   2023 0%     2024 not published
 *
 * A split built on a 37%-covered field is not a split of that season, it is a
 * split of whichever 37% happened to be charted. So the gate FAILS CLOSED: a
 * field below the serve threshold is never used to compute a public number, and
 * the API says so explicitly instead of quietly returning a smaller sample.
 * ========================================================================== */

import { dataset } from './engine.js';

export const THRESHOLDS = {
  serve: 90,     // >= this: adequate to compute a public split
  retain: 50     // >= this but < serve: retained internally, never served
};

export const STATUS = {
  AVAILABLE:     'AVAILABLE',       // coverage adequate to serve
  INTERNAL_ONLY: 'INTERNAL_ONLY',   // retained in the warehouse, withheld publicly
  WITHHELD:      'WITHHELD',        // coverage too thin to mean anything
  NOT_PUBLISHED: 'NOT_PUBLISHED'    // the source published nothing for this season
};

/** The gate for one field in one season. Never throws, never guesses. */
export function gate(season, field) {
  const matrix = dataset().meta.field_availability_by_season || {};
  const row = matrix[String(season)];
  if (!row || !(field in row)) {
    return { field, season: Number(season), status: STATUS.NOT_PUBLISHED, coverage_pct: null,
             served: false, reason: 'no coverage measurement exists for this field and season' };
  }
  const cov = row[field];
  if (cov === null || cov === undefined) {
    return { field, season: Number(season), status: STATUS.NOT_PUBLISHED, coverage_pct: null,
             served: false, reason: 'the source has not published this field for this season' };
  }
  if (cov >= THRESHOLDS.serve) {
    return { field, season: Number(season), status: STATUS.AVAILABLE, coverage_pct: cov,
             served: false,
             reason: `coverage ${cov}% is adequate, but this prototype has not yet aggregated `
                   + 'this field into per-game metrics' };
  }
  if (cov >= THRESHOLDS.retain) {
    return { field, season: Number(season), status: STATUS.INTERNAL_ONLY, coverage_pct: cov,
             served: false,
             reason: `coverage ${cov}% is below the ${THRESHOLDS.serve}% serve threshold; `
                   + 'retained internally, not exposed publicly' };
  }
  return { field, season: Number(season), status: STATUS.WITHHELD, coverage_pct: cov, served: false,
           reason: `coverage ${cov}% is below the ${THRESHOLDS.retain}% retention threshold; a split `
                 + 'built on it would describe the charted subset, not the season' };
}

/** Every advanced field across every season the request touches. */
export function gateReport(seasons) {
  const matrix = dataset().meta.field_availability_by_season || {};
  const fields = new Set();
  for (const row of Object.values(matrix)) for (const f of Object.keys(row)) fields.add(f);

  const by_field = {};
  for (const f of [...fields].sort()) {
    const per = {};
    for (const s of seasons) per[s] = gate(s, f);
    const anyServable = Object.values(per).some(g => g.status === STATUS.AVAILABLE);
    by_field[f] = {
      seasons: per,
      any_season_adequate: anyServable,
      served_in_this_response: false
    };
  }
  return {
    policy: {
      serve_threshold_pct: THRESHOLDS.serve,
      retain_threshold_pct: THRESHOLDS.retain,
      rule: 'A field below the serve threshold is never used to compute a public number. '
          + 'It is withheld with a reason rather than returned as a smaller sample.'
    },
    by_field,
    // the flat honest answer to "what can I not have yet"
    unavailable_fields: Object.entries(by_field)
      .filter(([, v]) => !v.served_in_this_response)
      .map(([k]) => k)
  };
}

/** The fields this prototype DOES serve, and where each one comes from. */
export const SERVED_FIELDS = {
  attempts: 'nflverse_pbp', completions: 'nflverse_pbp', passing_yards: 'nflverse_pbp',
  passing_touchdowns: 'nflverse_pbp', interceptions: 'nflverse_pbp', sacks: 'nflverse_pbp',
  dropbacks: 'nflverse_pbp', scrambles: 'nflverse_pbp',
  air_yards: 'nflverse_pbp', yards_after_catch: 'nflverse_pbp', qb_epa: 'nflverse_pbp',
  rush_attempts: 'nflverse_pbp', rush_yards: 'nflverse_pbp', rush_touchdowns: 'nflverse_pbp',
  roof: 'nflverse_schedules', surface: 'nflverse_schedules', spread_line: 'nflverse_schedules',
  div_game: 'nflverse_schedules',
  temp_f: 'open_meteo_archive', wind_mph: 'open_meteo_archive',
  rain_in: 'open_meteo_archive', snow_cm: 'open_meteo_archive',
  kickoff_local_hour: 'derived_from_venue_tz', venue: 'espn_teams'
};
