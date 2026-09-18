-- PropBetEdge football history graph — 003 career pathway, draft, rosters, transactions,
-- depth charts, coaching, injuries/availability, awards
-- STATUS: DESIGN. NOT APPLIED ANYWHERE.

-- ---------------------------------------------------------------- pathway (college -> pro)
-- Stages of one career. College and professional statistics are separate
-- tables and are never summed together.
create table football.career_stage (
  career_stage_id      text primary key,
  global_football_player_id text not null references football.player(global_football_player_id),
  stage                text not null check (stage in
                         ('high_school','college','transfer','combine','pro_day','draft','undrafted_free_agent',
                          'training_camp','practice_squad','active_roster','reserve','retired','other_league')),
  global_school_id     text references football.school(global_school_id),
  global_college_team_id text references football.college_team(global_college_team_id),
  league_id            text references football.league(league_id),
  global_football_team_identity_id text references football.team_identity(global_football_team_identity_id),
  effective_from       date,
  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

create table football.college_enrollment (
  global_football_player_id text not null references football.player(global_football_player_id),
  global_college_team_id text not null references football.college_team(global_college_team_id),
  first_season         int not null,
  last_season          int,
  arrival              text check (arrival in ('high_school','transfer','junior_college','walk_on','international','unknown')),
  redshirt_seasons     int[],
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null,
  primary key (global_football_player_id, global_college_team_id, first_season)
);

create table football.combine_measurement (
  global_football_player_id text not null references football.player(global_football_player_id),
  event                text not null check (event in ('nfl_scouting_combine','pro_day','regional_combine','other')),
  event_date           date,
  host                 text,                           -- school for pro days
  measurement          text not null,                  -- 'forty_yard_dash','vertical_in','bench_reps',...
  value                numeric not null,
  unit                 text not null,
  timing_method        text check (timing_method in ('electronic','hand','unofficial','unknown')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

-- ---------------------------------------------------------------- draft
create table football.draft (
  draft_id             text primary key,
  league_id            text not null references football.league(league_id),
  draft_year           int not null,
  kind                 text not null check (kind in ('annual','supplemental','common_draft','dispersal','expansion','allocation')),
  held_from            date,
  held_to              date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.draft_pick_asset (               -- the pick as a tradable asset, before and after use
  draft_pick_asset_id  text primary key,
  draft_id             text not null references football.draft(draft_id),
  round                int not null,
  original_franchise_id text references football.franchise(global_football_franchise_id),
  compensatory         boolean not null default false,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.draft_selection (
  draft_selection_id   text primary key,
  draft_id             text not null references football.draft(draft_id),
  draft_pick_asset_id  text references football.draft_pick_asset(draft_pick_asset_id),
  round                int not null,
  pick_in_round        int,
  overall_pick         int,
  selecting_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  global_football_player_id text references football.player(global_football_player_id), -- null only while unresolved
  source_player_name   text not null,                  -- verbatim as listed
  source_position_label text,
  source_college_label text,
  global_college_team_id text references football.college_team(global_college_team_id),
  forfeited            boolean not null default false,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  unique (draft_id, overall_pick)
);

-- ---------------------------------------------------------------- transactions
create table football.transaction (
  transaction_id       text primary key,
  kind                 text not null check (kind in
                         ('signed','signed_undrafted','signed_futures','re_signed','released','waived','claimed_off_waivers',
                          'traded','activated','placed_injured_reserve','designated_to_return','placed_pup','placed_nfi',
                          'suspended','reinstated','signed_practice_squad','released_practice_squad','elevated','reverted',
                          'placed_reserve_retired','retired','unretired','other')),
  global_football_team_identity_id text references football.team_identity(global_football_team_identity_id),
  effective_on         date not null,                  -- when it took effect
  announced_at         timestamptz,                    -- when it was made public
  observed_at          timestamptz not null,           -- when our source recorded it
  source_description   text,                           -- verbatim
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.transaction_asset (
  transaction_id       text not null references football.transaction(transaction_id),
  asset_kind           text not null check (asset_kind in ('player','draft_pick','cash','rights','conditional')),
  global_football_player_id text references football.player(global_football_player_id),
  draft_pick_asset_id  text references football.draft_pick_asset(draft_pick_asset_id),
  from_team_identity_id text references football.team_identity(global_football_team_identity_id),
  to_team_identity_id  text references football.team_identity(global_football_team_identity_id),
  conditions           text
);

-- Membership and status over time; reconstructable for any date. Derived from
-- transactions where those exist, or directly from dated roster snapshots.
create table football.roster_status_period (
  global_football_player_id text not null references football.player(global_football_player_id),
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  status               text not null check (status in
                         ('active','inactive_gameday','injured_reserve','designated_to_return','pup','nfi','suspended',
                          'practice_squad','practice_squad_injured','reserve_futures','exempt','reserve_other','unsigned_draft_pick')),
  effective_from       date not null,
  effective_to         date,
  basis                text not null check (basis in ('transaction','roster_snapshot','official_list')),
  basis_ids            text[],                         -- transaction ids / snapshot ids
  observed_at          timestamptz not null,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

-- ---------------------------------------------------------------- depth charts
create table football.depth_chart_snapshot (
  depth_chart_snapshot_id text primary key,
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  as_of                timestamptz not null,
  game_id              text,                           -- if tied to a specific game week
  officialness         text not null check (officialness in ('team_published','league_published','third_party_charted','derived')),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);
create table football.depth_chart_entry (
  depth_chart_snapshot_id text not null references football.depth_chart_snapshot(depth_chart_snapshot_id),
  unit                 text not null check (unit in ('offense','defense','special_teams')),
  slot_label           text not null,                  -- verbatim ('LWR','SLB','KR')
  canonical_code       text,
  depth_rank           int not null,
  global_football_player_id text not null references football.player(global_football_player_id),
  primary key (depth_chart_snapshot_id, unit, slot_label, depth_rank)
);

-- ---------------------------------------------------------------- coaching
create table football.coaching_tenure (
  coaching_tenure_id   text primary key,
  global_football_coach_id text not null references football.coach(global_football_coach_id),
  global_football_team_identity_id text references football.team_identity(global_football_team_identity_id),
  global_college_team_id text references football.college_team(global_college_team_id),
  role                 text not null,                  -- verbatim title
  role_class           text not null check (role_class in ('head_coach','interim_head_coach','offensive_coordinator','defensive_coordinator','special_teams_coordinator','position_coach','other_staff')),
  play_caller          boolean,                        -- only when a source establishes it
  effective_from       date,                           -- unknown start stays unknown

  effective_to         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);

-- ---------------------------------------------------------------- injuries / availability
-- Publicly reported competition availability only. No diagnosis beyond the
-- report's own words; body_area_reported is verbatim.
create table football.availability_report (
  availability_report_id text primary key,
  global_football_player_id text not null references football.player(global_football_player_id),
  global_football_team_identity_id text not null references football.team_identity(global_football_team_identity_id),
  game_id              text,
  report_date          date not null,
  report_kind          text not null check (report_kind in ('practice_participation','game_status','inactive_list','reserve_list','in_game_update')),
  practice_participation text check (practice_participation in ('full','limited','did_not_participate','not_listed')),
  game_status          text check (game_status in ('questionable','doubtful','out','probable','none')), -- 'probable' pre-2016 only
  body_area_reported   text,
  body_area_normalized text,                           -- coarse area only ('knee','ankle','concussion_protocol','illness','not_injury_related',...)
  published_at         timestamptz,
  observed_at          timestamptz not null,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);

-- ---------------------------------------------------------------- awards
create table football.award (
  award_id             text primary key,
  name                 text not null,                  -- 'AP Most Valuable Player', 'All-Pro (AP) First Team'
  selector             text not null,                  -- selecting body; different selectors are different awards
  league_id            text references football.league(league_id),
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
create table football.award_result (
  award_id             text not null references football.award(award_id),
  season_id            text references football.season(season_id),
  global_football_person_id text not null references football.person(global_football_person_id),
  finish               text not null,                  -- 'winner','1st_team','2nd_team','finalist', vote rank
  position_label       text,
  votes                numeric,
  announced_on         date,
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id)
);
