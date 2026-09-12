-- ============================================================
-- Migration: signal_key on public.predictions.
-- Identifies which real signal produced a kind='prediction' row
-- (e.g. 'beforeTen', 'worstWeekday', 'worstSlot', 'reason:<texte>')
-- so generate-predictions can detect the same signal repeating over
-- the last few days and rotate in a weaker-but-qualified one instead
-- — comparing Groq's rephrased text wouldn't work since it varies
-- even for the same underlying signal. Null for every other kind.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

alter table public.predictions add column if not exists signal_key text;
