-- PropBetEdge football history graph — 002 franchises, venues, people, schools
-- STATUS: DESIGN. NOT APPLIED ANYWHERE.

-- ---------------------------------------------------------------- franchise lineage
create table football.franchise (
  global_football_franchise_id text primary key,       -- 'gfr_...'
  canonical_label      text not null,                  -- internal label only; never displayed as a historical name
  founded_on           date,
  terminated_on        date,                           -- folded / absorbed
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

create table football.team_identity (
  global_football_team_identity_id text primary key,   -- 'gti_...'
  league_id            text not null references football.league(league_id),
  location_name        text not null,                  -- as used at the time
  nickname             text not null,
  full_name            text not null,
  abbreviation         text,
  is_temporary_combined boolean not null default false, -- wartime merged teams
  -- Bounds may be unknown. A null date with basis 'unknown' says so; an
  -- 'evidence_window' bound is only "true at least within this window".
  effective_from       date,
  effective_to         date,
  from_basis           text not null default 'unknown'
                         check (from_basis in ('documented','derived_from_inception','evidence_window','unknown')),
  to_basis             text not null default 'unknown'
                         check (to_basis in ('documented','derived_from_dissolution','evidence_window','unknown','still_in_force')),
  -- How precisely the source stated each bound. A fact given only as a year is
  -- stored as 1 January of that year and says so here, so nothing downstream
  -- mistakes it for a known day. Ends are exclusive: a name used through 1996
  -- ends 1997-01-01.
  from_precision       text not null default 'unknown'
                         check (from_precision in ('day','month','year','unknown')),
  to_precision         text not null default 'unknown'
                         check (to_precision in ('day','month','year','unknown')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

create table football.team_identity_franchise (        -- m:n, time-bounded
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  global_football_franchise_id     text not null references football.franchise(global_football_franchise_id),
  effective_from       date,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_football_team_identity_id, global_football_franchise_id)
);

create table football.franchise_lineage_event (
  lineage_event_id     text primary key,
  global_football_franchise_id text not null references football.franchise(global_football_franchise_id),
  event_type           text not null,                  -- history/lib/lineage.mjs LINEAGE_EVENT_TYPES
  effective_on         date not null,
  from_team_identity_id text references football.team_identity(global_football_team_identity_id),
  to_team_identity_id  text references football.team_identity(global_football_team_identity_id),
  from_league_id       text references football.league(league_id),
  to_league_id         text references football.league(league_id),
  description          text,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

create table football.team_alignment (                 -- conference / division by season
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  season_id            text not null references football.season(season_id),
  conference_org_unit_id text references football.org_unit(org_unit_id),
  division_org_unit_id text references football.org_unit(org_unit_id),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_football_team_identity_id, season_id)
);

-- ---------------------------------------------------------------- venues
create table football.venue (
  global_venue_id      text primary key,               -- one physical venue; naming rights do not create a new one
  latitude             numeric(9,6),
  longitude            numeric(9,6),
  elevation_m          numeric,
  city                 text,
  region               text,
  country_code         text,
  opened_on            date,
  closed_on            date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.venue_name (
  global_venue_id      text not null references football.venue(global_venue_id),
  name                 text not null,
  -- A name whose start the source does not give is null, not a made-up date.
  effective_from       date,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_venue_id, name)
);
create table football.venue_attribute_period (
  global_venue_id      text not null references football.venue(global_venue_id),
  attribute            text not null check (attribute in ('roof','surface','capacity')),
  value                text not null,                  -- 'dome','retractable','open'; 'natural_grass','artificial:<brand>'; '70000'
  effective_from       date not null,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_venue_id, attribute, effective_from)
);
create table football.team_home_venue (
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  global_venue_id      text not null references football.venue(global_venue_id),
  season_id            text not null references football.season(season_id),
  is_primary           boolean not null default true,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_football_team_identity_id, global_venue_id, season_id)
);

-- ---------------------------------------------------------------- people
-- One human, possibly both player and coach: person is the root; the player
-- and coach ids required by the product are role profiles of that person.
create table football.person (
  global_football_person_id text primary key,          -- 'gpe_...'
  status               text not null default 'active' check (status in ('active','merged_into','split')),
  merged_into_person_id text references football.person(global_football_person_id),
  created_at           timestamptz not null default now()
);
create table football.player (
  global_football_player_id text primary key,          -- 'gpl_...'
  global_football_person_id text not null unique references football.person(global_football_person_id)
);
create table football.coach (
  global_football_coach_id text primary key,           -- 'gco_...'
  global_football_person_id text not null unique references football.person(global_football_person_id)
);

create table football.person_name (
  global_football_person_id text not null references football.person(global_football_person_id),
  name_kind            text not null check (name_kind in ('canonical','legal','alias','nickname','former','transliteration')),
  display_name         text not null,
  given_name           text,
  family_name          text,
  generational_suffix  text check (generational_suffix in ('Jr.','Sr.','II','III','IV','V')),
  normalized_key       text not null,                  -- identity.mjs normalizeName().key
  effective_from       date,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

create table football.person_attribute_observation (
  global_football_person_id text not null references football.person(global_football_person_id),
  attribute            text not null check (attribute in ('date_of_birth','birthplace','nationality','height_in','weight_lb','hand_size_in','arm_length_in')),
  value                text not null,
  measured_context     text,                           -- 'combine 2023','team roster week 1','college bio'
  measured_on          date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

-- Every link or refusal between source person records, auditable and reversible.
create table football_src.identity_match_decision (
  match_decision_id    text primary key,
  left_record          jsonb not null,                 -- source + key + attributes compared
  right_record         jsonb not null,
  decision             text not null check (decision in ('merge','review','distinct')),
  rule                 text not null,                  -- identity.mjs rule name
  evidence             jsonb not null,
  decided_by           text not null,                  -- 'policy:identity.mjs@<git sha>' or reviewer
  decided_at           timestamptz not null,
  resulting_person_id  text references football.person(global_football_person_id),
  reversed_by_decision_id text references football_src.identity_match_decision(match_decision_id)
);

create table football.player_position_observation (
  global_football_player_id text not null references football.player(global_football_player_id),
  source_label         text not null,                  -- verbatim
  canonical_code       text not null,                  -- ontology/positions.v1.json
  ambiguous            boolean not null,
  ontology_version     text not null,
  context              text not null check (context in ('roster','depth_chart','game','draft','combine','college','award','bio')),
  season_id            text references football.season(season_id),
  effective_from       date,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

create table football.jersey_number_period (
  global_football_player_id text not null references football.player(global_football_player_id),
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  jersey_number        text not null,                  -- text: '00' is not '0'
  effective_from       date not null,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

-- ---------------------------------------------------------------- schools / college
create table football.school (
  global_school_id     text primary key,               -- 'gsc_...' the institution
  name                 text not null,
  kind                 text not null check (kind in ('college','junior_college','high_school','international_school','other')),
  city                 text, region text, country_code text,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.school_name (
  global_school_id     text not null references football.school(global_school_id),
  name                 text not null,
  effective_from       date not null,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_school_id, effective_from)
);
create table football.college_team (
  global_college_team_id text primary key,             -- 'gct_...' the football program
  global_school_id     text not null references football.school(global_school_id),
  nickname             text,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.college_team_membership (        -- division / subdivision / conference by season
  global_college_team_id text not null references football.college_team(global_college_team_id),
  season_year          int not null,
  governing_body       text,                           -- 'NCAA','NAIA','NJCAA'
  classification       text,                           -- 'FBS','FCS','D-II',...
  conference_name      text,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  primary key (global_college_team_id, season_year)
);
