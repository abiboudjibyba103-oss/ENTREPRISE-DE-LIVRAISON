-- ============================================================
-- Migration: in-progress sessions for predicta-dashboard.html
--
-- The dashboard now inserts a `sessions` row the moment a session
-- starts (status = 'in_progress', started_at = now()), then UPDATEs
-- that same row when it finishes or is interrupted. duration_min is
-- unknown at insert time, so it can no longer be NOT NULL.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

alter table public.sessions alter column duration_min drop not null;
alter table public.sessions drop constraint if exists sessions_duration_min_check;
alter table public.sessions add constraint sessions_duration_min_check
  check (duration_min is null or (duration_min > 0 and duration_min <= 240));
