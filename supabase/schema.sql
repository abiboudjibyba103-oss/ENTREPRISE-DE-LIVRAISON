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
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "profiles_delete_own" on public.profiles
  for delete using (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ------------------------------------------------------------
-- 2. sessions — focus/work sessions
-- ------------------------------------------------------------
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  duration_min  smallint not null check (duration_min > 0 and duration_min <= 240),
  focus_score   smallint check (focus_score between 0 and 100),
  status        text not null default 'completed' check (status in ('completed', 'interrupted', 'in_progress')),
  notes         text,
  created_at    timestamptz not null default now()
);

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
-- 6. waitlist — landing page email capture (no auth required)
--    Inserts are allowed for anyone, but reads/updates/deletes
--    are restricted to the service role only.
-- ------------------------------------------------------------
create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  created_at  timestamptz not null default now()
);

alter table public.waitlist enable row level security;

create policy "waitlist_insert_anyone" on public.waitlist
  for insert with check (true);

-- No select/update/delete policy => only the service_role key
-- (used server-side only, never in the browser) can read this table.


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
