-- ============================================================
-- Migration: daily-lesson now regenerates the evening lesson
-- whenever a session has finished more recently than the cached
-- lesson, instead of serving the same cached text all day.
--
-- Adds daily_lessons.updated_at (bumped automatically on every
-- UPDATE via the same public.set_updated_at() trigger function
-- already used for profiles), which the edge function compares
-- against the latest finished session's ended_at.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run, then redeploy the daily-lesson edge
-- function.
-- ============================================================

alter table public.daily_lessons add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_daily_lessons_updated_at on public.daily_lessons;
create trigger set_daily_lessons_updated_at
  before update on public.daily_lessons
  for each row execute procedure public.set_updated_at();
