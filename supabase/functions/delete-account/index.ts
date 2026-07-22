// ============================================================
// Prédicta — delete-account edge function
//
// Permanently deletes the caller's account. Auth deletion requires
// the service_role key (the admin API is never exposed to the
// browser), so this has to run server-side. Deleting the
// auth.users row cascades (via "on delete cascade" foreign keys in
// supabase/schema.sql) to profiles, sessions, brain_metrics,
// predictions, daily_lessons and lesson_progress — nothing else to
// clean up manually.
//
// Deploy with:
//   supabase functions deploy delete-account
//   (reuses the SUPABASE_SERVICE_ROLE_KEY secret already set for
//   daily-lesson / coach-chat)
//
// Frontend: js/supabase-client.js -> predictaDeleteAccount()
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
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

  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userData.user.id);
  if (deleteError) {
    console.error('[delete-account] deleteUser error', deleteError);
    return json({ error: 'Suppression impossible pour le moment.' }, 500);
  }

  return json({ deleted: true });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
