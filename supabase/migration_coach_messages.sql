-- ============================================================
-- Migration: coach_messages (AI coach chat history)
-- Replaces `predictions` as the table coach-chat writes to and
-- reads the daily question-limit count from. Copy ALL of this
-- file into a new query in the Supabase SQL Editor and click Run,
-- then deploy the updated coach-chat function:
--   supabase functions deploy coach-chat
-- ============================================================

create table if not exists public.coach_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  message    text,
  reply      text,
  created_at timestamptz not null default now()
);

alter table public.coach_messages enable row level security;

drop policy if exists "coach_messages_select_own" on public.coach_messages;
create policy "coach_messages_select_own" on public.coach_messages
  for select using (auth.uid() = user_id);

-- No insert/update/delete policy: only the service_role key
-- (used inside the coach-chat edge function) can write rows.
