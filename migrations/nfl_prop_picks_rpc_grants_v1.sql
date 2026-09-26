-- PropBetEdge NFL — PBE Prop Picks (passing yards): close the replacement RPC to clients.
--
-- APPLIED to tkmlnhmylqnttmnsnief on 2026-09-26 (owner-approved security hardening).
--
-- WHY. nfl_replace_open_prop_pick is SECURITY DEFINER: it runs with its owner's
-- rights, not the caller's, so it can supersede an open pick and insert a new one
-- regardless of RLS. The architecture intends it for service_role only (the
-- nfl-prop-picks-orchestrator). Measured before this migration:
--   ACL  {postgres=X, anon=X, authenticated=X, service_role=X}
--   anon EXECUTE = true, authenticated EXECUTE = true
-- In Supabase, new functions in `public` receive EXECUTE for anon and
-- authenticated as explicit per-role grants (default privileges). A
-- `revoke ... from public` removes only the PUBLIC pseudo-role grant — which
-- this function did not even have — and leaves those role grants in place. With
-- the public anon key, anyone could have called this over PostgREST /rpc.
--
-- WHAT. Revoke EXECUTE from anon and authenticated only. The function body,
-- signature, owner, service_role grant, triggers, RLS, picks, grades and
-- receipts are untouched. Zero product or data behaviour change: the only
-- legitimate caller is the orchestrator, which uses service_role.
revoke execute on function public.nfl_replace_open_prop_pick(
  uuid,text,integer,integer,timestamptz,text,text,text,text,text,text,numeric,
  integer,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,
  text,bigint,text,text,jsonb
) from anon, authenticated;

-- Verification (expected: anon false, authenticated false, service_role true):
-- select has_function_privilege('anon', p.oid, 'execute'),
--        has_function_privilege('authenticated', p.oid, 'execute'),
--        has_function_privilege('service_role', p.oid, 'execute')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'nfl_replace_open_prop_pick';
