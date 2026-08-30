-- PropBetEdge NFL Picks Engine v2 — canonical pick attribution
--
-- ADDITIVE. nfl_picks_engine_v1.sql and its search_path hardening are already
-- applied in production; this migration only adds to them.
--
-- Why: nfl_odds_snapshots records team / over_under / is_home, but
-- nfl_game_picks did not, so grading had to infer the selected side from the
-- display string ("SEA -2.5"). That is unsafe twice over — a missing field
-- silently graded as HOME, and a moved line changes the string, so closing
-- snapshots could attach to the wrong side. Attribution is now persisted at
-- issuance and frozen.

begin;

-- ---------------------------------------------------------------------------
-- 1. Immutable issuance attribution
-- ---------------------------------------------------------------------------
alter table public.nfl_game_picks
  add column if not exists selection_team text;
alter table public.nfl_game_picks
  add column if not exists selection_over_under text;
alter table public.nfl_game_picks
  add column if not exists side_is_home boolean;

alter table public.nfl_game_picks
  drop constraint if exists nfl_game_picks_selection_attribution;
alter table public.nfl_game_picks
  add constraint nfl_game_picks_selection_attribution check (
    (market in ('spread','moneyline')
       and selection_team is not null
       and side_is_home is not null
       and selection_over_under is null)
    or
    (market = 'total'
       and selection_team is null
       and side_is_home is null
       and selection_over_under in ('OVER','UNDER'))
  );

-- ---------------------------------------------------------------------------
-- 2. Extend the issuance freeze to cover attribution.
--    Replaces the v1 function body; the trigger itself is unchanged.
--    search_path stays pinned (see nfl_picks_engine_v1_harden_function_search_path).
-- ---------------------------------------------------------------------------
create or replace function public.nfl_game_picks_freeze_issuance()
returns trigger
language plpgsql
as $$
begin
  if new.publication_scope is distinct from old.publication_scope then
    raise exception
      'publication_scope is immutable after issuance (% -> %) on pick %',
      old.publication_scope, new.publication_scope, old.id;
  end if;

  if new.side                 is distinct from old.side
     or new.market            is distinct from old.market
     or new.market_line       is distinct from old.market_line
     or new.market_price      is distinct from old.market_price
     or new.market_prob       is distinct from old.market_prob
     or new.model_prob        is distinct from old.model_prob
     or new.model_line        is distinct from old.model_line
     or new.edge_pct          is distinct from old.edge_pct
     or new.stake_units       is distinct from old.stake_units
     or new.model_version     is distinct from old.model_version
     or new.features::text    is distinct from old.features::text
     or new.selection_team       is distinct from old.selection_team
     or new.selection_over_under is distinct from old.selection_over_under
     or new.side_is_home         is distinct from old.side_is_home
  then
    raise exception 'issued pick terms are immutable on pick %', old.id;
  end if;

  return new;
end
$$;

alter function public.nfl_game_picks_freeze_issuance()
  set search_path = pg_catalog, public;

-- ---------------------------------------------------------------------------
-- 3. Atomic side-flip replacement.
--
-- one_open_pick_per_market is a partial unique index on (game_id, market)
-- where status='open'. Inserting the replacement BEFORE superseding the
-- incumbent violates it. This function supersedes first and inserts second
-- inside a single transaction, so the index never sees two open rows and a
-- failure leaves the incumbent untouched.
-- ---------------------------------------------------------------------------
create or replace function public.nfl_replace_open_pick(
  p_open_id              uuid,
  p_game_id              text,
  p_season               int,
  p_week                 int,
  p_kickoff_ts           timestamptz,
  p_market               text,
  p_side                 text,
  p_market_line          numeric,
  p_market_price         int,
  p_model_line           numeric,
  p_model_prob           numeric,
  p_market_prob          numeric,
  p_edge_pct             numeric,
  p_stake_units          numeric,
  p_confidence_bucket    text,
  p_features             jsonb,
  p_model_version        int,
  p_publication_scope    text,
  p_selection_team       text,
  p_selection_over_under text,
  p_side_is_home         boolean
)
returns uuid
language plpgsql
as $$
declare
  v_new uuid;
  v_scope text;
