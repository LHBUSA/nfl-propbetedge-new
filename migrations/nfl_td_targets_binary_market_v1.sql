-- PropBetEdge NFL — PBE Touchdown Targets: binary-market support, additively.
--
-- WHY THIS MIGRATION EXISTS
-- nfl_prop_picks_engine_v1.sql was written around a continuous projection: a
-- market line, a fair line and a predictive standard deviation, all NOT NULL.
-- Anytime touchdown is a binary market. It has no line, no fair line and no
-- predictive spread, and the only honest way to store one in that table would
-- otherwise be to write market_line = 0.5 and predictive_sd = 1 — numbers that
-- mean nothing, in columns a later reader would trust.
--
-- So the continuous requirement becomes conditional on the market, and the
-- binary contract gets requirements of its own. Nothing is relaxed for
-- player_pass_yds: every field it was required to carry, it still carries,
-- enforced by the same table.
--
-- WHAT IS REUSED AND WHAT IS NEW
-- Reused, because it is market-neutral and already hardened: immutable
-- issuance, the append-only SHA-256 receipt chain, the audit ledger, the
-- publication scope, the grade table, the finalized learning observations, the
-- closing tape, and the one-promoted-selector-per-market index that makes
-- governance market-scoped. A passing-yards selector can never become the
-- touchdown champion and a touchdown selector can never touch passing yards,
-- because promotion is keyed on `market` and always was.
--
-- New, because it is genuinely a different product rule:
--   * target_rank            PRIMARY or SECONDARY, so the primary record stays
--                            separately measurable and a game can never have
--                            two primaries;
--   * nfl_td_slate_evaluations  every evaluated game's outcome, including the
--                            games where the model abstained, so no game is
--                            ever silently missing from the record;
--   * a pregame-issuance check and a no-withdrawal-after-kickoff guard, so
--     "locked before kickoff" is a database invariant and not just a code path.
--
-- Invariants this migration adds:
--   * a binary-market pick carries YES/NO, a market probability and a model
--     probability, and carries NO continuous-projection fields at all;
--   * a binary-market pick is issued strictly before kickoff;
--   * a binary-market pick can never be withdrawn after kickoff;
--   * exactly one open PRIMARY and at most one open SECONDARY per event;
--   * every issued target and every abstention is attributable to the exact
--     selector version that decided it.
--
-- RLS stays enabled with no anon policies. Service role only.

begin;

