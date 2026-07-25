-- ============================================================
-- Migration: let `update-brain-metrics` upsert a single, always-
-- current cognitive-profile row per user (overwritten after every
-- session), instead of accumulating unused historical snapshots.
--
-- Two changes needed vs the original brain_metrics table:
--  1. `memoire` was NOT NULL with no default, but update-brain-metrics
--     doesn't compute a "mémoire" score (it wasn't one of the 5
--     metrics requested for the cognitive-profile bars) — relaxed to
--     nullable so the upsert doesn't fail on first insert.
--  2. Added `progression` (new metric) and a unique constraint on
--     user_id so `upsert(..., { onConflict: 'user_id' })` has
--     something to target.
--
-- NOTE: the unique index below will fail to create if a user
-- somehow already has more than one brain_metrics row (shouldn't
-- happen — nothing wrote to this table before this feature). If it
-- fails, deduplicate first: keep each user's most recent row by
-- recorded_at and delete the rest.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run, then deploy the update-brain-metrics
-- edge function.
-- ============================================================

alter table public.brain_metrics alter column memoire drop not null;

alter table public.brain_metrics add column if not exists progression smallint
  check (progression between 0 and 100);

create unique index if not exists brain_metrics_one_per_user
  on public.brain_metrics (user_id);
