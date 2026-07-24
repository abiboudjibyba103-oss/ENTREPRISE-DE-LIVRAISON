-- ============================================================
-- Prédicta — Supabase schema, RLS policies and helper triggers
-- Run this in the Supabase SQL editor (or via `supabase db push`)
-- ============================================================

-- ------------------------------------------------------------
-- 1. profiles — one row per authenticated user
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id                       uuid primary key references auth.users(id) on delete cascade,
  display_name             text not null default 'Utilisateur',
  email                    text not null,
  default_session_minutes  smallint not null default 45 check (default_session_minutes in (25, 45, 90)),
  notifications_enabled    boolean not null default true,
  plan                     text not null default 'free' check (plan in ('free', 'pro')),
  phase                    text not null default 'Phase 1 — Découverte',
  referral_code            text unique,
  referred_by              uuid references public.profiles(id) on delete set null,
  evening_lesson_hour      smallint not null default 17 check (evening_lesson_hour between 0 and 23),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Migration for pre-existing databases: add the referral columns and
-- backfill a unique code for every existing profile.
alter table public.profiles add column if not exists referral_code text unique;
alter table public.profiles add column if not exists referred_by uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists evening_lesson_hour smallint not null default 17
  check (evening_lesson_hour between 0 and 23);

update public.profiles
  set referral_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  where referral_code is null;

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "profiles_delete_own" on public.profiles
  for delete using (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user signs up.
-- Also generates a unique referral code for the new user and, if they
-- signed up with someone else's referral code, links them via referred_by.
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

-- Lets a user know how many people they've referred, without exposing
-- the referred users' profile rows directly (RLS only allows reading
-- one's own profile row).
create or replace function public.get_referral_count()
returns integer
language sql
security definer set search_path = public
stable
as $$
  select count(*)::integer from public.profiles where referred_by = auth.uid();
$$;

grant execute on function public.get_referral_count() to authenticated;

-- profiles_update_own (above) lets a user update ANY column of their own
-- row, including plan, referral_code and referred_by. Without this guard,
-- a user could self-upgrade their plan or rewrite their referral
-- attribution directly via the PostgREST API (the anon key + their JWT is
-- enough). Server-controlled columns are pinned back to their previous
-- value unless the change comes from the service role.
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


-- ------------------------------------------------------------
-- 2. sessions — focus/work sessions
-- ------------------------------------------------------------
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  duration_min  smallint check (duration_min is null or (duration_min > 0 and duration_min <= 240)),
  focus_score   smallint check (focus_score between 0 and 100),
  status        text not null default 'completed' check (status in ('completed', 'interrupted', 'in_progress')),
  notes         text,
  interruption_reason text,
  created_at    timestamptz not null default now()
);

-- Migration for pre-existing databases.
alter table public.sessions add column if not exists interruption_reason text;

-- duration_min is unknown at the moment a session starts (status
-- 'in_progress' is inserted with only started_at set) — it can no
-- longer be NOT NULL. Re-create the check constraint to allow null.
alter table public.sessions alter column duration_min drop not null;
alter table public.sessions drop constraint if exists sessions_duration_min_check;
alter table public.sessions add constraint sessions_duration_min_check
  check (duration_min is null or (duration_min > 0 and duration_min <= 240));

alter table public.sessions enable row level security;

create policy "sessions_select_own" on public.sessions
  for select using (auth.uid() = user_id);

create policy "sessions_insert_own" on public.sessions
  for insert with check (auth.uid() = user_id);

create policy "sessions_update_own" on public.sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "sessions_delete_own" on public.sessions
  for delete using (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 3. lesson_progress — progression on the 30 micro-lessons
-- ------------------------------------------------------------
create table if not exists public.lesson_progress (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  lesson_id     text not null check (lesson_id ~ '^[A-F][1-5]$'),
  status        text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, lesson_id)
);

alter table public.lesson_progress enable row level security;

create policy "lesson_progress_select_own" on public.lesson_progress
  for select using (auth.uid() = user_id);

create policy "lesson_progress_insert_own" on public.lesson_progress
  for insert with check (auth.uid() = user_id);