-- ---------------------------------------------------------------------------
-- Which markets are binary. A function rather than a repeated IN list so the
-- five constraints below cannot drift apart. IMMUTABLE because a CHECK
-- constraint may only call an immutable function.
-- ---------------------------------------------------------------------------
create or replace function public.nfl_prop_market_is_binary(p_market text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_market in ('player_anytime_td', 'player_1st_td')
$$;

alter function public.nfl_prop_market_is_binary(text)
  set search_path = pg_catalog, public;

comment on function public.nfl_prop_market_is_binary(text) is
  'A market settled YES/NO on an event, with no line to beat. Binary markets '
  'must not carry market_line, model_fair_line or predictive_sd.';

-- ---------------------------------------------------------------------------
-- Relax the continuous-projection requirement to the markets that have one.
-- ---------------------------------------------------------------------------
alter table public.nfl_prop_picks
  drop constraint if exists nfl_prop_pick_team_market_line;

alter table public.nfl_prop_picks
  alter column model_fair_line drop not null,
  alter column predictive_sd drop not null;

-- A NULL never fails a CHECK, so the surviving `predictive_sd > 0` column check
-- is satisfied by a binary row and still binds a continuous one.

alter table public.nfl_prop_picks
  add constraint nfl_prop_pick_continuous_projection check (
    public.nfl_prop_market_is_binary(market)
    or (
      market_line is not null
      and model_fair_line is not null
      and predictive_sd is not null
      and predictive_sd > 0
    )
  );

alter table public.nfl_prop_picks
  add constraint nfl_prop_pick_binary_contract check (
    not public.nfl_prop_market_is_binary(market)
    or (
      side in ('YES', 'NO')
      and model_prob is not null
      and market_prob is not null
      and market_line is null
      and model_fair_line is null
      and predictive_sd is null
    )
  );

-- ---------------------------------------------------------------------------
-- PRIMARY / SECONDARY. Binary-market rows must declare which they are;
-- continuous rows must not, so nothing about passing yards changes shape.
-- ---------------------------------------------------------------------------
alter table public.nfl_prop_picks
  add column if not exists target_rank text;

alter table public.nfl_prop_picks
  add constraint nfl_prop_pick_target_rank check (
    case
      when public.nfl_prop_market_is_binary(market) then target_rank in ('primary', 'secondary')
      else target_rank is null
    end
  );

comment on column public.nfl_prop_picks.target_rank is
  'Binary markets only. PRIMARY is the one player PBE names for the game; '
  'SECONDARY is an optional second target held to a higher standard. The '
  'primary record is reported separately so it is never inflated by secondaries.';

-- One open PRIMARY and one open SECONDARY per event. This is the index that
-- makes "a game never produces two primary targets" impossible rather than
-- merely unlikely.
create unique index if not exists nfl_td_one_open_target_rank_per_event
  on public.nfl_prop_picks (event_id, market, target_rank)
  where status = 'open' and target_rank is not null;

-- ---------------------------------------------------------------------------
-- Locked before kickoff, and never moved afterwards.
--
-- created_at is frozen by the issuance trigger, so a row that satisfies this
-- check on insert satisfies it forever: the issuance timestamp of a published
-- target is evidence, not a mutable field.
-- ---------------------------------------------------------------------------
alter table public.nfl_prop_picks
  add constraint nfl_prop_pick_binary_issued_pregame check (
    not public.nfl_prop_market_is_binary(market) or created_at < kickoff_ts
  );

create or replace function public.nfl_td_no_withdrawal_after_kickoff()
returns trigger
language plpgsql
as $$
begin
  if not public.nfl_prop_market_is_binary(new.market) then
    return new;
  end if;
  if new.status = old.status then
    return new;
  end if;
  -- Grading is the one status change a kicked-off game is allowed to make.
  if now() >= new.kickoff_ts and new.status in ('killed', 'superseded') then
    raise exception 'a published touchdown target cannot be % after kickoff', new.status;
  end if;
  return new;
end
$$;

alter function public.nfl_td_no_withdrawal_after_kickoff()
  set search_path = pg_catalog, public;

drop trigger if exists nfl_td_picks_no_withdrawal_after_kickoff on public.nfl_prop_picks;
create trigger nfl_td_picks_no_withdrawal_after_kickoff
before update on public.nfl_prop_picks
for each row execute function public.nfl_td_no_withdrawal_after_kickoff();

-- ---------------------------------------------------------------------------
-- target_rank joins the immutable issuance set. The comparison is otherwise
-- the v1 list unchanged; a passing-yards row carries NULL here and so is
-- compared exactly as it was before.
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
    old.publication_scope, old.model_snapshot, old.created_at, old.target_rank
  ) is distinct from row(
    new.event_id, new.season, new.week, new.kickoff_ts,
    new.player_name, new.player_key, new.market, new.side,
    new.book, new.book_key, new.market_line, new.market_price, new.opposite_price,
    new.model_fair_line, new.predictive_sd, new.model_prob, new.market_prob,
    new.edge_pct, new.ev_pct, new.stake_units, new.confidence_bucket,
    new.projection_model_version, new.selector_version, new.phase,
    new.publication_scope, new.model_snapshot, new.created_at, new.target_rank
  ) then
    raise exception 'nfl_prop_picks issuance fields are immutable';
  end if;
  return new;
end
$$;

alter function public.nfl_prop_freeze_issuance()
  set search_path = pg_catalog, public;

