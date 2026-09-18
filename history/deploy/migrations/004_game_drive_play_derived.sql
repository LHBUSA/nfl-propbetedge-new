-- 004_game_drive_play_derived.sql
-- source: schema/004_game_drive_play_derived.sql
-- Generated; apply with history/deploy/apply.mjs, never by hand-editing this file.

-- PropBetEdge football history graph — 004 games, box scores, drives, plays, participation, derived layer
-- STATUS: DESIGN. NOT APPLIED ANYWHERE.

-- ---------------------------------------------------------------- stat definitions (era-aware)
create table football.stat_definition (
  stat_key             text not null,                  -- 'passing_yards','sacks','tackles_solo'
  definition_version   text not null,
  scope                text not null check (scope in ('player','team')),
  description          text not null,
  official_from_season int,                            -- e.g. when a statistic became official
  official_to_season   int,
  league_id            text references football.league(league_id),
  citation             text,
  primary key (stat_key, definition_version)
);

-- ---------------------------------------------------------------- games
create table football.game (
  global_football_game_id text primary key,            -- 'gga_...'
  competition_id       text not null references football.competition(competition_id),
  season_id            text not null references football.season(season_id),
  week_label           text,                           -- verbatim ('Week 7','Wild Card','Divisional','1st Round')
  week_number          int,
  game_date            date not null,                  -- local date at venue
  kickoff_at           timestamptz,
  kickoff_precision    text not null check (kickoff_precision in ('exact','hour','date_only','unknown')),
  global_venue_id      text references football.venue(global_venue_id),
  venue_name_as_played text,
  neutral_site         boolean not null default false,
  international        boolean not null default false,
  home_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  away_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  status               text not null check (status in ('scheduled','final','final_overtime','suspended','cancelled','forfeit','postponed')),
  overtime_periods     int not null default 0,
  overtime_rule_key    text,                           -- rules_profile rule in force for THIS game
  attendance           int,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.game_team_score (
  global_football_game_id text not null references football.game(global_football_game_id),
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  final_score          int not null,
  period_scores        int[],                          -- Q1..Q4 then OT periods, as the source gives them
  result               text not null check (result in ('win','loss','tie','no_decision')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_football_game_id, global_football_team_identity_id)
);
create table football.game_official (
  global_football_game_id text not null references football.game(global_football_game_id),
  official_name        text not null,
  official_person_id   text references football.person(global_football_person_id),
  position             text not null,                  -- 'Referee','Umpire',...
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.game_weather_observation (
  global_football_game_id text not null references football.game(global_football_game_id),
  method               text not null check (method in ('reported_in_game_record','venue_station_hourly','nearest_station_hourly','daily_summary','indoor_not_applicable')),
  station_id           text,
  station_distance_km  numeric,
  observed_for         timestamptz,                    -- the observation time used
  temperature_c        numeric, wind_speed_kmh numeric, wind_direction_deg numeric,
  precipitation_mm     numeric, relative_humidity_pct numeric,
  conditions_reported  text,                           -- verbatim
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

-- ---------------------------------------------------------------- box scores (long form, definition-versioned)
create table football.team_game_stat (
  global_football_game_id text not null references football.game(global_football_game_id),
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  stat_key             text not null,
  definition_version   text not null,
  value                numeric not null,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_football_game_id, global_football_team_identity_id, stat_key, definition_version, source_snapshot_id),
  foreign key (stat_key, definition_version) references football.stat_definition(stat_key, definition_version)
);
create table football.player_game_stat (
  global_football_game_id text not null references football.game(global_football_game_id),
  global_football_player_id text not null references football.player(global_football_player_id),
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  stat_key             text not null,
  definition_version   text not null,
  value                numeric not null,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_football_game_id, global_football_player_id, stat_key, definition_version, source_snapshot_id),
  foreign key (stat_key, definition_version) references football.stat_definition(stat_key, definition_version)
);
create table football.player_game_appearance (           -- appeared / started / active, only as sourced
  global_football_game_id text not null references football.game(global_football_game_id),
  global_football_player_id text not null references football.player(global_football_player_id),
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  active               boolean,
  appeared             boolean,
  started              boolean,
  basis                text not null,                  -- 'official_gamebook','stat_line_present','participation_data'
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_football_game_id, global_football_player_id, basis)
);

-- ---------------------------------------------------------------- drives
create table football.drive (
  global_football_drive_id text primary key,           -- 'gdr_...'
  global_football_game_id text not null references football.game(global_football_game_id),
  sequence             int not null,
  offense_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  start_period         int, start_clock_seconds int,
  end_period           int, end_clock_seconds int,
  start_yardline_100   int,                            -- yards from opponent goal line
  end_yardline_100     int,
  plays                int, yards int, duration_seconds int, first_downs int,
  result               text check (result in ('touchdown','field_goal','missed_field_goal','punt','turnover','turnover_on_downs','safety','end_of_half','end_of_game','other')),
  result_source_label  text,                           -- verbatim
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  unique (global_football_game_id, sequence)
);

