-- ============================================================
-- Migration: paydunya-webhook needs somewhere to record which
-- PayDunya invoices it has already processed, so a retried IPN call
-- (PayDunya resends until it gets a 200) doesn't push plan_expire_at
-- forward again on every retry. unique(invoice_token) is what makes
-- this safe: the webhook only flips profiles.plan after successfully
-- inserting a new row here.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

create table if not exists public.paydunya_payments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  invoice_token  text not null unique,
  status         text not null,
  amount         integer,
  created_at     timestamptz not null default now()
);

alter table public.paydunya_payments enable row level security;

create policy "paydunya_payments_select_own" on public.paydunya_payments
  for select using (auth.uid() = user_id);

-- No insert/update/delete policy: only the service_role key (used
-- inside the paydunya-webhook edge function) can write rows.
