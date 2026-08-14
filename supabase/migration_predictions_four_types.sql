-- ============================================================
-- Migration: generate-predictions now generates 4 distinct kinds of
-- content per day — patterns détectés, prédictions, mémoire
-- personnalisée, anticipation — instead of just "memories". Adds a
-- `kind` column to public.predictions and widens the uniqueness
-- constraint from (user_id, prediction_date, prediction_index) to
-- (user_id, prediction_date, kind, prediction_index), since each kind
-- now has its own 0-based index sequence.
--
-- Existing rows (all "memories" under the old design) are backfilled
-- to kind = 'memoire'. prediction_index's max is now 2 (the largest
-- group — patterns and mémoire — caps at 3 items, indices 0-2), down
-- from 3 — any stale row above that is dropped rather than kept
-- around under a constraint it would violate.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run, then redeploy the generate-predictions
-- edge function.
-- ============================================================

alter table public.predictions add column if not exists kind text;
update public.predictions set kind = 'memoire' where kind is null;
alter table public.predictions alter column kind set default 'memoire';
alter table public.predictions alter column kind set not null;
alter table public.predictions drop constraint if exists predictions_kind_check;
alter table public.predictions add constraint predictions_kind_check
  check (kind in ('pattern', 'prediction', 'memoire', 'anticipation'));

delete from public.predictions where prediction_index > 2;

alter table public.predictions drop constraint if exists predictions_prediction_index_check;
alter table public.predictions add constraint predictions_prediction_index_check
  check (prediction_index between 0 and 2);

drop index if exists predictions_one_set_per_user_per_day;
create unique index if not exists predictions_one_set_per_kind_per_day
  on public.predictions (user_id, prediction_date, kind, prediction_index);
