-- ============================================================
-- Migration: dashboard.html support
-- Adds the two columns the new mobile dashboard needs that
-- schema.sql didn't have yet:
--   - sessions.interruption_reason  (why a session was cut short)
--   - profiles.evening_lesson_hour  (user-configurable hour, 0-23,
--     for the "enseignement du soir" gate — default 17)
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

alter table public.sessions add column if not exists interruption_reason text;

alter table public.profiles add column if not exists evening_lesson_hour smallint not null default 17
  check (evening_lesson_hour between 0 and 23);
