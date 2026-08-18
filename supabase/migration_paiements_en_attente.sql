-- ============================================================
-- Migration: manual Wave payment flow. When a user hits the J15
-- paywall (#ecran-blocage in predicta-dashboard.html), they pay via
-- Wave by hand and click "J'ai effectué le paiement" — this records
-- a pending-verification row so Abibou can check Wave and activate
-- the account manually. No automated webhook for this path (unlike
-- PayDunya's own flow, which stays intact and untouched).
--
-- Copy ALL of this file into a new query in the Supabase SQL
-- Editor and click Run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.paiements_en_attente (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text,
  montant integer,
  statut text default 'en_attente_verification',
  created_at timestamptz default now()
);

ALTER TABLE public.paiements_en_attente ENABLE ROW LEVEL SECURITY;

CREATE POLICY "paiements_insert_own" ON public.paiements_en_attente
  FOR INSERT WITH CHECK (auth.uid() = user_id);
