-- ============================================================
-- Migration: onboarding now asks new users what naturally helps
-- them get started (micro-action / heure précise / pression
-- externe / texte libre), stored on profiles.declencheur_naturel
-- and used to personalize the message shown when a session is
-- interrupted.
--
-- User-writable directly (not added to protect_profile_columns()):
-- unlike plan/plan_expire_at, this is a preference the user answers
-- themselves during onboarding, the same way evening_lesson_hour is
-- user-editable from Réglages.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

alter table public.profiles add column if not exists declencheur_naturel text;
