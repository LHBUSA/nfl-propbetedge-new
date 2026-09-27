-- PropBetEdge NFL — PBE Touchdown Target LIVE HIT events.
--
-- ADDITIVE. Creates one new table and its guards. Nothing here reads, alters
-- or references a row of any existing table except through the foreign key
-- (pick_id -> nfl_prop_picks.id, ON DELETE RESTRICT), which only ever
-- constrains a DELETE of a target that has a hit event.
--
-- WHAT A ROW IS
-- One row = one locked Touchdown Target that the live box score credits with a
-- rushing or receiving touchdown (the final grader's own definition, read by
-- the same function), observed on a scoring play that was FRESH (<= 5 minutes
-- old) when nfl-touchdown-targets-hit-alerts saw it. It is a live observation,
-- not a grade: nfl_prop_pick_grades remains the only settlement, written only
-- by nfl-touchdown-targets-grader from the FINAL box score.
--
-- ONE WRITER. Only the Cloudflare Worker nfl-touchdown-target-hit-alerts
-- writes here, with service_role. Browsers read the public projection through
-- /api/pbe-touchdown-targets?view=hits and never write.
--
-- ATOMIC DEDUPE. UNIQUE (pick_id): once an anytime-TD target has connected it
-- has connected; a second touchdown by the same player is not a second event.
-- Primary and secondary are different pick ids, so each may connect once. The
-- Worker inserts with ON CONFLICT (pick_id) DO NOTHING, so the database — not
-- isolate memory — is the correctness boundary.
--
-- APPEND-ONLY. UPDATE, DELETE and TRUNCATE are refused by trigger.

create table if not exists public.nfl_td_target_hit_events (
  id bigint generated always as identity primary key,

  pick_id uuid not null references public.nfl_prop_picks(id) on delete restrict,
  market text not null check (market = 'player_anytime_td'),

  event_id text not null,
  espn_id text not null check (espn_id ~ '^[0-9]{6,12}$'),

  season integer not null,
  week integer not null,
  kickoff_ts timestamptz not null,

  player_name text not null,
  player_key text not null,
  espn_player_id text,
  gsis_id text,
  position text,

  team text,
  opponent text,

  target_rank text not null check (target_rank in ('primary', 'secondary')),
  publication_scope text not null check (publication_scope in ('tracking', 'official')),

  model_prob numeric,
  market_price integer,
  confidence_bucket text,

  play_id text,
  play_type text,
  play_text text,
  period integer,
  clock text,
  play_wallclock timestamptz,

  away_team text,
  home_team text,
  away_score integer,
  home_score integer,

  headshot_url text,

  live_stats jsonb not null default '{}'::jsonb,
  source jsonb not null default '{}'::jsonb,

  detected_at timestamptz not null default clock_timestamp(),

  constraint nfl_td_target_hit_events_pick_unique unique (pick_id)
);

comment on table public.nfl_td_target_hit_events is
  'Append-only LIVE touchdown-target hit observations. One per pick. Written only by the '
  'nfl-touchdown-target-hit-alerts Worker (service_role). Not a grade: settlement stays in '
  'nfl_prop_pick_grades, written by nfl-touchdown-targets-grader from the final box score.';

-- The public read is "hits detected after <cursor>", newest window only.
create index if not exists nfl_td_target_hit_events_detected_idx
  on public.nfl_td_target_hit_events (detected_at);

create or replace function public.nfl_td_target_hit_events_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'nfl_td_target_hit_events is append-only (% refused)', tg_op
    using errcode = 'P0001';
end;
$$;

drop trigger if exists nfl_td_target_hit_events_no_update_delete on public.nfl_td_target_hit_events;
create trigger nfl_td_target_hit_events_no_update_delete
  before update or delete on public.nfl_td_target_hit_events
  for each row execute function public.nfl_td_target_hit_events_append_only();

drop trigger if exists nfl_td_target_hit_events_no_truncate on public.nfl_td_target_hit_events;
create trigger nfl_td_target_hit_events_no_truncate
  before truncate on public.nfl_td_target_hit_events
  for each statement execute function public.nfl_td_target_hit_events_append_only();

-- RLS on, no policy for anon/authenticated: they can neither read nor write
-- the table directly. service_role bypasses RLS.
alter table public.nfl_td_target_hit_events enable row level security;

-- Supabase grants table privileges to anon and authenticated by default, and a
-- revoke from PUBLIC does not remove those role grants (measured on the TD
-- replacement RPC, 2026-09-26). Revoke from the roles by name.
-- service_role keeps only what the one writer and the one reader need; the
-- append-only trigger still refuses UPDATE/DELETE for any role that has them.
revoke all on table public.nfl_td_target_hit_events from public, anon, authenticated, service_role;
grant select, insert on table public.nfl_td_target_hit_events to service_role;

revoke all on function public.nfl_td_target_hit_events_append_only() from public, anon, authenticated;

-- Verification (expected: f, f, f, f, t, t, f, f):
-- select has_table_privilege('anon', 'public.nfl_td_target_hit_events', 'select'),
--        has_table_privilege('anon', 'public.nfl_td_target_hit_events', 'insert'),
--        has_table_privilege('authenticated', 'public.nfl_td_target_hit_events', 'select'),
--        has_table_privilege('authenticated', 'public.nfl_td_target_hit_events', 'insert'),
--        has_table_privilege('service_role', 'public.nfl_td_target_hit_events', 'select'),
--        has_table_privilege('service_role', 'public.nfl_td_target_hit_events', 'insert'),
--        has_table_privilege('service_role', 'public.nfl_td_target_hit_events', 'update'),
--        has_table_privilege('service_role', 'public.nfl_td_target_hit_events', 'delete');
