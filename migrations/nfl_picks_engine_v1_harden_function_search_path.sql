-- PropBetEdge NFL Picks Engine v1 — function hardening
-- Applied to production after the initial picks-engine migration.
-- Keeps the database schema reproducible and resolves Supabase's
-- function_search_path_mutable security advisory for the two trigger functions.

alter function public.nfl_game_picks_freeze_issuance()
  set search_path = pg_catalog, public;

alter function public.nfl_game_picks_require_trained_for_official()
  set search_path = pg_catalog, public;