-- ---------------------------------------------------------------------------
-- The receipt payload gains target_rank ADDITIVELY.
--
-- A passing-yards row has target_rank NULL and therefore produces byte-for-byte
-- the same payload, the same payload_sha256 and the same chain arithmetic as
-- before this migration. The existing chain stays verifiable.
-- ---------------------------------------------------------------------------
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

  if new.target_rank is not null then
    v_payload := v_payload || jsonb_build_object('target_rank', new.target_rank);
  end if;

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
    new.id, new.created_at, new.publication_scope,
    case when new.target_rank is not null then 'pbe-td-target-issuance-v1' else 'pbe-prop-issuance-v1' end,
    v_payload, v_payload_hash, v_prev_hash, v_chain_hash
  );
  return new;
end
$$;

alter function public.nfl_prop_receipt_after_insert()
  set search_path = pg_catalog, public, extensions;

-- ---------------------------------------------------------------------------
-- The grade row records the definition it was decided under, and records a
-- non-offensive touchdown when the box score shows one.
--
-- A book's anytime-touchdown rule and the PBE target definition are not
-- guaranteed to be the same thing: we hold no book's settlement rulebook, so
-- the PBE result is decided on a definition we can state exactly — a rushing
-- or receiving touchdown in the official final box score. Where the same box
-- score shows the player scored on a return or on defence, that is recorded
-- here so the divergence is visible on the row instead of being argued about
-- later. It never changes the PBE result.
-- ---------------------------------------------------------------------------
alter table public.nfl_prop_pick_grades
  add column if not exists result_definition text,
  add column if not exists non_offensive_td boolean,
  add column if not exists settlement_note jsonb;

alter table public.nfl_prop_pick_grades
  add constraint nfl_prop_grade_settlement_note_object check (
    settlement_note is null or jsonb_typeof(settlement_note) = 'object'
  );

comment on column public.nfl_prop_pick_grades.result_definition is
  'The exact rule this row was decided under. For touchdown targets: '
  'pbe_offensive_td_from_final_box_score.';
comment on column public.nfl_prop_pick_grades.non_offensive_td is
  'Observed, never decisive: the selected player scored a return or defensive '
  'touchdown in the same official box score. Recorded so a divergence from a '
  'book settlement rule is auditable.';

-- ---------------------------------------------------------------------------
-- EVERY GAME ENDS IN A RECORDED DECISION.
--
-- One append-only row per evaluation of one game. A game the model abstained
-- on has a row. A game whose sources failed has a row, with a different
-- outcome, because a broken upstream is not an opinion. The pregame window may
-- produce several rows for the same game as facts change; the last PREGAME row
-- is that game's final state, which is what the view below returns.
-- ---------------------------------------------------------------------------
create table if not exists public.nfl_td_slate_evaluations (
  id bigint generated by default as identity primary key,
  market text not null default 'player_anytime_td',
  event_id text not null,
  game_id text,
  espn_id text,
  season integer not null,
  week integer not null,
  kickoff_ts timestamptz not null,
  away_team text not null,
  home_team text not null,
  outcome text not null check (outcome in ('target_issued', 'abstained', 'degraded')),
  reason text,
  primary_pick_id uuid references public.nfl_prop_picks(id) on delete restrict,
  secondary_pick_id uuid references public.nfl_prop_picks(id) on delete restrict,
  market_selections integer not null default 0 check (market_selections >= 0),
  eligible_pool integer not null default 0 check (eligible_pool >= 0),
  top_probability numeric check (top_probability is null or (top_probability >= 0 and top_probability <= 1)),
  selector_version bigint references public.nfl_prop_selector_models(version) on delete restrict,
  publication_scope text not null check (publication_scope in ('tracking', 'official')),
  is_pregame boolean not null,
  detail jsonb not null default '{}'::jsonb,
  decided_at timestamptz not null default now(),
  constraint nfl_td_eval_detail_object check (jsonb_typeof(detail) = 'object'),
  -- is_pregame is not a claim the writer gets to make freely.
  constraint nfl_td_eval_pregame_is_true check (is_pregame = (decided_at < kickoff_ts)),
  -- An issued outcome names its target; an abstention or a degradation cannot.
  constraint nfl_td_eval_outcome_shape check (
    case outcome
      when 'target_issued' then primary_pick_id is not null and reason is null
      else primary_pick_id is null and secondary_pick_id is null and reason is not null
    end
  )
);

