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

-- True when the snapshot's source may appear on the current surface. Every
-- rights policy in 020 is this one predicate, so there is one place to audit.
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
      join football_src.source src on src.source_id = s.source_id
     where s.source_snapshot_id = snapshot_id
       and src.display_policy = any (football_rights.current_surface())
  )
$$;
revoke all on function football_rights.snapshot_visible(text) from public;
grant execute on function football_rights.snapshot_visible(text) to pbe_history_owner, pbe_history_reader;

-- True when some record of this entity comes from a source allowed here. Used
-- by the identity spine (person/player/coach), whose rows carry no snapshot of
-- their own because their evidence lives in entity_source_record.
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
      join football_src.source_snapshot s on s.source_snapshot_id = esr.source_snapshot_id
      join football_src.source src on src.source_id = s.source_id
     where esr.entity_type = entity_visible.entity_type
       and esr.entity_id = entity_visible.entity_id
       and src.display_policy = any (football_rights.current_surface())
  )
$$;
revoke all on function football_rights.entity_visible(text, text) from public;
grant execute on function football_rights.entity_visible(text, text) to pbe_history_owner, pbe_history_reader;
