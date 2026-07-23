-- ============================================================
-- Migration: waitlist real-data support for index.html
-- Adds:
--   - waitlist.user_id (links a signup to its auth account, when one
--     exists), and tightens the insert policy so a caller can only
--     attach their OWN user_id, never someone else's
--   - get_waitlist_count() — total headcount, for "+N personnes sur la
--     liste d'attente" / "N places restantes" (RLS blocks direct SELECT
--     on waitlist, so this is a security-definer RPC, same pattern as
--     get_waitlist_referral_count)
--   - get_waitlist_first_signup_at() — anchors the 17-day launch
--     countdown when no explicit launch date is configured
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

alter table public.waitlist add column if not exists user_id uuid references auth.users(id) on delete set null;

drop policy if exists "waitlist_insert_anyone" on public.waitlist;
create policy "waitlist_insert_anyone" on public.waitlist
  for insert with check (user_id is null or auth.uid() = user_id);

create or replace function public.get_waitlist_count()
returns integer
language sql
security definer set search_path = public
stable
as $$
  select count(*)::integer from public.waitlist;
$$;

grant execute on function public.get_waitlist_count() to anon, authenticated;

create or replace function public.get_waitlist_first_signup_at()
returns timestamptz
language sql
security definer set search_path = public
stable
as $$
  select min(created_at) from public.waitlist;
$$;

grant execute on function public.get_waitlist_first_signup_at() to anon, authenticated;