begin
  select publication_scope into v_scope
    from public.nfl_game_picks
   where id = p_open_id and status = 'open'
   for update;

  if v_scope is null then
    raise exception 'open pick % not found or not open', p_open_id;
  end if;

  -- A replacement may never change the publication class.
  if v_scope is distinct from p_publication_scope then
    raise exception
      'cannot replace a % pick with a % pick', v_scope, p_publication_scope;
  end if;

  update public.nfl_game_picks
     set status = 'superseded'
   where id = p_open_id;

  insert into public.nfl_game_picks (
    game_id, season, week, kickoff_ts, market, side,
    market_line, market_price, model_line, model_prob, market_prob,
    edge_pct, stake_units, confidence_bucket, features, model_version,
    publication_scope, selection_team, selection_over_under, side_is_home,
    status
  ) values (
    p_game_id, p_season, p_week, p_kickoff_ts, p_market, p_side,
    p_market_line, p_market_price, p_model_line, p_model_prob, p_market_prob,
    p_edge_pct, p_stake_units, p_confidence_bucket, p_features, p_model_version,
    p_publication_scope, p_selection_team, p_selection_over_under, p_side_is_home,
    'open'
  )
  returning id into v_new;

  update public.nfl_game_picks
     set superseded_by = v_new
   where id = p_open_id;

  return v_new;
end
$$;

alter function public.nfl_replace_open_pick(
  uuid, text, int, int, timestamptz, text, text, numeric, int, numeric,
  numeric, numeric, numeric, numeric, text, jsonb, int, text, text, text, boolean
) set search_path = pg_catalog, public;

-- ---------------------------------------------------------------------------
-- 4. Tracking-scoped audit events.
--
-- official_final_result must stay reserved for publication_scope='official'.
-- A finalized tracking decision emits tracking_final_result instead.
-- ---------------------------------------------------------------------------
alter table public.nfl_pick_audit_events
  drop constraint if exists nfl_pick_audit_events_event_type_check;
alter table public.nfl_pick_audit_events
  add constraint nfl_pick_audit_events_event_type_check check (event_type in (
    'pick_created',
    'features_locked',
    'issuance_market_state',
    'live_observation',
    'official_final_result',
    'tracking_final_result',
    'first_grade',
    'correction_regrade',
    'pick_killed',
    'pick_superseded',
    'training_run',
    'challenger_evaluation',
    'champion_promoted',
    'champion_rejected'
  ));

-- ---------------------------------------------------------------------------
-- 5. Ratings baseline at as_of_week = 0.
--
-- Week 1 needs ratings before any regular-season week has completed. A
-- prior-season-only baseline is written at as_of_week = 0 so it is always
-- outranked by a real regular-season week once one exists.
-- ---------------------------------------------------------------------------
alter table public.nfl_team_ratings
  drop constraint if exists nfl_team_ratings_as_of_week_range;
alter table public.nfl_team_ratings
  add constraint nfl_team_ratings_as_of_week_range
  check (as_of_week >= 0 and as_of_week <= 22);

commit;

-- Verify:
--
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='nfl_game_picks'
--    and column_name in ('selection_team','selection_over_under','side_is_home');
--   expect: 3 rows.
--
-- select conname from pg_constraint
--  where conname in ('nfl_game_picks_selection_attribution',
--                    'nfl_team_ratings_as_of_week_range');
--   expect: 2 rows.
--
-- select proname from pg_proc where proname='nfl_replace_open_pick';
--   expect: 1 row.
--
-- Negative check (a total may not carry a team):
-- insert into public.nfl_game_picks
--   (game_id,season,week,kickoff_ts,market,side,market_price,model_prob,
--    market_prob,edge_pct,stake_units,confidence_bucket,features,model_version,
--    selection_team,selection_over_under,side_is_home)
-- values ('x',2026,1,now(),'total','OVER 44.5',-110,0.5,0.5,0,0.5,'C',
--         '{"home":0}',1,'SEA','OVER',true);
--   expect: ERROR nfl_game_picks_selection_attribution violated.
--
-- Negative check (a spread must carry attribution):
-- insert into public.nfl_game_picks
--   (game_id,season,week,kickoff_ts,market,side,market_price,model_prob,
--    market_prob,edge_pct,stake_units,confidence_bucket,features,model_version)
-- values ('x',2026,1,now(),'spread','SEA -3',-110,0.5,0.5,0,0.5,'C','{"home":1}',1);
--   expect: ERROR nfl_game_picks_selection_attribution violated.
