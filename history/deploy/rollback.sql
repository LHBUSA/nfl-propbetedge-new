-- Roll the history database back to nothing.
--
--   psql "$HISTORY_DATABASE_URL" -v ON_ERROR_STOP=1 -f history/deploy/rollback.sql
--
-- This is the whole-deployment undo: the history graph lives in its own project
-- and its own schemas, so removing it is dropping those schemas. That is only
-- safe BECAUSE of the isolation — never run anything like this against a
-- database that also serves product.
--
-- It refuses to run if it finds live product tables, and it takes a backup of
-- the rights registry first, because the registry is owner decisions and
-- research, not data that can be re-fetched.
--
-- For a single bad migration, do not use this: fix forward with a new migration.
-- Restoring a point in time is Supabase PITR or the pg_dump described in
-- history/docs/SUPABASE_DEPLOYMENT.md.

\set ON_ERROR_STOP on

do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema not in ('pg_catalog','information_schema')
       and (table_name like 'nfl\_%' or table_name like 'ufc\_%' or table_name like 'mlb\_%' or table_name like 'wnba\_%')
  ) then
    raise exception 'refusing to roll back: this database holds product tables, so it is not the history database';
  end if;
end$$;

create schema if not exists football_archive;
create table if not exists football_archive.source_registry_backup as
  select *, now() as archived_at from football_src.source;
create table if not exists football_archive.migration_backup as
  select *, now() as archived_at from football_deploy.migration;

drop schema if exists football_derived cascade;
drop schema if exists football cascade;
drop schema if exists football_src cascade;
drop schema if exists football_rights cascade;

-- The ledger survives on purpose: what was applied and rolled back is part of
-- the record. Drop football_deploy by hand if the project is being abandoned.
delete from football_deploy.migration;

-- Roles are cluster-wide and may own other objects; dropping them is a separate,
-- deliberate act:
--   drop owned by pbe_history_reader; drop role pbe_history_reader;
--   drop owned by pbe_history_owner;  drop role pbe_history_owner;
