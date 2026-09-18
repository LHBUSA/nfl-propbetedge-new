-- 005_championships.sql
-- source: schema/005_championships.sql
-- Generated; apply with history/deploy/apply.mjs, never by hand-editing this file.

-- PropBetEdge football history graph — 005 championship results
-- STATUS: DESIGN. NOT APPLIED ANYWHERE.
--
-- A championship is sometimes known as a RESULT before it is known as a GAME.
-- Wikidata (CC0) records the winner, date and venue of all 64 Super Bowl items
-- but names the two participants in none of them (measured 2026-09-18), so the
-- game row those facts would need cannot be built honestly. This table holds
-- what is actually known; when a licensed game record arrives, the game is
-- linked and the runner-up filled in.

create table football.championship_result (
  championship_result_id text primary key,
  competition_id       text not null references football.competition(competition_id),
  league_id            text not null references football.league(league_id),
  season_id            text references football.season(season_id),
  name                 text not null,                  -- 'Super Bowl LVIII'
  decided_on           date,
  winning_franchise_id text references football.franchise(global_football_franchise_id),
  winning_team_identity_id text references football.team_identity(global_football_team_identity_id),
  runner_up_franchise_id   text references football.franchise(global_football_franchise_id),
  global_venue_id      text references football.venue(global_venue_id),
  venue_name_as_played text,
  global_football_game_id text,                        -- set once a game record exists
  source_snapshot_id   text not null references football_src.source_snapshot(source_snapshot_id),
  observed_at          timestamptz not null
);
