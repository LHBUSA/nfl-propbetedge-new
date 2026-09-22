-- ROLLBACK for nfl_td_targets_binary_market_v1.sql.
--
-- Restores nfl_prop_picks to exactly the shape nfl_prop_picks_engine_v1.sql
-- created, and removes everything the touchdown lane added. The passing-yards
-- engine is untouched by both the migration and this rollback.
--
-- IT REFUSES RATHER THAN DESTROYS. Re-imposing the v1 NOT NULLs is impossible
-- while a binary row exists, and a published touchdown target is a real
-- prediction with a real receipt in the append-only chain. This script
-- therefore aborts if any touchdown row has been issued. Removing published
-- targets is a separate, deliberate decision and is not automated here.
--
-- Before running: capture the current state.
--   select count(*) from public.nfl_prop_picks where target_rank is not null;
--   select count(*) from public.nfl_td_slate_evaluations;

begin;

do $$
declare
  v_targets integer;
  v_evaluations integer;
begin
  select count(*) into v_targets from public.nfl_prop_picks
   where public.nfl_prop_market_is_binary(market);
  select count(*) into v_evaluations from public.nfl_td_slate_evaluations;
  if v_targets > 0 then
    raise exception
      'refusing to roll back: % touchdown target(s) are published, each with a receipt in the append-only chain. '
      'Removing them is a separate decision and is not automated here.', v_targets;
  end if;
  if v_evaluations > 0 then
    raise notice '% slate evaluation row(s) will be dropped with the table', v_evaluations;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The touchdown-only structures.
-- ---------------------------------------------------------------------------
drop view if exists public.nfl_td_final_pregame_evaluation;
drop trigger if exists nfl_td_eval_no_mutation on public.nfl_td_slate_evaluations;
drop table if exists public.nfl_td_slate_evaluations;
drop function if exists public.nfl_td_eval_no_mutation();

drop function if exists public.nfl_replace_open_td_target(
  uuid,text,integer,integer,timestamptz,text,text,text,text,text,text,
  integer,integer,numeric,numeric,numeric,numeric,numeric,text,
  text,bigint,text,text,text,jsonb
);

drop trigger if exists nfl_td_picks_no_withdrawal_after_kickoff on public.nfl_prop_picks;
drop function if exists public.nfl_td_no_withdrawal_after_kickoff();

drop index if exists public.nfl_td_one_open_target_rank_per_event;

-- The seeded touchdown champion. Safe: the guard above proved it has issued
-- nothing, so no pick row references this version.
delete from public.nfl_prop_selector_models
 where market = 'player_anytime_td'
   and not exists (
     select 1 from public.nfl_prop_picks p
      where p.selector_version = nfl_prop_selector_models.version
   );

-- ---------------------------------------------------------------------------
-- nfl_prop_picks back to the v1 shape.
-- ---------------------------------------------------------------------------
alter table public.nfl_prop_picks
  drop constraint if exists nfl_prop_pick_continuous_projection,
  drop constraint if exists nfl_prop_pick_binary_contract,
  drop constraint if exists nfl_prop_pick_target_rank,
  drop constraint if exists nfl_prop_pick_binary_issued_pregame;

alter table public.nfl_prop_picks drop column if exists target_rank;

alter table public.nfl_prop_picks
  alter column model_fair_line set not null,
  alter column predictive_sd set not null;

alter table public.nfl_prop_picks
  add constraint nfl_prop_pick_team_market_line check (market_line is not null);

alter table public.nfl_prop_pick_grades
  drop constraint if exists nfl_prop_grade_settlement_note_object;
alter table public.nfl_prop_pick_grades
  drop column if exists result_definition,
  drop column if exists non_offensive_td,
  drop column if exists settlement_note;

-- ---------------------------------------------------------------------------
-- The two shared functions, restored to their v1 bodies verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.nfl_prop_freeze_issuance()
returns trigger
language plpgsql
as $$
begin
  if row(
    old.event_id, old.season, old.week, old.kickoff_ts,
    old.player_name, old.player_key, old.market, old.side,
    old.book, old.book_key, old.market_line, old.market_price, old.opposite_price,
    old.model_fair_line, old.predictive_sd, old.model_prob, old.market_prob,
    old.edge_pct, old.ev_pct, old.stake_units, old.confidence_bucket,
    old.projection_model_version, old.selector_version, old.phase,
    old.publication_scope, old.model_snapshot, old.created_at
  ) is distinct from row(
    new.event_id, new.season, new.week, new.kickoff_ts,
    new.player_name, new.player_key, new.market, new.side,
    new.book, new.book_key, new.market_line, new.market_price, new.opposite_price,
    new.model_fair_line, new.predictive_sd, new.model_prob, new.market_prob,
    new.edge_pct, new.ev_pct, new.stake_units, new.confidence_bucket,
    new.projection_model_version, new.selector_version, new.phase,
    new.publication_scope, new.model_snapshot, new.created_at
  ) then
    raise exception 'nfl_prop_picks issuance fields are immutable';
  end if;
  return new;
end
$$;

alter function public.nfl_prop_freeze_issuance()
  set search_path = pg_catalog, public;

create or replace function public.nfl_prop_receipt_after_insert()
returns trigger
language plpgsql
as $$
declare
  v_payload jsonb;
  v_payload_hash text;
  v_prev_hash text;
  v_chain_hash text;
begin
  perform pg_advisory_xact_lock(hashtext('nfl_prop_pick_receipts_v1'));

  v_payload := jsonb_build_object(
    'pick_id', new.id,
    'issued_at', new.created_at,
    'event_id', new.event_id,
    'season', new.season,
    'week', new.week,
    'kickoff_ts', new.kickoff_ts,
    'player_name', new.player_name,
    'player_key', new.player_key,
    'market', new.market,
    'side', new.side,
    'book', new.book,
    'book_key', new.book_key,
    'market_line', new.market_line,
    'market_price', new.market_price,
    'opposite_price', new.opposite_price,
    'model_fair_line', new.model_fair_line,
    'predictive_sd', new.predictive_sd,
    'model_prob', new.model_prob,
    'market_prob', new.market_prob,
    'edge_pct', new.edge_pct,
    'ev_pct', new.ev_pct,
    'stake_units', new.stake_units,
    'confidence_bucket', new.confidence_bucket,
    'projection_model_version', new.projection_model_version,
    'selector_version', new.selector_version,
    'phase', new.phase,
    'publication_scope', new.publication_scope,
    'model_snapshot', new.model_snapshot
  );

  v_payload_hash := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  select r.chain_hash into v_prev_hash
    from public.nfl_prop_pick_receipts r
   order by r.seq desc
   limit 1;

  v_chain_hash := encode(
    extensions.digest(
      convert_to(
        coalesce(v_prev_hash, 'GENESIS') || ':' ||
        v_payload_hash || ':' || new.created_at::text || ':' || new.id::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.nfl_prop_pick_receipts (
    pick_id, issued_at, publication_scope, receipt_version,
    payload, payload_sha256, previous_chain_hash, chain_hash
  ) values (
    new.id, new.created_at, new.publication_scope, 'pbe-prop-issuance-v1',
    v_payload, v_payload_hash, v_prev_hash, v_chain_hash
  );
  return new;
end
$$;

alter function public.nfl_prop_receipt_after_insert()
  set search_path = pg_catalog, public, extensions;

drop function if exists public.nfl_prop_market_is_binary(text);

commit;
