-- ============================================================
-- Migration: generate-predictions now stores up to 4 "mémoires
-- personnalisées" per user per day (was a fixed 3 generic
-- predictions), each carrying its real occurrence count.
--
-- Self-contained: creates prediction_date/prediction_index if they
-- don't exist yet (in case migration_predictions_daily.sql was never
-- run), so this works regardless of what's already on your database.
--
-- Safe to re-run even if a previous attempt partially succeeded
-- (e.g. failed at the unique index step): every ALTER uses
-- if not exists/if exists guards, and the backfill/dedup steps below
-- only touch rows that still need it.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run, then redeploy the generate-predictions
-- edge function.
-- ============================================================

-- Add prediction_date without a NOT NULL default yet, so we can
-- backfill existing rows from their real created_at date instead of
-- stamping them all with "today" (a fixed ALTER ... DEFAULT would
-- backfill every pre-existing row to the same date, which is what
-- caused old rows from different days to collide once the unique
-- index was added).
alter table public.predictions add column if not exists prediction_date date;

update public.predictions
  set prediction_date = (created_at at time zone 'utc')::date
  where prediction_date is null;

alter table public.predictions alter column prediction_date
  set default (now() at time zone 'utc')::date;
alter table public.predictions alter column prediction_date set not null;

-- Same reasoning for prediction_index: backfill per (user_id,
-- prediction_date) group instead of stamping every row to 0, which
-- is what produced the duplicate key on (user_id, prediction_date, 0).
alter table public.predictions add column if not exists prediction_index smallint;

with ranked as (
  select id, row_number() over (
    partition by user_id, prediction_date order by created_at, id
  ) - 1 as rn
  from public.predictions
  where prediction_index is null
)
update public.predictions p
  set prediction_index = ranked.rn
  from ranked
  where p.id = ranked.id;

-- Legacy rows beyond the 4-per-day cap (0-3) are stale anyway —
-- generate-predictions regenerates the current day's memories on
-- demand, so drop the overflow rather than trying to preserve it.
delete from public.predictions where prediction_index > 3;

alter table public.predictions alter column prediction_index set default 0;
alter table public.predictions alter column prediction_index set not null;

alter table public.predictions add column if not exists occurrence_count smallint;

-- In case prediction_index already existed with the old 0-2 range
-- (migration_predictions_daily.sql was run before this one), widen it.
alter table public.predictions drop constraint if exists predictions_prediction_index_check;
alter table public.predictions add constraint predictions_prediction_index_check
  check (prediction_index between 0 and 3);

create unique index if not exists predictions_one_set_per_user_per_day
  on public.predictions (user_id, prediction_date, prediction_index);
