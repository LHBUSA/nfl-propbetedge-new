-- Explicitly pin v1 selector hysteresis instead of relying on a code default.
update public.nfl_prop_selector_models
set config = config || jsonb_build_object('kill_edge', 0.02, 'kill_ev_pct', 0.0)
where market = 'player_pass_yds'
  and promoted = true
  and trained = false
  and coalesce(config->>'source','') = 'hand_set_selector_prior';
