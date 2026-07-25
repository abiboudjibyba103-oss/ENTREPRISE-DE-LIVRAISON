-- ============================================================
-- Migration: let `generate-predictions` store exactly 3 predictions
-- per user per day, regenerable on the same day without piling up
-- duplicates (same pattern as daily_lessons / coach_messages).
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run, then deploy the generate-predictions
-- edge function.
-- ============================================================

alter table public.predictions add column if not exists prediction_date date
  not null default (now() at time zone 'utc')::date;

-- Distinguishes the 3 predictions generated for the same user/day —
-- a plain unique(user_id, prediction_date) would only allow ONE row
-- per day, silently dropping 2 of the 3 predictions on upsert.
alter table public.predictions add column if not exists prediction_index smallint
  not null default 0 check (prediction_index between 0 and 2);

create unique index if not exists predictions_one_set_per_user_per_day
  on public.predictions (user_id, prediction_date, prediction_index);