-- ---------------------------------------------------------------- plays
create table football.play (
  global_football_play_id text primary key,            -- 'gpy_...'
  global_football_game_id text not null references football.game(global_football_game_id),
  global_football_drive_id text references football.drive(global_football_drive_id),
  sequence             int not null,
  source_play_key      text not null,                  -- the source's play id (e.g., nflverse play_id)
  period               int,
  clock_seconds_remaining int,
  down                 int, distance int,
  yardline_100         int,
  possession_team_identity_id text references football.team_identity(global_football_team_identity_id),
  defense_team_identity_id text references football.team_identity(global_football_team_identity_id),
  play_type            text,                           -- canonical: pass, run, punt, field_goal, extra_point, two_point, kickoff, penalty_only, kneel, spike, no_play, other
  play_type_source_label text,
  description          text not null,                  -- verbatim source description, never rewritten
  yards_gained         int,
  air_yards            int,                            -- only where the source records it
  yards_after_catch    int,
  first_down           boolean, touchdown boolean, turnover boolean, sack boolean,
  score_home_before    int, score_away_before int,
  field_confidence     jsonb not null default '{}',    -- per-field: 'source_structured' | 'parsed_from_description' | 'absent'
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  unique (global_football_game_id, sequence)
);
create table football.play_participant (
  global_football_play_id text not null references football.play(global_football_play_id),
  global_football_player_id text references football.player(global_football_player_id),
  source_player_ref    text not null,                  -- verbatim id/name from the source
  team_identity_id     text references football.team_identity(global_football_team_identity_id),
  role                 text not null check (role in ('passer','rusher','receiver','tackler_solo','tackler_assist','sacker','sack_half','interceptor','pass_defender',
                         'fumbler','fumble_forcer','fumble_recoverer','kicker','punter','returner','holder','long_snapper','penalized','blocker_credited','other')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.play_penalty (
  global_football_play_id text not null references football.play(global_football_play_id),
  penalty_type_source  text not null,
  team_identity_id     text references football.team_identity(global_football_team_identity_id),
  penalized_player_id  text references football.player(global_football_player_id),
  yards                int,
  enforcement          text check (enforcement in ('accepted','declined','offsetting','no_play','unknown')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

-- ---------------------------------------------------------------- snaps / participation (held until a source is approved)
create table football.player_game_snaps (
  global_football_game_id text not null references football.game(global_football_game_id),
  global_football_player_id text not null references football.player(global_football_player_id),
  unit                 text not null check (unit in ('offense','defense','special_teams')),
  snaps                int not null,
  team_snaps           int,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_football_game_id, global_football_player_id, unit, source_snapshot_id)
);

-- ---------------------------------------------------------------- derived layer (never mixed with source facts)
create table football_derived.derivation (
  derivation_id        text primary key,               -- 'drv_records_v1_<ulid>'
  name                 text not null,                  -- 'season_leaderboards','records','game_dna','era_normalized'
  code_version         text not null,                  -- git sha of the deriving code
  input_snapshot_ids   text[] not null,
  computed_at          timestamptz not null,
  knowledge_cutoff     timestamptz                     -- null for hindsight analytics; set for model datasets
);
create table football_derived.leaderboard_entry (
  derivation_id        text not null references football_derived.derivation(derivation_id),
  scope                text not null,                  -- 'season:gss_nfl_2023:regular'
  stat_key             text not null,
  definition_version   text not null,
  rank                 int not null,
  entity_type          text not null,
  entity_id            text not null,
  value                numeric not null,
  qualifier            text,                           -- minimum-attempt rules, verbatim
  primary key (derivation_id, scope, stat_key, rank, entity_id)
);
create table football_derived.record (
  derivation_id        text not null references football_derived.derivation(derivation_id),
  record_key           text not null,                  -- 'single_game.passing_yards.regular'
  scope                text not null,                  -- league / franchise / era scope
  holder_entity_type   text not null,
  holder_entity_id     text not null,
  value                numeric not null,
  game_id              text,
  season_id            text,
  era_context          text,                           -- stat official since / schedule length notes
  primary key (derivation_id, record_key, scope, holder_entity_id)
);
create table football_derived.game_feature (
  derivation_id        text not null references football_derived.derivation(derivation_id),
  global_football_game_id text not null,
  feature_key          text not null,
  value                numeric,
  as_of                timestamptz,                    -- set for pre-game features; null = post-game description
  primary key (derivation_id, global_football_game_id, feature_key)
);

-- Rights enforcement in the data layer: a view per display surface only
-- exposes rows whose every supporting source allows that surface.
-- (Implemented in the API layer against football_src.source.display_policy.)
