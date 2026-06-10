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

The landing page (`predicta-landing.html`) and dashboard
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

## 6. Dependency audit

`package.json` dependencies were bumped to current patched versions
(`react`/`react-dom` 18.3.1, `vite` 5.4.6, `@vitejs/plugin-react` 4.3.1,
`postcss` 8.4.45, `autoprefixer` 10.4.20, `gsap` 3.12.5, `lucide-react`
0.441.0) and `@supabase/supabase-js` 2.45.4 was added. Run `npm install` to
refresh `package-lock.json` (this sandbox has no registry access, so the
lockfile could not be regenerated here).
