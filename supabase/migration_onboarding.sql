-- ============================================================
-- Migration: dashboard onboarding (predicta-dashboard.html).
-- Adds the columns the new 7-step onboarding wizard writes to, plus
-- onboarding_complete which gates whether it's shown. Existing rows
-- default to onboarding_complete = false, so every existing user will
-- see the wizard once on their next dashboard visit.
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_complete boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS probleme_principal text[];
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS comportement_procrastination text[];
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS declencheur text[];
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS experience_procrastination text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS declencheur_naturel text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS objectif text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tache_urgente text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tache_urgente_delai integer;
