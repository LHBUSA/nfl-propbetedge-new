-- ============================================================================
-- PropBetEdge NFL · MIGRATION CANDIDATE 002 · QB DNA derived layer
-- ----------------------------------------------------------------------------
-- NOT APPLIED. No production DDL has been run. This is the candidate that
-- 001 (CANDIDATE_SCHEMA.sql) feeds.
--
-- 001 holds RAW and CANONICAL. This file holds DERIVED: the pre-computed
-- shapes the three QB DNA APIs read. Everything here is reproducible by
-- replaying 001 — if a derived table is dropped, it can be rebuilt exactly.
-- That is the whole point of keeping raw snapshots immutable.
--
-- Design rules encoded in the DDL itself:
--   · every rate is stored as its NUMERATOR and DENOMINATOR, never as a bare
--     percentage, so a zero denominator can never be read as 0%
--   · every derived row records the ingest run that produced it
--   · UNKNOWN is NULL. There is no zero-fill anywhere in this file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Ingest bookkeeping. Every job writes here; every derived row points back.
-- ---------------------------------------------------------------------------
CREATE TABLE ingest_run (
  run_id           bigserial PRIMARY KEY,
  job              text NOT NULL,           -- nflverse_pbp | espn_scoreboard | ...
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text NOT NULL,           -- running | ok | failed | aborted
  season           int, week int,
  rows_read        bigint DEFAULT 0,
  rows_written     bigint DEFAULT 0,
  rows_unchanged   bigint DEFAULT 0,        -- content hash matched: a no-op
  error            text,
  git_sha          text,                    -- the code that produced the rows
  CONSTRAINT ingest_run_status CHECK (status IN ('running','ok','failed','aborted'))
);
CREATE INDEX ON ingest_run (job, started_at DESC);

-- A job resumes from here. One row per (job, partition); the partition key is
-- whatever that job iterates: a season, a season+week, a game id.
CREATE TABLE ingest_checkpoint (
  job              text NOT NULL,
  partition_key    text NOT NULL,
  last_run_id      bigint REFERENCES ingest_run,
  content_sha256   text,                    -- of the source payload last seen
  completed_at     timestamptz,
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  PRIMARY KEY (job, partition_key)
);
CREATE INDEX ON ingest_checkpoint (job, completed_at);

-- ---------------------------------------------------------------------------
-- Per-quarterback, per-game metrics. This is what /api/qb-dna reads.
-- One row per (game, player). Rebuilt from nfl_plays; never hand-edited.
-- ---------------------------------------------------------------------------
CREATE TABLE nfl_qb_game_metrics (
  pbe_game_id        bigint NOT NULL REFERENCES nfl_game_identity,
  pbe_player_id      bigint NOT NULL REFERENCES nfl_player_identity,

  -- denormalised for query speed; all derivable from nfl_games
  season             int  NOT NULL,
  week               int,
  season_type        text NOT NULL,
  game_date          date NOT NULL,
  team               text NOT NULL,
  opponent           text NOT NULL,
  is_home            boolean NOT NULL,
  is_primary_passer  boolean NOT NULL,

  -- counted outcomes. NULL means "not recorded", never "zero".
  attempts           int, completions int, pass_yards int,
  pass_tds           int, interceptions int,
  sacks              int, sack_yards int, dropbacks int, scrambles int,
  air_yards          int, yards_after_catch int,
  rush_attempts      int, rush_yards int, rush_tds int,
  qb_epa             numeric,

  -- game context, copied from the canonical layer at build time
  roof               text, surface text, spread_line numeric, total_line numeric,
  div_game           boolean, is_indoor_game boolean,
  temp_f             numeric, wind_mph numeric, rain_in numeric, snow_cm numeric,
  kickoff_local_hour int,
  environment_status text NOT NULL,   -- ok | skipped_indoor | no_matching_hour | error:*

  won                boolean,          -- NULL for a tie or an unrecorded result

  built_by_run_id    bigint NOT NULL REFERENCES ingest_run,
  built_at           timestamptz NOT NULL DEFAULT now(),
  source_sha256      text NOT NULL,    -- of the inputs; lets a rebuild no-op

  PRIMARY KEY (pbe_game_id, pbe_player_id)
);
CREATE INDEX ON nfl_qb_game_metrics (pbe_player_id, game_date);
CREATE INDEX ON nfl_qb_game_metrics (season, week);
CREATE INDEX ON nfl_qb_game_metrics (pbe_player_id, season) WHERE is_primary_passer;
-- the outdoor-weather split reads only this slice, so it gets its own index
CREATE INDEX ON nfl_qb_game_metrics (pbe_player_id, temp_f, wind_mph)
  WHERE is_indoor_game = false AND environment_status = 'ok';

