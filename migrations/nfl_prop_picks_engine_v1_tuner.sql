-- Player Prop Engine v1 — governed selector promotion.
-- Candidates are always inserted unpromoted. This RPC atomically demotes the
-- incumbent and promotes one already-trained candidate under an advisory lock.

begin;

update public.nfl_prop_selector_models
set config = config || jsonb_build_object('min_quality_prob', 0.55)
where market = 'player_pass_yds'
  and promoted = true
  and coalesce(config->>'source','') = 'hand_set_selector_prior';

create or replace function public.nfl_promote_prop_selector(
  p_version bigint,
  p_market text
) returns void
language plpgsql
security definer
as $$
declare
  v_trained boolean;
begin
  perform pg_advisory_xact_lock(hashtext('nfl_prop_selector_promotion:' || p_market));

  select trained into v_trained
    from public.nfl_prop_selector_models
   where version = p_version
     and market = p_market;

  if coalesce(v_trained, false) <> true then
    raise exception 'prop selector candidate must exist and be trained';
  end if;

  update public.nfl_prop_selector_models
     set promoted = false
   where market = p_market
     and promoted = true;

  update public.nfl_prop_selector_models
     set promoted = true,
         promoted_at = now()
   where version = p_version
     and market = p_market
     and trained = true;

  if not found then
    raise exception 'prop selector candidate promotion failed';
  end if;
end
$$;

alter function public.nfl_promote_prop_selector(bigint,text)
  set search_path = pg_catalog, public;

revoke all on function public.nfl_promote_prop_selector(bigint,text) from public;
grant execute on function public.nfl_promote_prop_selector(bigint,text) to service_role;

commit;
