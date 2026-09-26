-- PropBetEdge NFL — PBE Touchdown Targets: close the replacement RPC to clients.
--
-- APPLIED to tkmlnhmylqnttmnsnief on 2026-09-26, immediately after
-- nfl_td_targets_binary_market_v1.sql and before any touchdown target existed.
--
-- nfl_replace_open_td_target is SECURITY DEFINER. The binary-market migration
-- intended it for service_role only (`revoke all ... from public` + grant to
-- service_role), but Supabase grants EXECUTE on new public functions to anon
-- and authenticated explicitly, and revoking from PUBLIC does not remove those
-- role grants. Measured after the migration: anon_exec = true. Without this,
-- anyone holding the public anon key could supersede an open target over
-- PostgREST. The Workers use service_role and are unaffected.
revoke execute on function public.nfl_replace_open_td_target(
  uuid,text,integer,integer,timestamptz,text,text,text,text,text,text,
  integer,integer,numeric,numeric,numeric,numeric,numeric,text,
  text,bigint,text,text,text,jsonb
) from anon, authenticated;

-- Verification (expected: false, false, true):
-- select has_function_privilege('anon', 'public.nfl_replace_open_td_target(uuid,text,integer,integer,timestamptz,text,text,text,text,text,text,integer,integer,numeric,numeric,numeric,numeric,numeric,text,text,bigint,text,text,text,jsonb)', 'execute'),
--        has_function_privilege('authenticated', '...same signature...', 'execute'),
--        has_function_privilege('service_role', '...same signature...', 'execute');
