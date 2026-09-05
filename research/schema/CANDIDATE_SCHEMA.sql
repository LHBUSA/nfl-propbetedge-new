-- PropBetEdge NFL data layer - CANDIDATE schema. NOT APPLIED. No production DDL.
-- Raw-first: a source snapshot is never overwritten, so everything can be
-- reprocessed when our normalization improves.

-- ============ RAW LAYER =====================================================
CREATE TABLE raw_nfl_source_snapshot (
  id               bigserial PRIMARY KEY,
  source           text NOT NULL,   -- espn_gamepackage | espn_teams | nflverse_pbp | open_meteo_archive
  source_url       text NOT NULL,
  fetched_at       timestamptz NOT NULL,
  source_timestamp timestamptz,     -- the source's own stamp, when it publishes one
  content_sha256   text NOT NULL,
  season           int,
  week             int,
  game_key         text,            -- source-native game id, deliberately unresolved here
  payload          jsonb NOT NULL,
  UNIQUE (source, source_url, content_sha256)   -- a changed source makes a NEW row
);
CREATE INDEX ON raw_nfl_source_snapshot (source, season, week);
CREATE INDEX ON raw_nfl_source_snapshot (game_key);

-- ============ IDENTITY ======================================================
-- Never join on display name when a stable id exists. A name-only match is
-- written with confidence='probable' and is not usable for stat attribution.
CREATE TABLE nfl_player_identity (
  pbe_player_id     bigserial PRIMARY KEY,
  gsis_id           text UNIQUE,     -- the spine: 100% populated in nflverse players
  esb_id            text,
  smart_id          text,
  espn_id           text,
  pfr_id            text,
  pff_id            text,
  otc_id            text,
  nfl_id            text,
  display_name      text NOT NULL,
  position          text,
  birth_date        date,
  resolution_method text NOT NULL,   -- nflverse_players | espn_id_join | manual
  confidence        text NOT NULL,   -- exact_id | probable | unresolved
  first_seen        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nfl_game_identity (
  pbe_game_id      bigserial PRIMARY KEY,
  nflverse_game_id text UNIQUE,      -- 2023_01_ARI_WAS
  espn_event_id    text UNIQUE,
  old_game_id      text,
  season           int NOT NULL,
  week             int,
  season_type      text,
  home_team        text NOT NULL,
  away_team        text NOT NULL,
  kickoff_utc      timestamptz,
  confidence       text NOT NULL
);

CREATE TABLE nfl_venue (
  pbe_venue_id   bigserial PRIMARY KEY,
  espn_venue_id  text UNIQUE,
  venue_guid     text,
  name           text NOT NULL,
  city           text, state text, postal text, country text,
  lat            double precision,
  lon            double precision,
  tz             text,
  indoor         boolean,
  grass          boolean,
  geocode_source text, geocode_query text, geocoded_at timestamptz
);

-- ============ CANONICAL =====================================================
CREATE TABLE nfl_games (
  pbe_game_id       bigint PRIMARY KEY REFERENCES nfl_game_identity,
  pbe_venue_id      bigint REFERENCES nfl_venue,
  roof              text, surface text,
  home_score        int, away_score int, result int,
  spread_line       numeric, total_line numeric, div_game boolean,
  home_coach        text, away_coach text,
  source            text NOT NULL,
  source_fetched_at timestamptz NOT NULL
);

-- OUR canonical play. Source-independent. UNKNOWN stays NULL, never 0.
CREATE TABLE nfl_plays (
  pbe_game_id            bigint NOT NULL REFERENCES nfl_game_identity,
  play_id                bigint NOT NULL,
  sequence               int,
  quarter                int, clock text, game_seconds_remaining int,
  possession_team        text, offense_team text, defense_team text,
  down                   int, distance int, yard_line int,
  yards_to_endzone       int, first_down_marker int,
  play_type              text, yards_gained int, stat_yardage int,
  passer_id              bigint, target_id bigint, receiver_id bigint, rusher_id bigint,
  interceptor_id         bigint, kicker_id bigint, punter_id bigint,
  fumble_player_id       bigint, recovery_player_id bigint,
  sack_player_ids        bigint[], tackler_ids bigint[],
  complete boolean, incomplete boolean, touchdown boolean, turnover boolean,
  penalty boolean, sack boolean, scramble boolean, kneel boolean, spike boolean,
  home_score_before int, away_score_before int,
  home_score_after  int, away_score_after  int,
  start_team_id text, end_team_id text,
  air_yards int, yards_after_catch int,
  epa numeric, wp numeric, cp numeric,
  published_text text,
  source text NOT NULL, source_play_id text, source_fetched_at timestamptz NOT NULL,
  -- per-field provenance, e.g. {"air_yards":"nflverse","yards_gained":"espn.statYardage"}
  field_provenance jsonb NOT NULL,
  PRIMARY KEY (pbe_game_id, play_id)
);

CREATE TABLE nfl_play_participants (
  pbe_game_id   bigint NOT NULL,
  play_id       bigint NOT NULL,
  pbe_player_id bigint NOT NULL REFERENCES nfl_player_identity,
  side          text NOT NULL,   -- offense | defense
  position      text,
  jersey        int,
  role          text,            -- passer | receiver | rusher | on_field ...
  source        text NOT NULL,   -- nflverse_participation
  PRIMARY KEY (pbe_game_id, play_id, pbe_player_id)
);

-- Weather is stored once, never re-queried per user request. A roofed game gets
-- a row with is_indoor_game=true and NULL readings, so its exclusion from
-- outdoor splits is explicit rather than an accidental gap.
CREATE TABLE nfl_game_environment (
  pbe_game_id        bigint PRIMARY KEY REFERENCES nfl_game_identity,
  is_indoor_game     boolean NOT NULL,
  kickoff_local_date date,
  kickoff_local_hour int,
  temp_f numeric, apparent_f numeric, humidity_pct numeric,
  precip_in numeric, rain_in numeric, snow_cm numeric,
  wind_mph numeric, gust_mph numeric, weather_code int,
  source             text NOT NULL,   -- open_meteo_archive
  source_url         text NOT NULL,
  fetched_at         timestamptz NOT NULL,
  gamebook_temp_f    numeric,         -- retained so the two can be compared
  gamebook_wind_mph  numeric,
  status             text NOT NULL    -- ok | skipped_indoor | no_matching_hour | error:*
);

CREATE TABLE nfl_qb_game_splits (
  pbe_game_id      bigint NOT NULL,
  pbe_player_id    bigint NOT NULL,
  team             text,
  is_primary_passer boolean,
  attempts int, completions int, pass_yards int, pass_tds int, interceptions int,
  sacks int, dropbacks int, scrambles int, air_yards int, yac int,
  rush_attempts int, rush_yards int, rush_tds int,
  qb_epa numeric,
  PRIMARY KEY (pbe_game_id, pbe_player_id)
);

-- Contradictions between sources are recorded, never silently merged.
CREATE TABLE nfl_source_conflict (
  id          bigserial PRIMARY KEY,
  entity      text NOT NULL,
  entity_key  text NOT NULL,
  field       text NOT NULL,
  source_a    text, value_a text,
  source_b    text, value_b text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolution  text
);