-- ---------------------------------------------------------------------------
-- Condition splits, materialised. /api/qb-dna serves these directly.
-- games_in_window is the N. It is NOT NULL and it is always returned with the
-- value, which is how "no naked percentages" is enforced at the storage layer.
-- ---------------------------------------------------------------------------
CREATE TABLE nfl_qb_condition_splits (
  pbe_player_id     bigint NOT NULL REFERENCES nfl_player_identity,
  condition_key     text   NOT NULL,   -- home | below_freezing | wind_15_plus | ...
  season_scope      text   NOT NULL,   -- 'career' or a season as text
  metric            text   NOT NULL,   -- passing_yards | attempts | ...

  games_in_window   int    NOT NULL,   -- the N. always present.
  wins int, losses int,

  value_mean        numeric, value_median numeric,
  value_p25         numeric, value_p75 numeric,
  value_min         numeric, value_max numeric, value_stddev numeric,

  -- rates keep their parts; the API divides, the database never stores a pct
  completions_num   int, attempts_den int,
  pass_yards_num    int,
  tds_num           int, ints_num int,
  sacks_num         int, dropbacks_den int,

  baseline_mean     numeric,           -- the same player's own all-games mean
  baseline_games    int,
  -- movement from the player's OWN baseline. NULL when either side is missing.
  baseline_delta_pct numeric,

  sample_label      text NOT NULL,     -- product label for SIZE only
  -- how many games could not be evaluated, and why. Never silently dropped.
  excluded_games    int NOT NULL DEFAULT 0,
  exclusion_reason  text,

  built_by_run_id   bigint NOT NULL REFERENCES ingest_run,
  built_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (pbe_player_id, condition_key, season_scope, metric),
  CONSTRAINT split_sample_label CHECK (sample_label IN
    ('STRONG SAMPLE','MODERATE SAMPLE','SMALL SAMPLE','VERY SMALL SAMPLE')),
  -- a window with games must not claim a mean it cannot have, and a window
  -- with no games must not carry one
  CONSTRAINT split_games_nonneg CHECK (games_in_window >= 0),
  CONSTRAINT split_empty_has_no_mean CHECK (games_in_window > 0 OR value_mean IS NULL)
);
CREATE INDEX ON nfl_qb_condition_splits (pbe_player_id, season_scope);

-- ---------------------------------------------------------------------------
-- Threshold cache. Answers "how often has this number been cleared" without
-- rescanning the game log. Rebuilt whenever nfl_qb_game_metrics changes for
-- that player.
-- ---------------------------------------------------------------------------
CREATE TABLE nfl_qb_prop_threshold_cache (
  pbe_player_id   bigint NOT NULL REFERENCES nfl_player_identity,
  market          text   NOT NULL,   -- passing_yards | passing_attempts | ...
  line            numeric NOT NULL,
  condition_key   text   NOT NULL DEFAULT 'all',
  season_scope    text   NOT NULL DEFAULT 'career',

  games_total     int NOT NULL,      -- the denominator. always present.
  games_over      int NOT NULL,
  games_under     int NOT NULL,
  games_push      int NOT NULL,
  value_mean      numeric, value_median numeric,
  sample_label    text NOT NULL,

  built_by_run_id bigint NOT NULL REFERENCES ingest_run,
  built_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (pbe_player_id, market, line, condition_key, season_scope),
  -- the three outcomes must account for every game. no rounding, no leakage.
  CONSTRAINT prop_parts_sum CHECK (games_over + games_under + games_push = games_total),
  CONSTRAINT prop_total_positive CHECK (games_total > 0)
);

-- ---------------------------------------------------------------------------
-- Head to head. Only real meetings: both quarterbacks appeared in the SAME
-- game. The composite key is ordered so a pair is stored once.
-- ---------------------------------------------------------------------------
CREATE TABLE nfl_qb_head_to_head (
  player_a_id     bigint NOT NULL REFERENCES nfl_player_identity,
  player_b_id     bigint NOT NULL REFERENCES nfl_player_identity,
  meetings        int NOT NULL,
  a_wins int, b_wins int,
  a_mean_pass_yards numeric, b_mean_pass_yards numeric,
  game_ids        bigint[] NOT NULL,
  built_by_run_id bigint NOT NULL REFERENCES ingest_run,
  built_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_a_id, player_b_id),
  CONSTRAINT h2h_ordered CHECK (player_a_id < player_b_id),
  CONSTRAINT h2h_real CHECK (meetings = cardinality(game_ids) AND meetings > 0)
);

-- ---------------------------------------------------------------------------
-- Season-gated field availability. The gate in api/_qbdna/gating.js reads this.
-- Measured coverage, per field, per season — never assumed from a column's
-- existence. A season the source has not published gets coverage_pct NULL,
-- which is NOT the same as 0.
-- ---------------------------------------------------------------------------
CREATE TABLE nfl_field_availability (
  season          int  NOT NULL,
  field           text NOT NULL,
  source          text NOT NULL,          -- nflverse_participation | nflverse_ftn | ...
  rows_total      bigint,
  rows_populated  bigint,
  coverage_pct    numeric,                -- NULL = the source published nothing
  status          text NOT NULL,          -- AVAILABLE | INTERNAL_ONLY | WITHHELD | NOT_PUBLISHED
  measured_by_run_id bigint REFERENCES ingest_run,
  measured_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season, field),
  CONSTRAINT availability_status CHECK (status IN
    ('AVAILABLE','INTERNAL_ONLY','WITHHELD','NOT_PUBLISHED')),
  -- coverage and status must agree; a NULL coverage can only be NOT_PUBLISHED
  CONSTRAINT availability_null_is_unpublished
    CHECK (coverage_pct IS NOT NULL OR status = 'NOT_PUBLISHED')
);

-- ---------------------------------------------------------------------------
-- The public dataset artifact, so a served response can always be traced back
-- to the exact bytes that produced it.
-- ---------------------------------------------------------------------------
CREATE TABLE qbdna_dataset_build (
  build_id        bigserial PRIMARY KEY,
  generated_at    timestamptz NOT NULL,
  seasons         int[] NOT NULL,
  qb_games        int NOT NULL,
  players         int NOT NULL,
  bytes           bigint NOT NULL,
  content_sha256  text NOT NULL UNIQUE,
  r2_key          text,                  -- archive location of this exact build
  built_by_run_id bigint REFERENCES ingest_run,
  git_sha         text
);
