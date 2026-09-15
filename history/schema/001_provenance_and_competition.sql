-- PropBetEdge football history graph — 001 provenance + competition graph
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. Target: an isolated Postgres schema set
-- (football_src / football / football_derived) in a project chosen by the owner.
-- Nothing here touches existing nfl_* tables, picks/model lineage or UFC tables.
--
-- Conventions
--   * Canonical ids are opaque text with a type prefix and a ULID body, e.g.
--     gfr_01J9..., assigned once and never reused or re-derived from names.
--   * Every canonical row cites source_snapshot_id (+ source_record_key).
--   * Time-varying rows are bitemporal: effective_from / effective_to (valid
--     time, half-open) and observed_at (knowledge time). See history/lib/temporal.mjs.
--   * Source labels are stored verbatim next to any canonical interpretation.

create schema if not exists football_src;
create schema if not exists football;
create schema if not exists football_derived;

-- ---------------------------------------------------------------- provenance
create table football_src.source (
  source_id            text primary key,               -- 'src_nflverse_pbp'
  name                 text not null,
  governing_org        text,
  origin_source_id     text references football_src.source(source_id), -- republisher -> origin
  licence_class        text not null check (licence_class in
                         ('public_domain','cc0','cc_by','cc_by_sa','odbl','proprietary_terms','licensed_feed','owner_generated','unknown')),
  commercial_verdict   text not null check (commercial_verdict in ('clear','license_required','review','hold','rejected')),
  obligations          text,                           -- attribution / share-alike text
  terms_url            text,
  terms_quote          text,
  decided_by           text,                           -- 'owner 2026-09-15', 'counsel', null
  decided_at           timestamptz,
  display_policy       text not null default 'internal_only'
                         check (display_policy in ('public','pro','internal_only','measurement_only','none')),
  model_use_allowed    boolean not null default false,
  notes                text
);

create table football_src.source_snapshot (
  source_snapshot_id   text primary key,               -- 'snp_<ulid>'
  source_id            text not null references football_src.source(source_id),
  dataset              text not null,                  -- 'play_by_play_2023'
  retrieved_from       text not null,                  -- URL or object path
  retrieved_at         timestamptz not null,
  content_sha256       text not null,
  bytes                bigint,
  r2_object_key        text,                           -- immutable raw copy
  parser_name          text not null,
  parser_version       text not null,
  row_count            bigint,
  season_min           int,
  season_max           int,
  unique (source_id, dataset, content_sha256)
);

-- Every canonical entity can list all its supporting source records.
create table football_src.entity_source_record (
  entity_type          text not null,                  -- 'player','game','play',...
  entity_id            text not null,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  source_record_key    text not null,                  -- the source's own key
  role                 text not null default 'supports' check (role in ('supports','conflicts','supersedes')),
  observed_at          timestamptz not null,
  primary key (entity_type, entity_id, source_snapshot_id, source_record_key)
);

create table football_src.external_id (
  entity_type          text not null,
  entity_id            text not null,
  id_system            text not null,                  -- 'nfl_gsis_id','espn_athlete_id','wikidata_qid',...
  id_value             text not null,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  confidence           numeric(4,3) not null check (confidence between 0 and 1),
  effective_from       date,
  effective_to         date,
  observed_at          timestamptz not null,
  primary key (entity_type, id_system, id_value, entity_id)
);
-- A strong id value belongs to exactly one entity (history/lib/identity.mjs STRONG_ID_SYSTEMS).
create unique index external_id_one_owner on football_src.external_id (entity_type, id_system, id_value)
  where id_system in ('nfl_gsis_id','nfl_esb_id','espn_athlete_id','pfr_player_id','wikidata_qid','cfl_player_id','ncaa_player_id','cfbd_athlete_id');

-- ---------------------------------------------------------------- competition graph
create table football.organization (
  organization_id      text primary key,               -- 'gorg_...'
  name                 text not null,
  kind                 text not null check (kind in ('league_body','governing_body','college_association','conference_body','other')),
  country_code         text,
  founded_on           date,
  dissolved_on         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

create table football.league (
  league_id            text primary key,               -- 'glg_...'  NFL, AFL (1960-69), AAFC, CFL, ...
  organization_id      text references football.organization(organization_id),
  name                 text not null,
  short_name           text not null,
  level                text not null check (level in ('professional','college','developmental','amateur','international')),
  country_code         text,
  effective_from       date,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

-- Leagues are never relabelled into each other; relationships are edges.
create table football.league_relation (
  league_relation_id   text primary key,
  from_league_id       text not null references football.league(league_id),
  to_league_id         text not null references football.league(league_id),
  relation             text not null check (relation in
                         ('merged_into','absorbed_teams_from','championship_agreement','common_draft','succeeded_by','rival','feeder')),
  effective_from       date not null,
  effective_to         date,
  description          text,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

create table football.rules_profile (
  rules_profile_id     text primary key,               -- 'grp_nfl_2021'
  league_id            text not null references football.league(league_id),
  effective_from_season int not null,
  effective_to_season  int,
  regular_season_games int,
  playoff_teams        int,
  overtime_rule        text,                           -- verbatim rule summary + rule key
  two_point_conversion boolean,
  pat_line_of_scrimmage_yards numeric,
  kickoff_rule         text,
  sacks_official_stat  boolean,
  roster_limit         int,
  citation             text not null,                  -- primary source for each fact
  verification_status  text not null check (verification_status in ('verified','unverified')),
  source_snapshot_id   text references football_src.source_snapshot(source_snapshot_id)
);

create table football.season (
  season_id            text primary key,               -- 'gss_nfl_2023'
  league_id            text not null references football.league(league_id),
  season_year          int not null,                   -- the year the season starts
  label                text not null,                  -- '2023', '1982 (strike-shortened)'
  rules_profile_id     text references football.rules_profile(rules_profile_id),
  starts_on            date,
  ends_on              date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  unique (league_id, season_year)
);

create table football.competition (
  competition_id       text primary key,               -- regular season, playoffs, championship game, Super Bowl, preseason
  season_id            text not null references football.season(season_id),
  kind                 text not null check (kind in
                         ('preseason','regular_season','postseason','championship_game','super_bowl','interleague_championship','all_star','exhibition','tiebreaker_playoff')),
  name                 text not null,                  -- 'Super Bowl LVIII', 'AFL Championship Game'
  counts_toward_records text not null check (counts_toward_records in ('regular','postseason','none')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

create table football.org_unit (                       -- conferences and divisions, league-scoped, time-bounded
  org_unit_id          text primary key,
  league_id            text not null references football.league(league_id),
  kind                 text not null check (kind in ('conference','division')),
  parent_org_unit_id   text references football.org_unit(org_unit_id),
  name                 text not null,
  effective_from_season int not null,
  effective_to_season  int,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
