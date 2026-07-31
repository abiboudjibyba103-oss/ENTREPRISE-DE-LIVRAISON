// ============================================================
// Prédicta — paydunya-payment edge function
//
// Initiates a PayDunya checkout for the Plan Pro subscription
// (4900 FCFA/month). SANDBOX ONLY for now: PAYDUNYA_API_URL below is
// hardcoded to PayDunya's sandbox checkout-invoice/create endpoint,
// never the live one. Do not point it at the production endpoint
// (https://app.paydunya.com/api/v1/checkout-invoice/create) or swap
// in live keys until real payments are actually wanted.
//
// The amount and description are hardcoded here, never taken from
// the client request body — a client could otherwise ask this
// function to create an invoice for 1 FCFA and nothing would catch it.
//
// Scope note: this function only creates the checkout link. It does
// NOT flip profiles.plan to 'pro' after a successful payment — that
// requires a PayDunya IPN/webhook handler (a separate function, not
// built here) that verifies the payment server-side and updates the
// DB with the service role key. Until that exists, completing a
// sandbox payment will NOT change what the dashboard shows; see the
// deploy notes for how to flip a test account manually in the
// meantime.
//
// Deploy with:
//   supabase functions deploy paydunya-payment
//
// Frontend: js/supabase-client.js -> predictaInitiatePayment()
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const PAYDUNYA_MASTER_KEY = Deno.env.get('PAYDUNYA_MASTER_KEY');
const PAYDUNYA_PRIVATE_KEY = Deno.env.get('PAYDUNYA_PRIVATE_KEY');
// Not sent to PayDunya by this function (checkout-invoice/create only
// needs MASTER/PRIVATE/TOKEN below) — PayDunya's public key is for
// client-side/widget integrations. Still required and validated here
// so a half-configured PayDunya integration fails fast instead of
// silently working with only 3 of the 4 keys set.
const PAYDUNYA_PUBLIC_KEY = Deno.env.get('PAYDUNYA_PUBLIC_KEY');
const PAYDUNYA_TOKEN = Deno.env.get('PAYDUNYA_TOKEN');
// Canonical site URL used to build the checkout's return/cancel
// links, e.g. https://predicta.vercel.app — no trailing slash.
const APP_URL = Deno.env.get('APP_URL');

const PAYDUNYA_API_URL = 'https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create';

const PRO_PLAN_AMOUNT_FCFA = 4900;
const PRO_PLAN_DESCRIPTION = 'Prédicta Plan Pro — Abonnement mensuel';

// Comma-separated list of allowed frontend origins — same convention
// as every other Prédicta edge function. Not set => '*'.
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

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PAYDUNYA_MASTER_KEY || !PAYDUNYA_PRIVATE_KEY || !PAYDUNYA_PUBLIC_KEY || !PAYDUNYA_TOKEN || !APP_URL) {
    console.error('[paydunya-payment] missing required secret(s): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYDUNYA_MASTER_KEY, PAYDUNYA_PRIVATE_KEY, PAYDUNYA_PUBLIC_KEY, PAYDUNYA_TOKEN, APP_URL');
    return json({ error: 'Paiement momentanément indisponible (configuration serveur).' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const user = userData.user;

  const payload = {
    invoice: {
      total_amount: PRO_PLAN_AMOUNT_FCFA,
      description: PRO_PLAN_DESCRIPTION,
    },
    store: {
      name: 'Prédicta',
    },
    actions: {
      cancel_url: `${APP_URL}/predicta-dashboard.html`,
      return_url: `${APP_URL}/predicta-dashboard.html?paiement=success`,
    },
    // Lets a future IPN/webhook handler match the PayDunya payment
    // back to this user without guessing from the email alone.
    custom_data: {
      user_id: user.id,
    },
  };

  let pdRes: Response;
  try {
    pdRes = await fetch(PAYDUNYA_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PAYDUNYA-MASTER-KEY': PAYDUNYA_MASTER_KEY,
        'PAYDUNYA-PRIVATE-KEY': PAYDUNYA_PRIVATE_KEY,
        'PAYDUNYA-TOKEN': PAYDUNYA_TOKEN,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[paydunya-payment] fetch error', err);
    return json({ error: 'Paiement momentanément indisponible.' }, 502);
  }

  const pdData = await pdRes.json().catch(() => null);

  // On success, PayDunya's own `response_text` field IS the checkout
  // URL itself (not a human-readable message) — that's PayDunya's API
  // convention, not a bug here. `response_code` "00" means success.
  if (!pdRes.ok || !pdData || pdData.response_code !== '00' || !pdData.response_text) {
    console.error('[paydunya-payment] PayDunya error', pdRes.status, pdData);
    return json({ error: 'Impossible de créer le paiement pour le moment, réessaie plus tard.' }, 502);
  }

  return json({ paymentUrl: pdData.response_text, invoiceToken: pdData.token ?? null });
});
