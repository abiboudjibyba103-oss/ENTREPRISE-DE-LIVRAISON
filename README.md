# Prédicta

Site statique (HTML/CSS/JS, sans build) pour Prédicta — coaching cognitif basé sur Supabase.

Fichiers importants:
- `index.html` — landing page.
- `predicta-auth.html` — connexion / inscription.
- `dashboard.html` — tableau de bord utilisateur (mobile-first).
- `js/supabase-client.js` — client Supabase partagé par toutes les pages.
- `supabase/schema.sql` — schéma de base de données, policies RLS et triggers à exécuter dans l'éditeur SQL de Supabase.
- `supabase/functions/` — Edge Functions Supabase (coach IA, enseignement du soir, suppression de compte, rate limiting).

Aucune installation ni étape de build n'est nécessaire : ouvre `index.html`
via un serveur statique (ou déploie le dossier sur Vercel) et c'est prêt.
