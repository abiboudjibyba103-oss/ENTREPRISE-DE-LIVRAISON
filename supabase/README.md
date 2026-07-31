# Prédicta — Supabase setup

## 1. Apply the schema

In the Supabase dashboard → SQL editor, run `supabase/schema.sql`.
It creates:

- `profiles`, `sessions`, `lesson_progress`, `brain_metrics`, `predictions`, `waitlist`, `auth_rate_limit`
- **Row Level Security enabled on every table**
- Policies so each authenticated user can `select` / `insert` / `update` / `delete`
  **only their own rows** (`auth.uid() = user_id` / `auth.uid() = id`)
- A trigger that auto-creates a `profiles` row when a new user signs up via Supabase Auth

The `waitlist` table only allows anonymous `insert` (used by the landing page
email form) — reading it requires the `service_role` key, which is never
exposed to the browser.

The `auth_rate_limit` table has RLS enabled with **no policies**, so it is
only reachable via the `service_role` key inside the edge function below.

## 2. Environment variables

`.env` (already created, gitignored) and `.env.example` (committed) contain:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

The anon/"publishable" key is safe to ship to the browser — all data access
is governed by the RLS policies above, not by keeping this key secret.

The `SUPABASE_SERVICE_ROLE_KEY` used by the edge function below must be set
as a **function secret** (`supabase secrets set ...`), never committed and
never sent to the browser.

## 3. Authentication

The landing page (`index.html`) and dashboard
(`predicta-dashboard.html`) use `js/supabase-client.js`:

- `predictaSignInWithEmail(email)` — sends a magic-link (passwordless) email
  via `supabase.auth.signInWithOtp`, and records the email in `waitlist`.
- `predictaRequireAuth()` — called on dashboard load; redirects to the
  landing page if there is no active session.
- `predictaSignOut()` — signs out and redirects to the landing page.

This is the "identify the connected user" mechanism: every Supabase request
from the browser automatically carries the user's JWT, and RLS policies use
`auth.uid()` from that JWT to scope rows to the connected user.

## 4. Server-side validation

Because this project currently ships as static HTML (no custom backend),
the "API" is Supabase's auto-generated PostgREST API. Server-side validation
is enforced at the database layer via:

- `CHECK` constraints (e.g. `duration_min between 1 and 240`,
  `lesson_id ~ '^[A-F][1-5]$'`, `status in (...)`)
- RLS `with check` clauses that prevent writing rows for another user
- Foreign keys to `auth.users`

`js/supabase-client.js` also validates inputs client-side before sending
requests (fast feedback for the UI), but this is **not** the security
boundary — the database constraints/policies are.

## 5. Rate limiting (5 attempts / minute / IP)

Two layers:

1. Supabase Auth has built-in rate limiting on OTP/magic-link emails
   (configurable in Dashboard → Authentication → Rate Limits).
2. `supabase/functions/auth-rate-limit/index.ts` is an edge function that
   enforces a hard **5 requests / minute / IP** limit using the
   `auth_rate_limit` table, before forwarding to `supabase.auth.signInWithOtp`.

Deploy it with:

```
supabase functions deploy auth-rate-limit
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
```

Then point the frontend at
`https://<project-ref>.functions.supabase.co/auth-rate-limit` instead of
calling `supabase.auth.signInWithOtp` directly, if you want the extra layer.

## 6. AI Coach (`coach-chat` edge function)

`supabase/functions/coach-chat/index.ts` powers the "Coach IA" chat on the
dashboard:

- The caller's Supabase JWT is verified server-side (`supabaseAdmin.auth.getUser`).
- The function loads the user's own `profiles`, recent `sessions`,
  `lesson_progress` and latest `brain_metrics` rows (service role, scoped to
  `user.id` — never trusts a user id from the request body).
- It builds a French system prompt grounded in that real data and calls
  Groq's OpenAI-compatible Chat Completions API (Llama 3.1 70B) for a short
  (2-4 sentence), personalized reply.
- Each reply is also stored in `predictions` for that user.

Deploy it with:

```
supabase functions deploy coach-chat
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
supabase secrets set GROQ_API_KEY=...
```

Get a Groq API key at https://console.groq.com (free tier available).

Frontend usage: `predictaCoachChat(message, history)` in
`js/supabase-client.js`. Each reply is logged to the `predictions` table,
which is what the dashboard's "Prédictions" page reads.

