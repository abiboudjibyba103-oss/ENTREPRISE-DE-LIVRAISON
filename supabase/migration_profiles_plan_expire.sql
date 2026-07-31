-- ============================================================
-- Migration: PayDunya Plan Pro payments need a renewal date on
-- profiles.
--
-- NOTE: profiles.plan already exists (see schema.sql — text,
-- default 'free', check (plan in ('free', 'pro'))) and is already
-- guarded by protect_profile_columns() so only the service role can
-- change it. There's no need to (re)create it with a French default
-- like 'gratuit' — that would conflict with the existing check
-- constraint and with every row already in the table. Only
-- plan_expire_at is new here; protect_profile_columns() is updated
-- to guard it the same way as plan (client can never set it directly
-- — only the service role, i.e. a future PayDunya payment webhook,
-- can).
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

alter table public.profiles add column if not exists plan_expire_at timestamptz;

create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    new.plan := old.plan;
    new.plan_expire_at := old.plan_expire_at;
    new.referral_code := old.referral_code;
    new.referred_by := old.referred_by;
    new.email := old.email;
    new.id := old.id;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
