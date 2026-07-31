// ============================================================
// Prédicta — paydunya-webhook edge function
//
// Receives PayDunya's IPN callback after a checkout completes (set as
// `actions.callback_url` by paydunya-payment) and flips profiles.plan
// to 'pro' once a payment is genuinely confirmed. This is what
// actually unlocks the dashboard — see predicta-dashboard.html's
// payment-lock screen.
//
// SECURITY: the incoming POST body is never trusted directly (PayDunya's
// documented IPN "hash" is just sha512(masterKey) — a static value an
// attacker who ever saw one real callback could replay forever). Instead,
// only the invoice token is read from the callback; the actual payment
// status and custom_data are fetched independently from PayDunya's own
// checkout-invoice/confirm endpoint, authenticated with our own keys.
// Nothing here is unlocked based on data an attacker could forge by
// POSTing to this URL directly.
//
// Idempotency: PayDunya resends the IPN until it gets a 200, and the
// confirm endpoint can be re-queried freely — profiles.plan_expire_at
// must not be pushed forward on every retry, so a row is inserted into
// paydunya_payments (unique on invoice_token) BEFORE updating profiles;
// a duplicate insert (already processed) short-circuits before any write.
//
// SANDBOX ONLY for now — same sandbox checkout-invoice/confirm endpoint
// as paydunya-payment's create call. Switch both together when going live.
//
// Deploy with:
//   supabase functions deploy paydunya-webhook --no-verify-jwt
//   (PayDunya's servers call this directly, with no Supabase auth header
//   — --no-verify-jwt is required or every callback gets rejected with 401
//   before this code even runs)
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const PAYDUNYA_MASTER_KEY = Deno.env.get('PAYDUNYA_MASTER_KEY');
const PAYDUNYA_PRIVATE_KEY = Deno.env.get('PAYDUNYA_PRIVATE_KEY');
const PAYDUNYA_TOKEN = Deno.env.get('PAYDUNYA_TOKEN');

const PAYDUNYA_CONFIRM_URL_PREFIX = 'https://app.paydunya.com/sandbox-api/v1/checkout-invoice/confirm/';

const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 1 month

// PayDunya's IPN shape varies by integration path (JSON body, or
// form-encoded with a `data` field holding a JSON string, or bracket
// notation). Every shape we've seen documented is tried here; if
// PayDunya sends something else, check `supabase functions logs
// paydunya-webhook` for the raw body and adjust this function.
async function extractInvoiceToken(req: Request): Promise<string | null> {
  const contentType = req.headers.get('content-type') ?? '';
  let raw: unknown = null;

  try {
    if (contentType.includes('application/json')) {
      raw = await req.json();
    } else {
      const form = await req.formData();
      const dataField = form.get('data');
      if (typeof dataField === 'string') {
        try { raw = JSON.parse(dataField); } catch { /* fall through */ }
      }
      if (!raw) {
        const bracketToken = form.get('data[invoice][token]') ?? form.get('invoice[token]') ?? form.get('token');
        if (typeof bracketToken === 'string' && bracketToken) return bracketToken;
      }
    }
  } catch (err) {
    console.error('[paydunya-webhook] body parse error', err);
    return null;
  }

  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  return r?.data?.invoice?.token ?? r?.invoice?.token ?? r?.data?.token ?? r?.token ?? null;
}

Deno.serve(async (req) => {
  function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PAYDUNYA_MASTER_KEY || !PAYDUNYA_PRIVATE_KEY || !PAYDUNYA_TOKEN) {
    console.error('[paydunya-webhook] missing required secret(s): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYDUNYA_MASTER_KEY, PAYDUNYA_PRIVATE_KEY, PAYDUNYA_TOKEN');
    // Still 200: this is our own misconfiguration, not something
    // retrying the same callback will fix, and we don't want PayDunya
    // hammering us with retries over it.
    return json({ ok: false, reason: 'server not configured' }, 200);
  }

  const token = await extractInvoiceToken(req);
  if (!token) {
    console.error('[paydunya-webhook] could not find an invoice token in the callback body');
    return json({ ok: false, reason: 'no token in payload' }, 200);
  }

  // Never trust the callback body's own claims about status/amount/user
  // — re-derive all of it from PayDunya directly, using our own keys.
  let confirmData: any = null;
  try {
    const confirmRes = await fetch(`${PAYDUNYA_CONFIRM_URL_PREFIX}${token}`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        'PAYDUNYA-MASTER-KEY': PAYDUNYA_MASTER_KEY,
        'PAYDUNYA-PRIVATE-KEY': PAYDUNYA_PRIVATE_KEY,
        'PAYDUNYA-TOKEN': PAYDUNYA_TOKEN,
      },
    });
    confirmData = await confirmRes.json().catch(() => null);
  } catch (err) {
    console.error('[paydunya-webhook] confirm fetch error', err);
    // 502 here is intentional: this IS worth a PayDunya retry (transient
    // network failure), unlike the cases above.
    return json({ ok: false, reason: 'confirm call failed' }, 502);
  }

  const status: string | undefined = confirmData?.status ?? confirmData?.invoice?.status;
  const customData = confirmData?.custom_data ?? confirmData?.invoice?.custom_data ?? {};
  const userId: string | undefined = customData?.user_id;
  const amount: number | null = confirmData?.invoice?.total_amount ?? confirmData?.total_amount ?? null;

  if (status !== 'completed') {
    // Not an error — PayDunya also calls back for pending/cancelled/failed
    // invoices. Nothing to do.
    return json({ ok: true, status: status ?? 'unknown' });
  }

  if (!userId) {
    console.error('[paydunya-webhook] confirmed payment with no user_id in custom_data', confirmData);
    return json({ ok: false, reason: 'missing user_id' }, 200);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Idempotency gate: only a first-time insert for this invoice_token
  // is allowed to proceed to actually granting Pro access.
  const { error: insertError } = await supabaseAdmin
    .from('paydunya_payments')
    .insert({ user_id: userId, invoice_token: token, status, amount });

  if (insertError) {
    // Unique violation on invoice_token: already processed this exact
    // payment on an earlier call (PayDunya retry) — nothing more to do.
    if (insertError.code === '23505') {
      return json({ ok: true, status: 'already processed' });
    }
    console.error('[paydunya-webhook] paydunya_payments insert error', insertError);
    return json({ ok: false, reason: 'db error' }, 502);
  }

  const { error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({ plan: 'pro', plan_expire_at: new Date(Date.now() + PLAN_DURATION_MS).toISOString() })
    .eq('id', userId);

  if (updateError) {
    console.error('[paydunya-webhook] profiles update error', updateError);
    return json({ ok: false, reason: 'db error' }, 502);
  }

  return json({ ok: true, status: 'pro activated' });
});
