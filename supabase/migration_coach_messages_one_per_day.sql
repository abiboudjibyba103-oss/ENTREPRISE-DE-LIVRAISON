-- ============================================================
-- Migration: enforce coach-chat's 1-question/day limit at the DB
-- level, not just via an app-side count-then-insert check.
--
-- Without this, two near-simultaneous requests can both pass the
-- count check before either has inserted its row (a classic
-- TOCTOU race), letting a user burn more than one Groq call/day.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run, then redeploy coach-chat.
-- ============================================================

alter table public.coach_messages add column if not exists message_date date
  not null default (now() at time zone 'utc')::date;

create unique index if not exists coach_messages_one_per_user_per_day
  on public.coach_messages (user_id, message_date);
