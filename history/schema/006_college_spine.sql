-- PropBetEdge football history graph — 006 the college spine
-- STATUS: DESIGN. NOT APPLIED ANYWHERE.
--
-- The rights-clean half of the college→NFL pathway: which institutions fielded
-- a programme, which conference it played in, who coached it, which players are
-- associated with it, and how a player entered professional football.
--
-- What is deliberately NOT here: college statistics of any kind. The spine
-- answers "who went where, and what happened next". It cannot answer "how good
-- were they in college", and it must not be made to look as though it can.
--
-- Every table carries source_snapshot_id, so the generator derives a row-level
-- rights policy for it and the lane policy on the snapshot decides the surface.

-- ---------------------------------------------------------------- conferences
-- A conference is an entity, not a string on a membership row. Programmes move
-- between them, conferences are founded and dissolve, and the same name has
-- meant different things (the Big East football conference is not the Big East
-- that survived it).
create table football.college_conference (
  global_college_conference_id text primary key,       -- 'gcc_...'
  name                 text not null,
  short_name           text,
  governing_body       text,                           -- 'NCAA','NAIA','NJCAA'
  effective_from       date,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

create table football.college_conference_membership (
  college_conference_membership_id text primary key,
  global_college_team_id text not null references football.college_team(global_college_team_id),
  global_college_conference_id text not null references football.college_conference(global_college_conference_id),
  first_season         int,                            -- unknown stays unknown
  last_season          int,
  sport_scope          text not null default 'football'
                         check (sport_scope in ('football','all_sports','unknown')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

-- ---------------------------------------------------------------- programme years
-- Which institution fielded football in which year. EADA is an institutional
-- self-report filed under the Equity in Athletics Disclosure Act, so the row
-- records what the institution stated and the survey year it stated it for —
-- never a claim that we audited it.
create table football.college_program_season (
  college_program_season_id text primary key,
  global_college_team_id text not null references football.college_team(global_college_team_id),
  season_year          int not null,
  sponsored            boolean not null,               -- the institution reported fielding football
  squad_size_reported  int,
  classification       text,                           -- 'FBS','FCS','D-II','D-III','NAIA' when the source gives it
  survey_year          int not null,                   -- the reporting year the row came from
  reporting_basis      text not null check (reporting_basis in
                         ('institution_self_report','governing_body_publication','curated')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null,
  unique (global_college_team_id, season_year, source_snapshot_id)
);

-- ---------------------------------------------------------------- player ↔ college
-- The CC0 association edge. Separate from football.college_enrollment on
-- purpose: enrollment carries a season range and expects a roster-grade source,
-- while this table records an association a source asserts, with the precision
-- the source actually gave. A year-precision claim is stored as year precision
-- and never rendered as 1 January.
--
-- basis names WHICH claim the source made. 'educated_at' (Wikidata P69) is an
-- attendance claim and not by itself a claim that the person played football
-- there; 'member_of_sports_team' (P54) is. Collapsing the two would invent a
-- fact, so the distinction is stored and the read contract honours it.
create table football.player_college_affiliation (
  player_college_affiliation_id text primary key,
  global_football_player_id text not null references football.player(global_football_player_id),
  global_school_id     text not null references football.school(global_school_id),
  global_college_team_id text references football.college_team(global_college_team_id),
  basis                text not null check (basis in
                         ('educated_at','member_of_sports_team','draft_listing','curated')),
  played_football      boolean,                        -- null when the source only establishes attendance
  effective_from       date,
  effective_to         date,
  date_precision       text not null default 'unknown'
                         check (date_precision in ('day','month','year','unknown')),
  first_season         int,
  last_season          int,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null,
  unique (global_football_player_id, global_school_id, basis, source_snapshot_id)
);

-- ---------------------------------------------------------------- college → pro
-- How a player entered professional football. draft_round and
-- draft_overall_pick are nullable and stay null unless an APPROVED source
-- supplies them: the registry currently marks every draft-detail source we hold
-- do_not_use, and a widely-known fact is not a licence. A null here is the
-- honest state, and draft_detail_source_snapshot_id names whatever did supply
-- it if that ever changes.
create table football.college_to_pro_transition (
  college_to_pro_transition_id text primary key,
  global_football_player_id text not null references football.player(global_football_player_id),
  global_school_id     text references football.school(global_school_id),
  global_college_team_id text references football.college_team(global_college_team_id),
  league_id            text references football.league(league_id),
  entry_route          text not null check (entry_route in
                         ('draft','supplemental_draft','undrafted_free_agent','other_league','unknown')),
  entry_year           int,
  entering_team_identity_id text references football.team_identity(global_football_team_identity_id),
  draft_round          int,
  draft_overall_pick   int,
  draft_detail_source_snapshot_id text references football_src.source_snapshot(source_snapshot_id),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null,
  -- A draft detail without the snapshot that justifies it is a fact with no
  -- provenance, which is the one thing this graph does not store.
  constraint draft_detail_is_cited check (
    (draft_round is null and draft_overall_pick is null) or draft_detail_source_snapshot_id is not null
  )
);
