-- 007_roles_and_grants.sql
-- source: deploy/policy/010_roles_and_grants.sql
-- Generated; apply with history/deploy/apply.mjs, never by hand-editing this file.

-- PropBetEdge football history — roles, grants and the surface contract.
--
-- Two roles, and the API never connects as the one that can write.
--
--   pbe_history_owner   migrations and loading. Owns the schemas.
--   pbe_history_reader  every read path, including the future Worker API.
--                       Read-only, row-level security applies to it, and it is
--                       the role a Hyperdrive connection string must use.
--
-- The surface (public | pro | internal) is carried per connection in the
-- app.surface setting and read by the rights policies in 020. A connection that
-- sets nothing sees the public surface: the default is the least it could be,
-- so a caller that forgets cannot see more than a visitor.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pbe_history_owner') then
    create role pbe_history_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pbe_history_reader') then
    create role pbe_history_reader nologin;
  end if;
end$$;

alter default privileges in schema football, football_src, football_derived
  revoke all on tables from public;
revoke all on all tables in schema football, football_src, football_derived from public;

grant usage on schema football, football_src, football_derived to pbe_history_owner, pbe_history_reader;
grant all on all tables in schema football, football_src, football_derived to pbe_history_owner;
grant select on all tables in schema football, football_src, football_derived to pbe_history_reader;

alter default privileges for role pbe_history_owner in schema football, football_src, football_derived
  grant select on tables to pbe_history_reader;

-- ---------------------------------------------------------------- the surface
create schema if not exists football_rights;
grant usage on schema football_rights to pbe_history_owner, pbe_history_reader;

-- Which display policies a surface may see. Widening this function is the only
-- way to widen what any caller can read, which is why it lives in SQL and not
-- in an application layer that a new endpoint could forget to call.
create or replace function football_rights.allowed_policies(surface text)
  returns text[]
  language sql
  immutable
  security definer
  set search_path = pg_catalog
as $$
  select case lower(coalesce(surface, 'public'))
    when 'internal' then array['public','pro','internal_only','measurement_only']
    when 'pro'      then array['public','pro']
    else                 array['public']
  end
$$;

create or replace function football_rights.current_surface()
  returns text[]
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_rights
as $$
  select football_rights.allowed_policies(current_setting('app.surface', true))
$$;

revoke all on function football_rights.allowed_policies(text) from public;
revoke all on function football_rights.current_surface() from public;
grant execute on function football_rights.allowed_policies(text) to pbe_history_owner, pbe_history_reader;
grant execute on function football_rights.current_surface() to pbe_history_owner, pbe_history_reader;

-- ---------------------------------------------------------------- lanes
-- A source is not one rights decision. The same provider can serve facts we may
-- publish, records we may only model on, and third-party ratings we may not hold
-- at all. The lane expresses that, and it can only NARROW its source.
--
-- Two directions are in play and it is worth being explicit about which is
-- which. allowed_policies() answers "which display policies may this surface
-- see". surfaces_for_policy() answers the inverse: "which surfaces may see a row
-- with this policy". The lane flags are already stated as surfaces, so the
-- intersection happens in surface space.

create or replace function football_rights.surface_name()
  returns text
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $$
  select case lower(coalesce(nullif(current_setting('app.surface', true), ''), 'public'))
    when 'internal' then 'internal'
    when 'pro'      then 'pro'
    else                 'public'
  end
$$;

create or replace function football_rights.surfaces_for_policy(policy text)
  returns text[]
  language sql
  immutable
  security definer
  set search_path = pg_catalog
as $$
  select case policy
    when 'public'           then array['public','pro','internal']
    when 'pro'              then array['pro','internal']
    when 'internal_only'    then array['internal']
    when 'measurement_only' then array['internal']
    else                         array[]::text[]        -- 'none', and anything unknown
  end
$$;

