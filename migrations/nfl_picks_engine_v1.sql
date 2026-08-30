-- PropBetEdge NFL — Picks Engine v1 schema
-- Project: tkmlnhmylqnttmnsnief
--
-- Additive only. Touches nothing that already exists: nfl_subscriptions,
-- public.nfl_has_pro_access() and the Stripe webhook path are untouched.
--
-- Run once in the Supabase SQL editor. Safe to re-run: every statement is
-- guarded with `if not exists`.
--
-- Tables 1-5 are the build brief's schema verbatim. Tables 6-7 are required by
-- NFL-PICKS-TRACK-RECORD-LEARNING-HANDOFF.md and cannot be expressed by the
-- brief's five tables:
--   * nfl_pick_audit_events     -- correction/regrade history; the brief's
--                                  nfl_pick_grades is one row per pick, so a
--                                  regrade would overwrite the first grade and
--                                  silently rewrite history.
--   * nfl_learning_observations -- "only finalized observations may enter
--                                  challenger training". A separate
--                                  finalized-only table makes a live or
--                                  provisional row structurally unable to
--                                  reach the tuner.

begin;

-- ---------------------------------------------------------------------------
-- 1. Official picks. Immutable decision records.
-- ---------------------------------------------------------------------------
create table if not exists public.nfl_game_picks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  game_id text not null,
  season int not null,
  week int not null,
  kickoff_ts timestamptz not null,
  market text not null check (market in ('spread','total','moneyline')),
  side text not null,
  market_line numeric,
  market_price int not null,
  model_line numeric,
  model_prob numeric not null,
  market_prob numeric not null,
  edge_pct numeric not null,
  stake_units numeric not null,
  confidence_bucket text not null check (confidence_bucket in ('A','B','C')),
  features jsonb not null,
  model_version int not null,
  -- Every persisted prediction declares what it IS at issuance.
  --   tracking : real pregame decision from a promoted-but-untrained champion.
  --              Graded and learned from, never customer-facing, never in the
  --              Verified Track Record.
  --   official : customer-facing. Only issuable while the active promoted
  --              champion is also trained.
  -- The classification is fixed at issuance and can never be changed, so a
  -- bootstrap record can never be reframed as an advertised result.
  publication_scope text not null default 'tracking'
    check (publication_scope in ('tracking','official')),
  status text not null default 'open'
    check (status in ('open','superseded','killed','graded')),
  superseded_by uuid references public.nfl_game_picks(id)
);

alter table public.nfl_game_picks
  add column if not exists publication_scope text not null default 'tracking';
alter table public.nfl_game_picks
  drop constraint if exists nfl_game_picks_publication_scope_check;
alter table public.nfl_game_picks
  add constraint nfl_game_picks_publication_scope_check
  check (publication_scope in ('tracking','official'));

create index if not exists nfl_game_picks_scope_idx
  on public.nfl_game_picks (publication_scope, status);

create index if not exists nfl_game_picks_season_week_idx
  on public.nfl_game_picks (season, week);
create index if not exists nfl_game_picks_status_idx
  on public.nfl_game_picks (status);
create unique index if not exists one_open_pick_per_market
  on public.nfl_game_picks (game_id, market) where (status = 'open');

-- The features snapshot is the tuner's only view of decision time. An empty
-- object is as useless as a null, so reject both at the database boundary.
alter table public.nfl_game_picks
  drop constraint if exists nfl_game_picks_features_not_empty;