alter table public.nfl_td_slate_evaluations enable row level security;

create index if not exists nfl_td_eval_game_decided_idx
  on public.nfl_td_slate_evaluations (game_id, decided_at desc);
create index if not exists nfl_td_eval_season_week_idx
  on public.nfl_td_slate_evaluations (season, week, kickoff_ts);
create index if not exists nfl_td_eval_scope_idx
  on public.nfl_td_slate_evaluations (publication_scope, kickoff_ts desc);

create or replace function public.nfl_td_eval_no_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'nfl_td_slate_evaluations is append-only';
end
$$;

alter function public.nfl_td_eval_no_mutation()
  set search_path = pg_catalog, public;

drop trigger if exists nfl_td_eval_no_mutation on public.nfl_td_slate_evaluations;
create trigger nfl_td_eval_no_mutation
before update or delete on public.nfl_td_slate_evaluations
for each row execute function public.nfl_td_eval_no_mutation();

-- The final pregame state of every game the engine has evaluated. One row per
-- game: PRIMARY TARGET, MODEL ABSTAIN or SOURCE DEGRADED, and never silence.
create or replace view public.nfl_td_final_pregame_evaluation
with (security_invoker = true) as
select distinct on (game_id)
  id, market, event_id, game_id, espn_id, season, week, kickoff_ts,
  away_team, home_team, outcome, reason, primary_pick_id, secondary_pick_id,
  market_selections, eligible_pool, top_probability, selector_version,
  publication_scope, detail, decided_at
from public.nfl_td_slate_evaluations
where is_pregame = true and game_id is not null
order by game_id, decided_at desc;

comment on view public.nfl_td_final_pregame_evaluation is
  'The last decision each game received before kickoff. This is the denominator '
  'of the Touchdown Targets coverage and abstention rates.';

-- ---------------------------------------------------------------------------
-- Atomic replacement for a binary target.
--
-- A separate function from nfl_replace_open_prop_pick rather than a changed
-- signature: the passing-yards RPC keeps its exact argument list and its exact
-- behaviour, so the existing lane cannot be affected by this migration.
-- ---------------------------------------------------------------------------
create or replace function public.nfl_replace_open_td_target(
  p_open_id uuid,
  p_event_id text,
  p_season integer,
  p_week integer,
  p_kickoff_ts timestamptz,
  p_player_name text,
  p_player_key text,
  p_market text,
  p_side text,
  p_book text,
  p_book_key text,
  p_market_price integer,
  p_opposite_price integer,
  p_model_prob numeric,
  p_market_prob numeric,
  p_edge_pct numeric,
  p_ev_pct numeric,
  p_stake_units numeric,
  p_confidence_bucket text,
  p_projection_model_version text,
  p_selector_version bigint,
  p_phase text,
  p_publication_scope text,
  p_target_rank text,
  p_model_snapshot jsonb
) returns uuid
language plpgsql
security definer
as $$
declare
  v_new_id uuid;
  v_kickoff timestamptz;
begin
  if not public.nfl_prop_market_is_binary(p_market) then
    raise exception 'nfl_replace_open_td_target is for binary markets only';
  end if;

  select kickoff_ts into v_kickoff
    from public.nfl_prop_picks
   where id = p_open_id and status = 'open'
   for update;
  if not found then raise exception 'open touchdown target not found'; end if;
  if now() >= v_kickoff then raise exception 'a touchdown target cannot be replaced after kickoff'; end if;

  update public.nfl_prop_picks
     set status = 'superseded', closed_at = now()
   where id = p_open_id and status = 'open';

  insert into public.nfl_prop_picks (
    event_id, season, week, kickoff_ts, player_name, player_key,
    market, side, book, book_key, market_price, opposite_price,
    model_prob, market_prob, edge_pct, ev_pct,
    stake_units, confidence_bucket, projection_model_version, selector_version,
    phase, publication_scope, status, target_rank, model_snapshot
  ) values (
    p_event_id, p_season, p_week, p_kickoff_ts, p_player_name, p_player_key,
    p_market, p_side, p_book, p_book_key, p_market_price, p_opposite_price,
    p_model_prob, p_market_prob, p_edge_pct, p_ev_pct,
    p_stake_units, p_confidence_bucket, p_projection_model_version, p_selector_version,
    p_phase, p_publication_scope, 'open', p_target_rank, p_model_snapshot
  ) returning id into v_new_id;

  return v_new_id;