-- The surfaces a lane permits, as flags. A lane row that does not exist is not
-- an empty answer here — the caller distinguishes missing from empty, because
-- "we decided nothing may see this" and "we have not decided" are different
-- states that happen to have the same consequence.
create or replace function football_rights.lane_surfaces(p_source_id text, p_lane text)
  returns text[]
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_src
as $$
  select coalesce(
    (select array_remove(array[
        case when lp.public_allowed   then 'public'   end,
        case when lp.pro_allowed      then 'pro'      end,
        case when lp.internal_allowed then 'internal' end], null)
       from football_src.source_lane_policy lp
      where lp.source_id = p_source_id and lp.lane = p_lane),
    array[]::text[])
$$;

-- The surfaces a row from this source and lane may appear on: the source's own
-- reach, narrowed by the lane's.
--
-- Fail-closed, in three distinct ways:
--   * a source that requires lanes and is given none            -> nothing
--   * a lane named but never decided                            -> nothing
--   * a lane that exists but permits nothing                    -> nothing
-- A source that does not require lanes and names none keeps its parent policy,
-- which is how the forty single-lane sources in the registry carry on working.
create or replace function football_rights.effective_surfaces(p_source_id text, p_lane text)
  returns text[]
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_src, football_rights
as $$
  with src as (
    select display_policy, lane_policy_required
      from football_src.source where source_id = p_source_id
  ), parent as (
    select football_rights.surfaces_for_policy((select display_policy from src)) as s
  ), lane as (
    select exists (select 1 from football_src.source_lane_policy
                    where source_id = p_source_id and lane = p_lane) as decided
  )
  select case
    when not exists (select 1 from src) then array[]::text[]
    when p_lane is null and (select lane_policy_required from src) then array[]::text[]
    when p_lane is null then (select s from parent)
    when not (select decided from lane) then array[]::text[]
    else (select array(select unnest((select s from parent))
                       intersect
                       select unnest(football_rights.lane_surfaces(p_source_id, p_lane))))
  end
$$;

