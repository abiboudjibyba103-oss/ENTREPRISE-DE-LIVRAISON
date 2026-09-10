-- ============================================================
-- Migration: "Pause" button during an active session.
-- Adds the columns predicta-dashboard.html's pause flow writes to.
-- A pause freezes the visible timer and excludes its duration from
-- duration_min (the real focus time), as opposed to interrupting +
-- relaunching, which stays two separate rows as before.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

alter table public.sessions add column if not exists pause_count integer not null default 0;
alter table public.sessions add column if not exists paused_at timestamptz;
alter table public.sessions add column if not exists total_paused_sec integer not null default 0;

alter table public.sessions drop constraint if exists sessions_pause_count_check;
alter table public.sessions add constraint sessions_pause_count_check
  check (pause_count between 0 and 2);
