-- ============================================================
-- Migration: daily_lessons (AI-generated daily teaching,
-- replaces the static 30-lesson catalogue)
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

create table if not exists public.daily_lessons (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  lesson_date  date not null default current_date,
  lesson_text  text not null,
  created_at   timestamptz not null default now(),
  unique (user_id, lesson_date)
);

alter table public.daily_lessons enable row level security;

drop policy if exists "daily_lessons_select_own" on public.daily_lessons;
create policy "daily_lessons_select_own" on public.daily_lessons
  for select using (auth.uid() = user_id);

-- No insert/update/delete policy: only the service_role key
-- (used inside the daily-lesson edge function) can write rows.
