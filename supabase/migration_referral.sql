-- ============================================================
-- Migration: referral codes (profiles + waitlist)
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

-- 1) profiles: referral columns
alter table public.profiles add column if not exists referral_code text unique;
alter table public.profiles add column if not exists referred_by uuid references public.profiles(id) on delete set null;

update public.profiles
  set referral_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  where referral_code is null;

-- 2) handle_new_user: generate referral_code + link referred_by
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  new_code text;
  referrer uuid;
begin
  loop
    new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.profiles where referral_code = new_code);
  end loop;

  if new.raw_user_meta_data->>'referral_code' is not null then
    select id into referrer from public.profiles
      where referral_code = upper(new.raw_user_meta_data->>'referral_code')
      limit 1;
  end if;

  insert into public.profiles (id, email, display_name, referral_code, referred_by)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new_code,
    referrer
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3) profiles referral count
create or replace function public.get_referral_count()
returns integer
language sql
security definer set search_path = public
stable
as $$
  select count(*)::integer from public.profiles where referred_by = auth.uid();
$$;

grant execute on function public.get_referral_count() to authenticated;

-- 4) waitlist: new columns
alter table public.waitlist add column if not exists name text;
alter table public.waitlist add column if not exists phone text;
alter table public.waitlist add column if not exists referral_code text unique;
alter table public.waitlist add column if not exists referred_by_code text;

create or replace function public.set_waitlist_referral_code()
returns trigger
language plpgsql
as $$
declare
  new_code text;
begin
  if new.referral_code is null then
    loop
      new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      exit when not exists (select 1 from public.waitlist where referral_code = new_code);
    end loop;
    new.referral_code := new_code;
  end if;
  return new;
end;
$$;

drop trigger if exists set_waitlist_referral_code on public.waitlist;
create trigger set_waitlist_referral_code
  before insert on public.waitlist
  for each row execute procedure public.set_waitlist_referral_code();

update public.waitlist set referral_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  where referral_code is null;

create or replace function public.get_waitlist_referral_count(code text)
returns integer
language sql
security definer set search_path = public
stable
as $$
  select count(*)::integer from public.waitlist where referred_by_code = upper(code);
$$;

grant execute on function public.get_waitlist_referral_count(text) to anon, authenticated;
