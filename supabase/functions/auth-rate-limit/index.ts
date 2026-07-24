// ============================================================
// Prédicta — auth-rate-limit edge function
//
// Thin proxy in front of Supabase Auth's email/password sign-in
// and sign-up endpoints. Enforces a hard limit of 5 attempts per
// minute per IP address (per route), on top of Supabase's own
// built-in auth rate limits — this is what actually stops
// credential-stuffing and sign-up spam, since calling
// `supabase.auth.signInWithPassword` / `signUp` directly from the
// browser has no app-level rate limiting at all.
//
// Runs with the service_role key so it can call signInWithPassword
// / signUp server-side; the resulting session's access/refresh
// tokens are handed back to the client, which loads them into its
// own client-side session via `supabase.auth.setSession(...)`.
//
// Deploy with:
//   supabase functions deploy auth-rate-limit
//
// Frontend: js/supabase-client.js -> predictaSignInWithPassword() / predictaSignUpWithPassword()
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000; // 1 minute

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// Comma-separated list of allowed frontend origins, e.g.
// "https://predicta.example.com,https://www.predicta.example.com".
// Not set => '*' (current behavior), so this ships without breaking
// anything until you opt in with: supabase secrets set APP_ORIGIN=...
const APP_ORIGINS = (Deno.env.get('APP_ORIGIN') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowOrigin = APP_ORIGINS.length === 0
    ? '*'
    : (APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REFERRAL_CODE_REGEX = /^[A-Z0-9]{4,16}$/;

Deno.serve(async (req) => {
  const CORS_HEADERS = corsHeadersFor(req);
  function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('[auth-rate-limit] missing required secret(s): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    return json({ error: 'Authentification momentanément indisponible (configuration serveur).' }, 500);
  }

  let body: {
    mode?: string;
    email?: string;
    password?: string;
    displayName?: string;
    referralCode?: string;
    emailRedirectTo?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const mode = body.mode === 'signup' ? 'signup' : 'signin';
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');

  if (!EMAIL_REGEX.test(email)) {
    return json({ error: 'Adresse email invalide' }, 400);
  }
  if (mode === 'signup' && password.length < 8) {
    return json({ error: 'Le mot de passe doit contenir au moins 8 caractères' }, 400);
  }
  if (mode === 'signin' && !password) {
    return json({ error: 'Mot de passe requis' }, 400);
  }

  // Identify the caller's IP (Supabase Edge Functions run behind a proxy
  // that sets x-forwarded-for; the first entry is the original client IP).
  const forwardedFor = req.headers.get('x-forwarded-for') ?? '';
  const ip = forwardedFor.split(',')[0].trim() || 'unknown';

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  const { count, error: countError } = await supabaseAdmin
    .from('auth_rate_limit')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .eq('route', mode)
    .gte('attempted_at', windowStart);

  if (countError) {
    console.error('[auth-rate-limit] count error', countError);
    return json({ error: 'Vérification impossible pour le moment.' }, 500);
  }

  if ((count ?? 0) >= MAX_ATTEMPTS) {
    return json({ error: 'Trop de tentatives. Réessaie dans une minute.' }, 429);
  }

  // Record this attempt before calling Supabase Auth, so a burst of
  // concurrent requests can't all slip through under the same count.
  await supabaseAdmin.from('auth_rate_limit').insert({ ip_address: ip, route: mode });

  if (mode === 'signin') {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (error) {
      return json({ error: error.message }, 400);
    }
    return json({
      user: data.user,
      session: data.session
        ? { access_token: data.session.access_token, refresh_token: data.session.refresh_token }
        : null,
    });
  }

  // mode === 'signup'
  const displayName = String(body.displayName ?? '').trim().slice(0, 80) || email.split('@')[0];
  const signUpData: Record<string, string> = { display_name: displayName };
  const referralCode = String(body.referralCode ?? '').trim().toUpperCase().slice(0, 16);
  if (REFERRAL_CODE_REGEX.test(referralCode)) {
    signUpData.referral_code = referralCode;
  }
  const emailRedirectTo = typeof body.emailRedirectTo === 'string' ? body.emailRedirectTo : undefined;

  const { data, error } = await supabaseAdmin.auth.signUp({
    email,
    password,
    options: { data: signUpData, emailRedirectTo },
  });
  if (error) {
    return json({ error: error.message }, 400);
  }

  // Best-effort waitlist capture. Runs with the service role so it never
  // depends on the caller's own RLS grants (the new account isn't signed
  // in on this server-side client, unlike the previous client-side insert).
  await supabaseAdmin
    .from('waitlist')
    .insert({ user_id: data.user?.id ?? null, email, name: displayName })
    .select()
    .maybeSingle();

  return json({
    user: data.user,
    session: data.session
      ? { access_token: data.session.access_token, refresh_token: data.session.refresh_token }
      : null,
  });
});
