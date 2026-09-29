-- PropBetEdge NFL — PBE Touchdown Target hit events: HOW each hit was observed.
--
-- ADDITIVE. One new column and one new unique index on
-- public.nfl_td_target_hit_events. No existing row changes meaning: every row
-- written before this migration was a fresh live observation, which is exactly
-- what the column default says.
--
-- WHY
-- v1 persisted a hit only when the scoring play was <= 5 minutes old, because a
-- row was also an announcement (the global rail celebrates what view=hits
-- serves). A target that scored while the detector was not watching therefore
-- had NO row, and PBEcast could not show a permanent HIT for it until — and
-- without the play — after the final grade. Separating "observed" from
-- "announced" fixes that without ever replaying an old touchdown:
--
--   live_fresh      scoring play <= 5 minutes old when observed. ANNOUNCED
--                   (view=hits, global rail, PBEcast celebration).
--   live_stale      observed during the live window, play older than 5
--                   minutes. PERSISTED, never announced.
--   final_backfill  a locked target whose FINAL grade is a win and that had no
--                   row, recovered once from the same game package with the
--                   same detector. PERSISTED, never announced.
--
-- Every mode uses the same identity (ESPN athlete id frozen at issuance), the
-- same touchdown definition (the grader's readPlayerScoring) and the same
-- scoring-play match. Settlement is still only nfl_prop_pick_grades.
--
-- SCORING-PLAY IDEMPOTENCY
-- UNIQUE (pick_id) already makes a second row for the same target impossible.
-- The partial unique index below adds the upstream idempotency key: one ESPN
-- scoring play can connect at most one target, so a single touchdown can never
-- produce two hit rows under any combination of retries or target rows.

alter table public.nfl_td_target_hit_events
  add column if not exists detection text not null default 'live_fresh';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'nfl_td_target_hit_events_detection_check'
       and conrelid = 'public.nfl_td_target_hit_events'::regclass
  ) then
    alter table public.nfl_td_target_hit_events
      add constraint nfl_td_target_hit_events_detection_check
      check (detection in ('live_fresh', 'live_stale', 'final_backfill'));
  end if;
end $$;

create unique index if not exists nfl_td_target_hit_events_play_unique
  on public.nfl_td_target_hit_events (espn_id, play_id)
  where play_id is not null;

comment on table public.nfl_td_target_hit_events is
  'Append-only touchdown-target hit observations. One per pick, one per ESPN scoring play. Written only by '
  'the nfl-touchdown-target-hit-alerts Worker (service_role) and its one-off final backfill. detection = '
  'live_fresh (announced) | live_stale | final_backfill (persisted, never announced). Not a grade: '
  'settlement stays in nfl_prop_pick_grades, written by nfl-touchdown-targets-grader.';

-- Verification:
-- select detection, count(*) from public.nfl_td_target_hit_events group by 1;          -- all live_fresh
-- select indexname from pg_indexes where indexname = 'nfl_td_target_hit_events_play_unique';
-- Rollback (only while no non-fresh row exists):
-- drop index if exists public.nfl_td_target_hit_events_play_unique;
-- alter table public.nfl_td_target_hit_events drop constraint if exists nfl_td_target_hit_events_detection_check;
-- alter table public.nfl_td_target_hit_events drop column if exists detection;
