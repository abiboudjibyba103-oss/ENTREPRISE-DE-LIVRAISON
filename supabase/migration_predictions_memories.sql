-- ============================================================
-- Migration: generate-predictions now stores up to 4 "mémoires
-- personnalisées" per user per day (was a fixed 3 generic
-- predictions), each carrying its real occurrence count.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run, then redeploy the generate-predictions
-- edge function.
-- ============================================================

alter table public.predictions add column if not exists occurrence_count smallint;

alter table public.predictions drop constraint if exists predictions_prediction_index_check;
alter table public.predictions add constraint predictions_prediction_index_check
  check (prediction_index between 0 and 3);
