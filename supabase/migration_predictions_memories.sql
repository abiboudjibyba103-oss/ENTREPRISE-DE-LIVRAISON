-- ============================================================
-- Migration: generate-predictions now stores up to 4 "mémoires
-- personnalisées" per user per day (was a fixed 3 generic
-- predictions), each carrying its real occurrence count.
--
-- Self-contained: creates prediction_date/prediction_index if they
-- don't exist yet (in case migration_predictions_daily.sql was never
-- run), so this works regardless of what's already on your database.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run, then redeploy the generate-predictions
-- edge function.
-- ============================================================

alter table public.predictions add column if not exists prediction_date date
  not null default (now() at time zone 'utc')::date;

alter table public.predictions add column if not exists prediction_index smallint
  not null default 0 check (prediction_index between 0 and 3);

alter table public.predictions add column if not exists occurrence_count smallint;

-- In case prediction_index already existed with the old 0-2 range
-- (migration_predictions_daily.sql was run before this one), widen it.
alter table public.predictions drop constraint if exists predictions_prediction_index_check;
alter table public.predictions add constraint predictions_prediction_index_check
  check (prediction_index between 0 and 3);

create unique index if not exists predictions_one_set_per_user_per_day
  on public.predictions (user_id, prediction_date, prediction_index);
