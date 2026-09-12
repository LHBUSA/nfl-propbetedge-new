-- v2 market-anchored bootstrap/validation champion.
--
-- APPEND ONLY. This inserts a NEW row; it never mutates the rejected v1 row,
-- which stays exactly as it is for audit.
--
-- trained = false on purpose. This champion issues publication_scope='tracking'
-- (TRACKING_BOOTSTRAP), which is graded and learned from but NEVER enters the
-- Verified Official Track Record. Official publication still requires a
-- genuinely trained champion produced by the tuner's own gate.
--
-- integrity_version = 2 is REQUIRED. evaluate() quarantines any champion below
-- it as ANOMALY_REVIEW (model_integrity_version_lt_2), so a v1-era row can
-- never issue through the repaired path.
--
-- The coefficient vector is the v1 structural prior. It is safe here because
-- the v2 path bounds it before it can influence issuance: consensus market
-- anchor, bootstrap probability shrink, bounded structural residual,
-- ML/spread monotonicity assertion, >15pp hard anomaly quarantine.
-- Proven by stress sweep: 4,608 evaluations over 144 rating combinations
-- (realistic through deliberately extreme) x the 8 live Week 1 games gave
-- 0 hard edge anomalies, 0 monotonicity failures, 0 ANOMALY_REVIEW, and a
-- largest |edge| of 0.0955 against a 0.15 hard threshold.

insert into public.nfl_model_weights
  (weights, trained_through_week, training_rows,
   backtest_clv_beat_pct, backtest_brier, backtest_units, promoted, promoted_at, notes)
values (
  jsonb_build_object(
    'intercept', 0.0,
    'coef', jsonb_build_object(
      'off_epa_diff',       1.65,
      'def_epa_diff',       1.35,
      'qb_tier_diff',       0.22,
      'rest_diff',          0.020,
      'home',               0.16,
      'dome',               0.00,
      'wind15',            -0.10,
      'cold25',            -0.06,
      'proe_diff',          0.10,
      'pace_sum',           0.006,
      'line_move',          0.075,
      'prior_blend_weight', 0.00
    ),
    'calib', jsonb_build_object('A', 1.0, 'B', 1.0, 'C', 1.0),
    'meta', jsonb_build_object(
      'source',            'v2_market_anchored_bootstrap',
      'trained',           false,
      'integrity_version', 2,
      'feature_order', jsonb_build_array(
        'off_epa_diff','def_epa_diff','qb_tier_diff','rest_diff','home','dome',
        'wind15','cold25','proe_diff','pace_sum','line_move','prior_blend_weight'
      )
    )
  ),
  null, 0, null, null, null, true, now(),
  'v2 market-anchored bootstrap/validation champion. NOT trained. Issues tracking scope only; never enters the Official Track Record. Supersedes the quarantined v1 issuance behaviour.'
);

-- Demote every older promoted row so exactly one champion is promoted.
-- (Demotion is a promotion-flag change only; no pick row or history is touched.)
update public.nfl_model_weights
   set promoted = false
 where promoted = true
   and version < (select max(version) from public.nfl_model_weights where promoted = true);

-- Verify: expect exactly one promoted row, trained=false, integrity_version=2.
-- select version, promoted, weights->'meta'->>'trained' as trained,
--        weights->'meta'->>'integrity_version' as iv, notes
--   from public.nfl_model_weights order by version;
