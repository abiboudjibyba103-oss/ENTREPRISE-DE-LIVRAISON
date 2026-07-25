-- ============================================================
-- Migration: store the WhatsApp number on profiles (previously it
-- only ever landed in auth.users.raw_user_meta_data.phone and
-- waitlist.phone, never on the row the rest of the app actually
-- queries).
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

alter table public.profiles add column if not exists phone text;