alter table public.nfl_game_picks
  add constraint nfl_game_picks_features_not_empty
  check (jsonb_typeof(features) = 'object' and features <> '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- 1a. Issuance immutability.
--
-- Enforced in the database, not only in Worker code, so that neither a future
-- code path nor a manual SQL session can reclassify history. Two rules:
--
--   * publication_scope and the economic terms of an issued pick can never be
--     updated. A tracking row can NEVER become official. Market movement
--     produces a kill or a supersede, never an edit.
--   * an 'official' row can only be INSERTED while its own model_version is a
--     promoted champion whose weights declare trained = true.
--
-- status and superseded_by remain updatable: those are lifecycle, not terms.
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

  if new.side              is distinct from old.side
     or new.market         is distinct from old.market
     or new.market_line    is distinct from old.market_line
     or new.market_price   is distinct from old.market_price
     or new.market_prob    is distinct from old.market_prob
     or new.model_prob     is distinct from old.model_prob
     or new.model_line     is distinct from old.model_line
     or new.edge_pct       is distinct from old.edge_pct
     or new.stake_units    is distinct from old.stake_units
     or new.model_version  is distinct from old.model_version
     or new.features::text is distinct from old.features::text
  then
    raise exception 'issued pick terms are immutable on pick %', old.id;
  end if;

  return new;
end
$$;

drop trigger if exists nfl_game_picks_freeze_issuance on public.nfl_game_picks;
create trigger nfl_game_picks_freeze_issuance
  before update on public.nfl_game_picks
  for each row execute function public.nfl_game_picks_freeze_issuance();

create or replace function public.nfl_game_picks_require_trained_for_official()
returns trigger
language plpgsql
as $$
begin
  if new.publication_scope = 'official' then
    if not exists (
      select 1
        from public.nfl_model_weights w
       where w.version = new.model_version
         and w.promoted is true
         and (w.weights -> 'meta' ->> 'trained') = 'true'
    ) then
      raise exception
        'official picks require a promoted, trained champion (model_version % is not)',
        new.model_version;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists nfl_game_picks_official_requires_trained on public.nfl_game_picks;
create trigger nfl_game_picks_official_requires_trained
  before insert on public.nfl_game_picks
  for each row execute function public.nfl_game_picks_require_trained_for_official();

-- ---------------------------------------------------------------------------
-- 2. Odds snapshots. Closing capture is enforced by a partial unique index.
-- ---------------------------------------------------------------------------
-- The brief's columns, plus the provenance the handoff requires to be
-- preserved: provider outcome name, canonical selection, team identity and
-- home/away attribution. `is_home` is stored because an away selection
-- recorded as home is a launch blocker, and it must never be re-derived by
-- position later.
create table if not exists public.nfl_odds_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  game_id text not null,
  book text not null,
  market text not null,
  side text not null,
  line numeric,
  price int not null,
  is_closing boolean not null default false,
  provider_market text,
  provider_outcome_name text,
  team text,
  over_under text check (over_under in ('OVER','UNDER')),
  is_home boolean
);

-- Additive for an already-created table.
alter table public.nfl_odds_snapshots add column if not exists provider_market text;
alter table public.nfl_odds_snapshots add column if not exists provider_outcome_name text;
alter table public.nfl_odds_snapshots add column if not exists team text;
alter table public.nfl_odds_snapshots add column if not exists over_under text;
alter table public.nfl_odds_snapshots add column if not exists is_home boolean;

-- A team market must carry team identity and home/away; a total must carry
-- OVER/UNDER and neither. This makes "missing side attribution" unstorable.
alter table public.nfl_odds_snapshots
  drop constraint if exists nfl_odds_snapshots_side_attribution;
alter table public.nfl_odds_snapshots
  add constraint nfl_odds_snapshots_side_attribution check (
    (market = 'total'  and over_under is not null and team is null and is_home is null)
    or
    (market in ('spread','moneyline') and team is not null and is_home is not null
       and over_under is null)
  );

create index if not exists nfl_odds_snapshots_lookup_idx
  on public.nfl_odds_snapshots (game_id, market, captured_at);
create unique index if not exists one_closing_per_side
  on public.nfl_odds_snapshots (game_id, market, side, book) where (is_closing);

-- ---------------------------------------------------------------------------
-- 3. Grades. One current grade per pick; history lives in the audit table.
-- ---------------------------------------------------------------------------
create table if not exists public.nfl_pick_grades (
  pick_id uuid primary key references public.nfl_game_picks(id),
  graded_at timestamptz not null default now(),
  clv_points numeric,
  clv_prob numeric,
  clv_beat boolean,
  result text not null check (result in ('win','loss','push','void')),
  units_delta numeric not null,
  brier numeric
);

-- ---------------------------------------------------------------------------
-- 4. Model weight ledger. Append-only by policy; never edited or deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.nfl_model_weights (
  version int generated always as identity primary key,
  created_at timestamptz not null default now(),
  weights jsonb not null,
  trained_through_week int,
  training_rows int,
  backtest_clv_beat_pct numeric,
  backtest_brier numeric,
  backtest_units numeric,
  promoted boolean not null default false,
  promoted_at timestamptz,
  notes text
);

-- ---------------------------------------------------------------------------
-- 5. Team ratings, refreshed by the grader when a week completes.
-- ---------------------------------------------------------------------------
-- The brief's columns plus explicit availability and provenance. `status` is
-- NOT NULL with no default of convenience: a rating row must declare whether
-- it is usable. This is what stops a failed refresh from becoming a neutral 0
-- feature, because the orchestrator can distinguish "0.0 EPA/play" (a real,
-- meaningful value) from "we do not know".
create table if not exists public.nfl_team_ratings (
  team text not null,
  as_of_week int not null,
  season int not null,
  off_epa_play numeric,
  def_epa_play numeric,
  proe numeric,
  pace numeric,
  qb_tier int,
  status text not null default 'ok'
    check (status in ('ok','prior_only','stale','unavailable')),
  status_reason text,
  source text,
  source_version text,
  source_timestamp timestamptz,
  plays_sample int,
  games_sample int,
  updated_at timestamptz not null default now(),
  primary key (team, season, as_of_week)
);

