-- ============================================================
-- Prédicta — rate limit table cleanup
-- Deletes auth_rate_limit rows older than 1 hour to prevent
-- unbounded table growth (old rows are never needed for the
-- 1-minute sliding window checks).
-- Run via pg_cron in Supabase (Dashboard → Extensions → pg_cron)
-- or manually whenever the table grows large.
-- ============================================================

-- Enable pg_cron if not already enabled (requires Supabase Pro).
-- create extension if not exists pg_cron;

-- Schedule cleanup every hour (requires pg_cron).
-- select cron.schedule(
--   'clean-auth-rate-limit',
--   '0 * * * *',
--   $$ delete from public.auth_rate_limit where attempted_at < now() - interval '1 hour' $$
-- );

-- Run this manually to clean up now:
delete from public.auth_rate_limit where attempted_at < now() - interval '1 hour';