## 8. Daily lesson (`daily-lesson` edge function)

`supabase/functions/daily-lesson/index.ts` generates the "enseignement du
soir" shown on the dashboard's Accueil page: one AI-written teaching per
user per day, grounded in that day's real sessions, cached in
`daily_lessons` and regenerated whenever a session finishes more recently
than the cached lesson (see `migration_daily_lessons_updated_at.sql`).
Deploy it the same way as `coach-chat` (reuses the same `GROQ_API_KEY`
secret). Frontend usage: `predictaDailyLesson()` in `js/supabase-client.js`.

## 9. Account deletion (`delete-account` edge function)

`supabase/functions/delete-account/index.ts` deletes the caller's
`auth.users` row (service role only — the browser never has admin
rights), which cascades to every table that references it
(`profiles`, `sessions`, `brain_metrics`, `predictions`, `daily_lessons`,
`lesson_progress`). Deploy with:

```
supabase functions deploy delete-account
```

Frontend usage: `predictaDeleteAccount()` in `js/supabase-client.js`,
called from the dashboard's Réglages page.

## 10. `migration_dashboard.sql`

Run `supabase/migration_dashboard.sql` in the SQL editor if your database
was created before the mobile dashboard was added — it adds
`sessions.interruption_reason` and `profiles.evening_lesson_hour`
(both are already part of a fresh `schema.sql` run).

## 7. Dependency audit

`package.json` dependencies were bumped to current patched versions
(`react`/`react-dom` 18.3.1, `vite` 5.4.6, `@vitejs/plugin-react` 4.3.1,
`postcss` 8.4.45, `autoprefixer` 10.4.20, `gsap` 3.12.5, `lucide-react`
0.441.0) and `@supabase/supabase-js` 2.45.4 was added. Run `npm install` to
refresh `package-lock.json` (this sandbox has no registry access, so the
lockfile could not be regenerated here).

## 11. PayDunya payments (`paydunya-payment` + `paydunya-webhook`)

Plan Pro (4900 FCFA/month) is required to use the dashboard at all —
`predicta-dashboard.html`'s `init()` shows a payment-lock screen instead of
the app whenever `profiles.plan !== 'pro'`.

- `paydunya-payment/index.ts`: creates a PayDunya sandbox checkout for the
  authenticated user (amount/description hardcoded server-side) and returns
  the checkout URL. Frontend usage: `predictaInitiatePayment()` in
  `js/supabase-client.js`, called from the landing page's signup flow
  (`payerEtEntrer()`) and the dashboard's Réglages/lock screen
  (`passerAuPro()`).
- `paydunya-webhook/index.ts`: receives PayDunya's IPN callback, but never
  trusts its body directly — it re-confirms the payment against PayDunya's
  own `checkout-invoice/confirm` endpoint using our own keys, records the
  invoice in `paydunya_payments` (unique on `invoice_token`, so retried
  IPN calls are a no-op), and only then sets `profiles.plan = 'pro'` /
  `plan_expire_at`. Deploy with `--no-verify-jwt` (PayDunya calls this with
  no Supabase auth header).

Required secrets (sandbox test keys, from PayDunya → Mon compte → API &
Config): `PAYDUNYA_MASTER_KEY`, `PAYDUNYA_PRIVATE_KEY`,
`PAYDUNYA_PUBLIC_KEY`, `PAYDUNYA_TOKEN`, plus `APP_URL` (the deployed
site's canonical origin, no trailing slash, used to build the checkout's
return/cancel links).

```
supabase secrets set PAYDUNYA_MASTER_KEY=... PAYDUNYA_PRIVATE_KEY=... PAYDUNYA_PUBLIC_KEY=... PAYDUNYA_TOKEN=... APP_URL=https://...
supabase functions deploy paydunya-payment
supabase functions deploy paydunya-webhook --no-verify-jwt
```

Run `supabase/migration_profiles_plan_expire.sql` and
`supabase/migration_paydunya_payments.sql` in the SQL editor first (both
already part of a fresh `schema.sql` run).

SANDBOX ONLY: both functions hardcode PayDunya's sandbox URLs. Switching to
production requires updating both `PAYDUNYA_API_URL` (paydunya-payment) and
`PAYDUNYA_CONFIRM_URL_PREFIX` (paydunya-webhook) together, and swapping in
live keys.
