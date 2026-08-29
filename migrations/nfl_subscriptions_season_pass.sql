-- PropBetEdge NFL — allow non-subscription (season pass) entitlement rows
-- Project: tkmlnhmylqnttmnsnief
-- Run once in the Supabase SQL editor BEFORE pointing Stripe at
-- /api/stripe-webhook. Safe to run now: nfl_subscriptions has 0 rows.
--
-- Why: stripe_subscription_id is currently NOT NULL, so a season pass (a
-- one-time payment, which creates no Stripe subscription) cannot be recorded
-- without inventing a fake subscription id. Instead we allow NULL there and
-- key season passes on the real checkout session id.
--
-- Postgres allows multiple NULLs in a normal UNIQUE index, so the existing
-- UNIQUE (stripe_subscription_id) stays intact and keeps deduping weekly rows.

begin;

alter table public.nfl_subscriptions
  alter column stripe_subscription_id drop not null;

alter table public.nfl_subscriptions
  add column if not exists stripe_checkout_session_id text;

create unique index if not exists nfl_subscriptions_checkout_session_id_key
  on public.nfl_subscriptions (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

commit;

-- Verify:
--
-- select column_name, is_nullable
-- from information_schema.columns
-- where table_schema='public' and table_name='nfl_subscriptions'
--   and column_name in ('stripe_subscription_id','stripe_checkout_session_id');
--
-- expect: stripe_subscription_id YES, stripe_checkout_session_id YES
--
-- select indexname from pg_indexes
-- where tablename='nfl_subscriptions'
--   and indexname='nfl_subscriptions_checkout_session_id_key';
--
-- expect: one row.
--
-- No change to public.nfl_has_pro_access() is required. It gates on
-- status in ('active','trialing') and current_period_end > now(), with no
-- dependency on stripe_subscription_id, so a season-pass row grants access
-- and expires naturally at metadata.expires_at.
