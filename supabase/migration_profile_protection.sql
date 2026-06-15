-- ============================================================
-- Security fix: prevent users from changing protected profile
-- columns (plan, referral_code, referred_by, email, id, created_at)
-- via direct PostgREST calls.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    new.plan := old.plan;
    new.referral_code := old.referral_code;
    new.referred_by := old.referred_by;
    new.email := old.email;
    new.id := old.id;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_columns on public.profiles;
create trigger protect_profile_columns
  before update on public.profiles
  for each row execute procedure public.protect_profile_columns();
