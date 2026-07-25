// ============================================================
// Prédicta — update-brain-metrics edge function
//
// Recomputes the user's cognitive profile (5 metrics, 0-100 each)
// from their full session history and upserts a single always-
// current row per user in `brain_metrics` ("Mon Cerveau" page).
// Meant to be called after every finished/interrupted session so
// the profile stays fresh.
//
// Deploy with:
//   supabase functions deploy update-brain-metrics
//
// Frontend: js/supabase-client.js -> predictaUpdateBrainMetrics()
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const MIN_SESSIONS = 3;

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

type SessionRow = {
  duration_min: number | null;
  status: string;
  started_at: string;
  interruption_reason: string | null;
  focus_score: number | null;
};

// CONCENTRATION: average duration of completed sessions, bucketed.
function concentrationScore(completed: SessionRow[]): number {
  if (completed.length === 0) return 20;
  const avgDuration = completed.reduce((sum, s) => sum + (s.duration_min || 0), 0) / completed.length;
  if (avgDuration < 15) return 20;
  if (avgDuration < 30) return 40;
  if (avgDuration < 45) return 60;
  if (avgDuration < 60) return 80;
  return 100;
}

// RÉGULARITÉ: distinct days with at least one session, over the last 14 days.
function regulariteScore(allSessions: SessionRow[]): number {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const distinctDays = new Set(
    allSessions
      .filter((s) => new Date(s.started_at).getTime() >= cutoff)
      .map((s) => s.started_at.slice(0, 10))
  ).size;
  if (distinctDays <= 3) return 20;
  if (distinctDays <= 6) return 40;
  if (distinctDays <= 9) return 60;
  if (distinctDays <= 12) return 80;
  return 100;
}

// RÉSISTANCE AUX INTERRUPTIONS: overall completion rate.
function resistanceScore(allSessions: SessionRow[], completed: SessionRow[]): number {
  if (allSessions.length === 0) return 0;
  return Math.round((completed.length / allSessions.length) * 100);
}

// RÉCUPÉRATION: share of interrupted sessions followed by another
// session started later the same day. No interruptions at all counts
// as a perfect score (nothing to recover from).
function recuperationScore(allSessions: SessionRow[]): number {
  const interrupted = allSessions.filter((s) => s.status === 'interrupted');
  if (interrupted.length === 0) return 100;
  let recovered = 0;
  interrupted.forEach((s) => {
    const day = s.started_at.slice(0, 10);
    const laterSameDay = allSessions.some(
      (other) =>
        other !== s &&
        other.started_at.slice(0, 10) === day &&
        new Date(other.started_at).getTime() > new Date(s.started_at).getTime()
    );
    if (laterSameDay) recovered += 1;
  });
  return Math.round((recovered / interrupted.length) * 100);
}

// PROGRESSION: average duration of the last 5 completed sessions vs
// the first 5, mapped to a 0-100 score centered on 50 (no change).
// +50% average duration => 100, -50% => 0, clamped.
function progressionScore(completed: SessionRow[]): number {
  const firstFive = completed.slice(0, 5);
  const lastFive = completed.slice(-5);
  const avg = (arr: SessionRow[]) =>
    arr.length ? arr.reduce((sum, s) => sum + (s.duration_min || 0), 0) / arr.length : 0;
  const firstAvg = avg(firstFive);
  const lastAvg = avg(lastFive);
  if (firstAvg === 0) return 50;
  const percentChange = (lastAvg - firstAvg) / firstAvg;
  return Math.round(Math.min(100, Math.max(0, 50 + percentChange * 100)));
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

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('[update-brain-metrics] missing required secret(s): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    return json({ error: 'Profil cognitif momentanément indisponible (configuration serveur).' }, 500);
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

  // Cooldown: this function is called automatically in the background
  // after every finished/interrupted session, with no rate limiting of
  // its own. Without this, a user rapidly starting/stopping sessions
  // (or replaying the same request) could trigger a full session-history
  // scan + upsert on every call. Serve the just-computed snapshot back
  // instead of recomputing within the cooldown window.
  const COOLDOWN_MS = 5000;
  const { data: existing } = await supabaseAdmin
    .from('brain_metrics')
    .select('concentration, regularite, regulation, recuperation, progression, recorded_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing && Date.now() - new Date(existing.recorded_at).getTime() < COOLDOWN_MS) {
    return json({
      notEnoughData: false,
      concentration: existing.concentration,
      regularite: existing.regularite,
      regulation: existing.regulation,
      recuperation: existing.recuperation,
      progression: existing.progression,
    });
  }

  const { data: allSessions } = await supabaseAdmin
    .from('sessions')
    .select('duration_min, status, started_at, interruption_reason, focus_score')
    .eq('user_id', user.id)
    .order('started_at', { ascending: true });

  if (!allSessions || allSessions.length < MIN_SESSIONS) {
    return json({ notEnoughData: true });
  }

  const completed = allSessions.filter((s) => s.status === 'completed');

  const metrics = {
    concentration: concentrationScore(completed),
    regularite: regulariteScore(allSessions),
    regulation: resistanceScore(allSessions, completed),
    recuperation: recuperationScore(allSessions),
    progression: progressionScore(completed),
  };

  const { error: upsertError } = await supabaseAdmin.from('brain_metrics').upsert(
    {
      user_id: user.id,
      concentration: metrics.concentration,
      regularite: metrics.regularite,
      regulation: metrics.regulation,
      recuperation: metrics.recuperation,
      progression: metrics.progression,
      recorded_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );

  if (upsertError) {
    console.error('[update-brain-metrics] upsert error', upsertError);
    return json({ error: 'Impossible de mettre à jour ton profil cognitif.' }, 500);
  }

  return json({ notEnoughData: false, ...metrics });
});