-- Additive for an already-created table.
alter table public.nfl_team_ratings add column if not exists status text not null default 'ok';
alter table public.nfl_team_ratings add column if not exists status_reason text;
alter table public.nfl_team_ratings add column if not exists source text;
alter table public.nfl_team_ratings add column if not exists source_version text;
alter table public.nfl_team_ratings add column if not exists source_timestamp timestamptz;
alter table public.nfl_team_ratings add column if not exists plays_sample int;
alter table public.nfl_team_ratings add column if not exists games_sample int;

alter table public.nfl_team_ratings
  drop constraint if exists nfl_team_ratings_status_check;
alter table public.nfl_team_ratings
  add constraint nfl_team_ratings_status_check
  check (status in ('ok','prior_only','stale','unavailable'));

-- A usable rating MUST carry its metrics. This makes a half-populated "ok"
-- row unstorable rather than something the orchestrator has to defend against.
alter table public.nfl_team_ratings
  drop constraint if exists nfl_team_ratings_usable_has_metrics;
alter table public.nfl_team_ratings
  add constraint nfl_team_ratings_usable_has_metrics check (
    status not in ('ok','prior_only')
    or (off_epa_play is not null and def_epa_play is not null)
  );

-- ---------------------------------------------------------------------------
-- 6. Audit events. Append-only. This is what makes "do not silently rewrite
--    history" enforceable rather than aspirational.
-- ---------------------------------------------------------------------------
create table if not exists public.nfl_pick_audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  pick_id uuid references public.nfl_game_picks(id),
  event_type text not null check (event_type in (
    'pick_created',
    'features_locked',
    'issuance_market_state',
    'live_observation',
    'official_final_result',
    'first_grade',
    'correction_regrade',
    'pick_killed',
    'pick_superseded',
    'training_run',
    'challenger_evaluation',
    'champion_promoted',
    'champion_rejected'
  )),
  model_version int,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists nfl_pick_audit_events_pick_idx
  on public.nfl_pick_audit_events (pick_id, occurred_at);
create index if not exists nfl_pick_audit_events_type_idx
  on public.nfl_pick_audit_events (event_type, occurred_at);

-- ---------------------------------------------------------------------------
-- 7. Finalized learning observations. The tuner reads ONLY this table.
--    is_final is forced true so a provisional row cannot exist at all.
-- ---------------------------------------------------------------------------
create table if not exists public.nfl_learning_observations (
  pick_id uuid primary key references public.nfl_game_picks(id),
  finalized_at timestamptz not null default now(),
  season int not null,
  week int not null,
  market text not null,
  features jsonb not null,
  model_version int not null,
  model_prob numeric not null,
  clv_beat boolean,
  clv_prob numeric,
  result text not null check (result in ('win','loss','push','void')),
  outcome int check (outcome in (0,1)),
  units_delta numeric not null,
  brier numeric,
  is_final boolean not null default true check (is_final),
  -- Carried from the pick so the tuner's sample is auditable: bootstrap
  -- tracking decisions are legitimate learning observations (they were
  -- timestamped before the outcome was known), and this records that fact
  -- rather than obscuring it.
  publication_scope text not null default 'tracking'
    check (publication_scope in ('tracking','official'))
);

alter table public.nfl_learning_observations
  add column if not exists publication_scope text not null default 'tracking';

create index if not exists nfl_learning_observations_season_week_idx
  on public.nfl_learning_observations (season, week);

-- ---------------------------------------------------------------------------
-- RLS: service-role writes only. No anon/authenticated policy is created, so
-- PostgREST exposes nothing to the browser. The frontend reads exclusively
-- through the orchestrator's endpoint and the same-origin Vercel proxy.
-- ---------------------------------------------------------------------------
alter table public.nfl_game_picks            enable row level security;
alter table public.nfl_odds_snapshots        enable row level security;
alter table public.nfl_pick_grades           enable row level security;
alter table public.nfl_model_weights         enable row level security;
alter table public.nfl_team_ratings          enable row level security;
alter table public.nfl_pick_audit_events     enable row level security;
alter table public.nfl_learning_observations enable row level security;

-- ---------------------------------------------------------------------------
-- Seed champion version 1: hand-set priors, explicitly NOT trained.
-- Inserted only when the ledger is empty, so re-running never forks the
-- champion chronology.
-- ---------------------------------------------------------------------------
insert into public.nfl_model_weights
  (weights, trained_through_week, training_rows,
   backtest_clv_beat_pct, backtest_brier, backtest_units, promoted, promoted_at, notes)
