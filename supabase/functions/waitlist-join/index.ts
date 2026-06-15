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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REFERRAL_CODE_REGEX = /^[A-Z0-9]{4,16}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: { name?: string; email?: string; phone?: string; ref?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const name = String(body.name ?? '').trim().slice(0, 100);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 255);
  const phone = String(body.phone ?? '').trim().slice(0, 30);
  const refCode = String(body.ref ?? '').trim().toUpperCase().slice(0, 16);

  if (!name) return json({ error: 'Le nom est requis.' }, 400);
  if (!EMAIL_REGEX.test(email)) return json({ error: 'Adresse email invalide.' }, 400);
  if (!phone) return json({ error: 'Le numéro de téléphone est requis.' }, 400);

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

  const referredByCode = REFERRAL_CODE_REGEX.test(refCode) ? refCode : null;

  const { data: inserted, error } = await supabaseAdmin
    .from('waitlist')
    .insert({ name, email, phone, referred_by_code: referredByCode })
    .select('referral_code')
    .single();

  if (error) {
    console.error('[waitlist-join] insert error', error);
    return json({ error: "Une erreur est survenue, réessaie dans un instant." }, 500);
  }

  return json({ referralCode: inserted.referral_code, alreadyRegistered: false });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
