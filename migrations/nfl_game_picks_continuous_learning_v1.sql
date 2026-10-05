-- NFL game-pick champion promotion for continuous production learning.
-- Candidates are always inserted unpromoted. This RPC is the only tuner path
-- that changes production ownership: one transaction, one advisory lock.

begin;

create or replace function public.nfl_promote_model_weight(p_version int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trained boolean;
begin
  perform pg_advisory_xact_lock(hashtext('nfl_model_weights_promotion'));

  select coalesce((weights -> 'meta' ->> 'trained')::boolean, false)
    into v_trained
    from public.nfl_model_weights
   where version = p_version
   for update;

  if not found then
    raise exception 'model version % does not exist', p_version;
  end if;

  if not v_trained then
    raise exception 'model version % is not trained', p_version;
  end if;

  update public.nfl_model_weights
     set promoted = false
   where promoted is true
     and version <> p_version;

  update public.nfl_model_weights
     set promoted = true,
         promoted_at = coalesce(promoted_at, now())
   where version = p_version;

  return p_version;
end
$$;

revoke all on function public.nfl_promote_model_weight(int) from public;
revoke all on function public.nfl_promote_model_weight(int) from anon;
revoke all on function public.nfl_promote_model_weight(int) from authenticated;
grant execute on function public.nfl_promote_model_weight(int) to service_role;

commit;
