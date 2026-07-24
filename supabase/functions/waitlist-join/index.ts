// ============================================================
// Prédicta — waitlist-join edge function
//
// Pre-launch sign-up: registers a name + email + phone on the
// waitlist, links the signup to a referrer via their referral
// code, and returns the new signup's own referral code so the
// landing page can build their shareable link.
//
// Deploy with:
//   supabase functions deploy waitlist-join
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

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

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000; // 1 minute

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
    console.error('[waitlist-join] missing required secret(s): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    return json({ error: 'Inscription momentanément indisponible (configuration serveur).' }, 500);
  }

  let body: { name?: string; email?: string; ref?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const name = String(body.name ?? '').trim().slice(0, 100);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 255);
  const refCode = String(body.ref ?? '').trim().toUpperCase().slice(0, 16);

  if (!name) return json({ error: 'Le prénom est requis.' }, 400);
  if (!EMAIL_REGEX.test(email)) return json({ error: 'Adresse email invalide.' }, 400);

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Rate limit: at most 5 sign-up attempts per minute per IP.
  const forwardedFor = req.headers.get('x-forwarded-for') ?? '';
  const ip = forwardedFor.split(',')[0].trim() || 'unknown';
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  const { count } = await supabaseAdmin
    .from('auth_rate_limit')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .eq('route', 'waitlist-join')
    .gte('attempted_at', windowStart);

  if ((count ?? 0) >= MAX_ATTEMPTS) {
    return json({ error: 'Trop de tentatives. Réessaie dans une minute.' }, 429);
  }

  await supabaseAdmin.from('auth_rate_limit').insert({ ip_address: ip, route: 'waitlist-join' });

  // Already on the list? Return their existing referral code instead of
  // erroring, so resubmitting the form (or a duplicate click) is harmless.
  const { data: existing } = await supabaseAdmin
    .from('waitlist')
    .select('referral_code')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    return json({ referralCode: existing.referral_code, alreadyRegistered: true });
  }

  let referredByCode: string | null = null;
  if (REFERRAL_CODE_REGEX.test(refCode)) {
    const { data: referrer } = await supabaseAdmin
      .from('waitlist')
      .select('referral_code')
      .eq('referral_code', refCode)
      .maybeSingle();
    if (referrer) referredByCode = refCode;
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('waitlist')
    .insert({ name, email, referred_by_code: referredByCode })
    .select('referral_code')
    .single();

  if (error) {
    console.error('[waitlist-join] insert error', error);
    return json({ error: "Une erreur est survenue, réessaie dans un instant." }, 500);
  }

  return json({ referralCode: inserted.referral_code, alreadyRegistered: false });
});