-- The same question asked for a NAMED surface rather than the connection's own.
-- The API layer uses this so that an explicit join filter and the row-level
-- policy are the same rule, not two rules that have to be kept in step.
create or replace function football_rights.surface_allows(p_surface text, p_source_id text, p_lane text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_rights
as $$
  select case lower(coalesce(nullif(p_surface, ''), 'public'))
           when 'internal' then 'internal' when 'pro' then 'pro' else 'public' end
         = any (football_rights.effective_surfaces(p_source_id, p_lane))
$$;
revoke all on function football_rights.surface_allows(text, text, text) from public;
grant execute on function football_rights.surface_allows(text, text, text) to pbe_history_owner, pbe_history_reader;

-- True when the snapshot may appear on the current surface. Every rights policy
-- in the generated migration is this one predicate, so there is one place to
-- audit and one place a mistake could be made.
create or replace function football_rights.snapshot_visible(snapshot_id text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_src, football_rights
as $$
  select exists (
    select 1
      from football_src.source_snapshot s
     where s.source_snapshot_id = snapshot_id
       and football_rights.surface_name() =
             any (football_rights.effective_surfaces(s.source_id, s.lane))
  )
$$;
revoke all on function football_rights.snapshot_visible(text) from public;
grant execute on function football_rights.snapshot_visible(text) to pbe_history_owner, pbe_history_reader;

-- A row composed from several snapshots is withheld unless EVERY one of them is
-- allowed here. This is the mixed-source rule, and it is the opposite of the
-- corroboration rule below on purpose: a row that needs three sources to exist
-- takes the narrowest of the three.
create or replace function football_rights.all_snapshots_visible(snapshot_ids text[])
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_src, football_rights
as $$
  select coalesce(array_length(snapshot_ids, 1), 0) > 0
     and not exists (
       select 1 from unnest(snapshot_ids) as sid
        where not football_rights.snapshot_visible(sid)
     )
$$;
revoke all on function football_rights.all_snapshots_visible(text[]) from public;
grant execute on function football_rights.all_snapshots_visible(text[]) to pbe_history_owner, pbe_history_reader;

-- True when some record of this entity comes from a source allowed here. Used
-- by the identity spine (person/player/coach), whose rows carry no snapshot of
-- their own because their evidence lives in entity_source_record.
--
-- Corroboration widens, requirement narrows. A person Wikidata names publicly
-- does not become unpublishable because a restricted source also mentions them;
-- but a row marked role='required' is load-bearing, and if it may not be shown
-- here then neither may the entity.
create or replace function football_rights.entity_visible(entity_type text, entity_id text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_src, football_rights
as $$
  select exists (
      select 1
        from football_src.entity_source_record esr
       where esr.entity_type = entity_visible.entity_type
         and esr.entity_id = entity_visible.entity_id
         and esr.role in ('supports','required')
         and football_rights.snapshot_visible(esr.source_snapshot_id)
    )
    and not exists (
      select 1
        from football_src.entity_source_record esr
       where esr.entity_type = entity_visible.entity_type
         and esr.entity_id = entity_visible.entity_id
         and esr.role = 'required'
         and not football_rights.snapshot_visible(esr.source_snapshot_id)
    )
$$;
revoke all on function football_rights.entity_visible(text, text) from public;
grant execute on function football_rights.entity_visible(text, text) to pbe_history_owner, pbe_history_reader;

-- ---------------------------------------------------------------- model use
-- Training is not reading. A lane can be readable internally and still be
-- unusable for a particular model — a CC0 licence says nothing about whether
-- the sample it gives you can carry the meaning you want to put on it.
--
-- Returns false unless the source allows model use, the lane allows model use,
-- and the named purpose is not prohibited for that lane. '*' in
-- prohibited_model_uses forbids every purpose.
create or replace function football_rights.model_use_allowed(snapshot_id text, purpose text default null)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_src
as $$
  select exists (
    select 1
      from football_src.source_snapshot s
      join football_src.source src on src.source_id = s.source_id
      left join football_src.source_lane_policy lp
             on lp.source_id = s.source_id and lp.lane = s.lane
     where s.source_snapshot_id = snapshot_id
       and src.model_use_allowed
       and case
             -- a source that requires lanes and was given none: undecided, so no
             when src.lane_policy_required and s.lane is null then false
             when s.lane is null then true
             -- a lane was named but never decided: undecided, so no
             when lp.source_id is null then false
             else lp.model_use_allowed
                  and not ('*' = any (lp.prohibited_model_uses))
                  and not (purpose is not null and purpose = any (lp.prohibited_model_uses))
           end
  )
$$;
revoke all on function football_rights.model_use_allowed(text, text) from public;
grant execute on function football_rights.model_use_allowed(text, text) to pbe_history_owner, pbe_history_reader;

-- Whether a lane may be persisted at all. False is stronger than invisible: the
-- value must never be written, so there is nothing to hide later.
create or replace function football_rights.lane_ingest_allowed(p_source_id text, p_lane text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, football_src
as $$
  select coalesce((select lp.ingest_allowed
                     from football_src.source_lane_policy lp
                    where lp.source_id = p_source_id and lp.lane = p_lane), false)
$$;
revoke all on function football_rights.lane_ingest_allowed(text, text) from public;
grant execute on function football_rights.lane_ingest_allowed(text, text) to pbe_history_owner, pbe_history_reader;

revoke all on function football_rights.surface_name() from public;
revoke all on function football_rights.surfaces_for_policy(text) from public;
revoke all on function football_rights.lane_surfaces(text, text) from public;
revoke all on function football_rights.effective_surfaces(text, text) from public;
grant execute on function football_rights.surface_name() to pbe_history_owner, pbe_history_reader;
grant execute on function football_rights.surfaces_for_policy(text) to pbe_history_owner, pbe_history_reader;
grant execute on function football_rights.lane_surfaces(text, text) to pbe_history_owner, pbe_history_reader;
grant execute on function football_rights.effective_surfaces(text, text) to pbe_history_owner, pbe_history_reader;
