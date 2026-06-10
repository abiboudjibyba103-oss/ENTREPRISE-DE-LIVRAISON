// ============================================================
// Prédicta — auth-rate-limit edge function
//
// Acts as a thin proxy in front of Supabase Auth's email/OTP
// (magic link) sign-in endpoint. Enforces a hard limit of
// 5 attempts per minute per IP address, on top of Supabase's
// own built-in auth rate limits.
//
// Deploy with:
//   supabase functions deploy auth-rate-limit
//
// Frontend should call this function instead of calling
// `supabase.auth.signInWithOtp` directly when extra protection
// against credential-stuffing / spam sign-up abuse is needed.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000; // 1 minute

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: { email?: string; redirectTo?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return new Response(JSON.stringify({ error: 'Invalid email' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
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
    .eq('route', 'signin')
    .gte('attempted_at', windowStart);

  if (countError) {
    return new Response(JSON.stringify({ error: 'Rate limit check failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  if ((count ?? 0) >= MAX_ATTEMPTS) {
    return new Response(
      JSON.stringify({ error: 'Trop de tentatives. Réessaie dans une minute.' }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    );
  }

  // Record this attempt before issuing the magic link.
  await supabaseAdmin.from('auth_rate_limit').insert({ ip_address: ip, route: 'signin' });

  const { error: signInError } = await supabaseAdmin.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: body.redirectTo,
    },
  });

  if (signInError) {
    return new Response(JSON.stringify({ error: signInError.message }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