select
  jsonb_build_object(
    'intercept', 0.0,
    'coef', jsonb_build_object(
      'off_epa_diff',       1.65,
      'def_epa_diff',       1.35,
      'qb_tier_diff',       0.22,
      'rest_diff',          0.020,
      'home',               0.16,
      'dome',               0.00,
      'wind15',            -0.10,
      'cold25',            -0.06,
      'proe_diff',          0.10,
      'pace_sum',           0.006,
      'line_move',          0.075,
      'prior_blend_weight', 0.00
    ),
    'calib', jsonb_build_object('A', 1.0, 'B', 1.0, 'C', 1.0),
    'meta', jsonb_build_object(
      'source', 'hand_set_prior',
      'trained', false,
      'feature_order', jsonb_build_array(
        'off_epa_diff','def_epa_diff','qb_tier_diff','rest_diff','home','dome',
        'wind15','cold25','proe_diff','pace_sum','line_move','prior_blend_weight'
      )
    )
  ),
  null, 0, null, null, null, true, now(),
  'v1 priors, not trained'
where not exists (select 1 from public.nfl_model_weights);

commit;

-- Verify:
--
-- select table_name from information_schema.tables
-- where table_schema='public' and table_name like 'nfl_%'
-- order by table_name;
--   expect: nfl_game_picks, nfl_learning_observations, nfl_model_weights,
--           nfl_odds_snapshots, nfl_pick_audit_events, nfl_pick_grades,
--           nfl_subscriptions, nfl_team_ratings
--
-- select indexname from pg_indexes
-- where tablename in ('nfl_game_picks','nfl_odds_snapshots')
--   and indexname in ('one_open_pick_per_market','one_closing_per_side');
--   expect: 2 rows.
--
-- select version, promoted, notes, weights->'meta'->>'trained' as trained
-- from public.nfl_model_weights order by version;
--   expect: exactly one row, version 1, promoted true, trained "false".
--
-- select relname, relrowsecurity from pg_class
-- where relname like 'nfl_%' and relkind='r';
--   expect: relrowsecurity true for all seven picks-engine tables.
--
-- Negative check (features guard):
-- insert into public.nfl_game_picks
--   (game_id,season,week,kickoff_ts,market,side,market_price,model_prob,
--    market_prob,edge_pct,stake_units,confidence_bucket,features,model_version)
-- values ('x',2026,1,now(),'spread','X -1',-110,0.5,0.5,0,0.5,'C','{}',1);
--   expect: ERROR nfl_game_picks_features_not_empty violated.
--
-- Negative check (official requires a trained champion) — with only the seeded
-- untrained v1 present this MUST fail:
-- insert into public.nfl_game_picks
--   (game_id,season,week,kickoff_ts,market,side,market_price,model_prob,
--    market_prob,edge_pct,stake_units,confidence_bucket,features,model_version,
--    publication_scope)
-- values ('x',2026,1,now(),'spread','X -1',-110,0.5,0.5,0,0.5,'C',
--         '{"home":1}',1,'official');
--   expect: ERROR official picks require a promoted, trained champion
--
-- Positive check (tracking IS allowed from the untrained champion):
-- insert into public.nfl_game_picks
--   (game_id,season,week,kickoff_ts,market,side,market_price,model_prob,
--    market_prob,edge_pct,stake_units,confidence_bucket,features,model_version,
--    publication_scope)
-- values ('verify-tracking',2026,1,now(),'spread','X -1',-110,0.5,0.5,0,0.5,'C',
--         '{"home":1}',1,'tracking')
-- returning id;
--   expect: one row.
--
-- Negative check (tracking can never be reclassified as official):
-- update public.nfl_game_picks
--    set publication_scope='official'
--  where game_id='verify-tracking';
--   expect: ERROR publication_scope is immutable after issuance
--
-- Negative check (issued terms are frozen):
-- update public.nfl_game_picks set market_line=-7 where game_id='verify-tracking';
--   expect: ERROR issued pick terms are immutable
--
-- Lifecycle IS still allowed:
-- update public.nfl_game_picks set status='killed' where game_id='verify-tracking';
--   expect: UPDATE 1
--
-- Clean up the verification row:
-- delete from public.nfl_game_picks where game_id='verify-tracking';
--   expect: DELETE 1  (production tables must contain no fixture rows)
--
-- select publication_scope, count(*) from public.nfl_game_picks
-- group by publication_scope;
--   expect after deploy: official 0; tracking >= 0.