create policy "lesson_progress_update_own" on public.lesson_progress
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "lesson_progress_delete_own" on public.lesson_progress
  for delete using (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 4. brain_metrics — radar chart snapshots (Mon Cerveau)
-- ------------------------------------------------------------
create table if not exists public.brain_metrics (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  concentration  smallint not null check (concentration between 0 and 100),
  memoire        smallint not null check (memoire between 0 and 100),
  regulation     smallint not null check (regulation between 0 and 100),
  regularite     smallint not null check (regularite between 0 and 100),
  recuperation   smallint not null check (recuperation between 0 and 100),
  recorded_at    timestamptz not null default now()
);

alter table public.brain_metrics enable row level security;

create policy "brain_metrics_select_own" on public.brain_metrics
  for select using (auth.uid() = user_id);

create policy "brain_metrics_insert_own" on public.brain_metrics
  for insert with check (auth.uid() = user_id);

create policy "brain_metrics_update_own" on public.brain_metrics
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "brain_metrics_delete_own" on public.brain_metrics
  for delete using (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 5. predictions — AI coach predictions
-- ------------------------------------------------------------
create table if not exists public.predictions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  prediction_text text not null,
  confidence      smallint check (confidence between 0 and 100),
  created_at      timestamptz not null default now()
);

alter table public.predictions enable row level security;

create policy "predictions_select_own" on public.predictions
  for select using (auth.uid() = user_id);

create policy "predictions_insert_own" on public.predictions
  for insert with check (auth.uid() = user_id);

create policy "predictions_update_own" on public.predictions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "predictions_delete_own" on public.predictions
  for delete using (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 5b. coach_messages — AI coach chat history (question asked,
--    reply given), used by the coach-chat edge function both to
--    log the exchange and to enforce the 1-question/day limit.
--    Written only by the edge function (service_role) — users can
--    only read their own, same pattern as daily_lessons.
-- ------------------------------------------------------------
create table if not exists public.coach_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  message    text,
  reply      text,
  created_at timestamptz not null default now()
);

alter table public.coach_messages enable row level security;

create policy "coach_messages_select_own" on public.coach_messages
  for select using (auth.uid() = user_id);

-- No insert/update/delete policy: only the service_role key
-- (used inside the coach-chat edge function) can write rows.


-- ------------------------------------------------------------
-- 6. waitlist — pre-launch sign-up (no auth required)
--    Inserts are allowed for anyone, but reads/updates/deletes
--    are restricted to the service role only (used by the
--    waitlist-join edge function).
-- ------------------------------------------------------------
create table if not exists public.waitlist (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id) on delete set null,
  email            text not null unique,
  name             text,
  phone            text,
  referral_code    text unique,
  referred_by_code text,
  created_at       timestamptz not null default now()
);

-- Migration for pre-existing databases.
alter table public.waitlist add column if not exists name text;
alter table public.waitlist add column if not exists phone text;
alter table public.waitlist add column if not exists referral_code text unique;
alter table public.waitlist add column if not exists referred_by_code text;
alter table public.waitlist add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table public.waitlist enable row level security;

-- Anyone can insert (pre-launch capture, no auth required), but a
-- caller may only attach their OWN user_id — never someone else's.
drop policy if exists "waitlist_insert_anyone" on public.waitlist;
create policy "waitlist_insert_anyone" on public.waitlist
  for insert with check (user_id is null or auth.uid() = user_id);

-- No select/update/delete policy => only the service_role key
-- (used server-side only, never in the browser) can read this table.

-- Assigns a unique referral code to every new waitlist signup.
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

-- Lets anyone look up how many people joined the waitlist using their
-- referral code, without exposing any other waitlist data.
create or replace function public.get_waitlist_referral_count(code text)
returns integer
language sql
security definer set search_path = public
stable
as $$
  select count(*)::integer from public.waitlist where referred_by_code = upper(code);
$$;

grant execute on function public.get_waitlist_referral_count(text) to anon, authenticated;

-- Lets anyone read the total waitlist headcount (for the landing page's
-- "+N personnes sur la liste d'attente" / "N places restantes" copy)
-- without exposing individual rows.
create or replace function public.get_waitlist_count()
returns integer
language sql
security definer set search_path = public
stable
as $$
  select count(*)::integer from public.waitlist;
$$;

grant execute on function public.get_waitlist_count() to anon, authenticated;

-- Lets anyone read the timestamp of the very first waitlist signup, used
-- to anchor the landing page's 17-day launch countdown when no explicit
-- launch date is configured elsewhere.
create or replace function public.get_waitlist_first_signup_at()
returns timestamptz
language sql
security definer set search_path = public
stable
as $$
  select min(created_at) from public.waitlist;
$$;

grant execute on function public.get_waitlist_first_signup_at() to anon, authenticated;


-- ------------------------------------------------------------
-- 7. auth_rate_limit — tracks sign-in attempts per IP for the
--    auth-rate-limit edge function (max 5 attempts / minute / IP)
--    No client policies => only the service_role key can read/write.
-- ------------------------------------------------------------
create table if not exists public.auth_rate_limit (
  id          uuid primary key default gen_random_uuid(),
  ip_address  text not null,
  route       text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists auth_rate_limit_ip_route_idx
  on public.auth_rate_limit (ip_address, route, attempted_at);

alter table public.auth_rate_limit enable row level security;
-- No policies defined: table is only accessible via service_role
-- (used inside the auth-rate-limit edge function).


-- ------------------------------------------------------------
-- 8. daily_lessons — one AI-generated teaching per user per day,
--    grounded in that day's real session data (replaces the old
--    static 30-lesson catalogue). Written only by the
--    `daily-lesson` edge function (service_role) — users can
--    only read their own.
-- ------------------------------------------------------------
create table if not exists public.daily_lessons (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  lesson_date  date not null default current_date,
  lesson_text  text not null,
  created_at   timestamptz not null default now(),
  unique (user_id, lesson_date)
);

alter table public.daily_lessons enable row level security;

create policy "daily_lessons_select_own" on public.daily_lessons
  for select using (auth.uid() = user_id);

-- No insert/update/delete policy: only the service_role key
-- (used inside the daily-lesson edge function) can write rows.


-- ------------------------------------------------------------
-- updated_at trigger helper for profiles
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();