end
$$;

alter function public.nfl_replace_open_td_target(
  uuid,text,integer,integer,timestamptz,text,text,text,text,text,text,
  integer,integer,numeric,numeric,numeric,numeric,numeric,text,
  text,bigint,text,text,text,jsonb
) set search_path = pg_catalog, public;

revoke all on function public.nfl_replace_open_td_target(
  uuid,text,integer,integer,timestamptz,text,text,text,text,text,text,
  integer,integer,numeric,numeric,numeric,numeric,numeric,text,
  text,bigint,text,text,text,jsonb
) from public;

grant execute on function public.nfl_replace_open_td_target(
  uuid,text,integer,integer,timestamptz,text,text,text,text,text,text,
  integer,integer,numeric,numeric,numeric,numeric,numeric,text,
  text,bigint,text,text,text,jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- The touchdown selector champion.
--
-- promoted = true, trained = false. That pair is the whole governance story:
--
--   promoted  this row is the only thing allowed to publish a touchdown
--             target. A challenger is inserted unpromoted and cannot publish.
--   trained   the selector's learning stage has not yet been fitted from
--             finalized outcomes, because none exist. The existing
--             nfl_prop_picks_official_requires_trained trigger therefore holds
--             every target issued today at publication_scope = 'tracking'.
--
-- Tracking is not a lesser kind of prediction and it is not a backtest. Every
-- tracking target is generated by the champion, named before kickoff, frozen,
-- graded from the official result and kept forever. It is a VERIFIED LIVE
-- record — it is simply a separate record from the official one, and the two
-- are never merged or relabelled. Issuance becomes 'official' only when the
-- hard gate (>= 100 finalized observations AND >= 4 distinct weeks) trains and
-- promotes a touchdown selector.
--
-- The thresholds below are the selector's, not the probability model's. The
-- probability model is the committed artefact pbe-td-hazard-v1; these numbers
-- decide which of its probabilities is worth publishing.
-- ---------------------------------------------------------------------------
insert into public.nfl_prop_selector_models (
  market, projection_model, config, trained, promoted, training_rows, notes
)
select
  'player_anytime_td',
  'pbe-td-hazard-v1',
  jsonb_build_object(
    'source', 'hand_set_selector_prior',
    'selector', 'pbe-td-selector-v1',
    'primary_min_prob', 0.22,
    'secondary_min_prob', 0.30,
    'secondary_min_edge', 0.03,
    'secondary_min_books', 3,
    'min_books', 2,
    'max_publishable_prob', 0.92,
    'availability_abstain_share', 0.6,
    'replace_min_prob_gap', 0.025,
    'early_bird_min_hours', 12,
    'locked_max_hours', 4,
    'stake_floor_units', 0.5,
    'stake_cap_units', 2.0,
    'kelly_fraction', 0.25,
    'distribution', 'poisson_at_least_one_from_pbe_td_hazard_lambda',
    'block_statuses', jsonb_build_array('out', 'doubtful', 'injured reserve', 'ir', 'suspension', 'physically unable to perform'),
    'warn_statuses', jsonb_build_array('questionable')
  ),
  false,
  true,
  0,
  'v1 touchdown selector thresholds over the pbe-td-hazard-v1 probability artefact; selector stage not trained'
where not exists (
  select 1 from public.nfl_prop_selector_models where market = 'player_anytime_td'
);

commit;
