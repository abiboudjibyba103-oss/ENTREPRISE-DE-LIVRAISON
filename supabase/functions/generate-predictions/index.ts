// ============================================================
// Prédicta — generate-predictions edge function
//
// Analyzes the user's full session history and asks an LLM (Llama
// 3.3 70B via Groq) for 3 short, personalized behavioral predictions
// in French, grounded in real computed metrics (hardest day of the
// week, best time slot, most frequent interruption cause, average
// session length, 7-day trend). Cached per user/day in `predictions`
// (3 rows, one per prediction) so re-opening the Prédictions page
// doesn't regenerate it — it IS regenerated the next time it's
// called on a new day, or the first time it's called with enough
// data.
//
// Deploy with:
//   supabase functions deploy generate-predictions
//   (reuses the GROQ_API_KEY secret already set for coach-chat / daily-lesson)
//
// Frontend: js/supabase-client.js -> predictaGeneratePredictions()
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY');

const PREDICTION_MODEL = 'llama-3.3-70b-versatile';
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

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

type SessionRow = {
  duration_min: number | null;
  status: string;
  started_at: string;
  interruption_reason: string | null;
};

function computeMetrics(sessions: SessionRow[]) {
  // 1. Hardest day of the week: lowest completion rate, needs at
  // least 2 sessions on that weekday to mean anything.
  const byDay = new Map<number, { total: number; completed: number }>();
  sessions.forEach((s) => {
    const d = new Date(s.started_at).getDay();
    const stats = byDay.get(d) ?? { total: 0, completed: 0 };
    stats.total += 1;
    if (s.status === 'completed') stats.completed += 1;
    byDay.set(d, stats);
  });
  let hardestDay: { day: string; rate: number; total: number } | null = null;
  let hardestRate = Infinity;
  for (const [d, stats] of byDay) {
    if (stats.total < 2) continue;
    const rate = stats.completed / stats.total;
    if (rate < hardestRate) {
      hardestRate = rate;
      hardestDay = { day: DAY_NAMES[d], rate, total: stats.total };
    }
  }

  // 2. Best time slot: highest average duration among completed
  // sessions (same 3-bucket definition used by the dashboard's own
  // "Mon Cerveau" best-slot card, for consistency across the app).
  const slots: Record<string, number[]> = {
    'matin (5h-12h)': [],
    'après-midi (12h-18h)': [],
    'soir (18h-24h)': [],
  };
  sessions
    .filter((s) => s.status === 'completed' && s.duration_min != null)
    .forEach((s) => {
      const h = new Date(s.started_at).getHours();
      if (h >= 5 && h < 12) slots['matin (5h-12h)'].push(s.duration_min as number);
      else if (h >= 12 && h < 18) slots['après-midi (12h-18h)'].push(s.duration_min as number);
      else if (h >= 18 && h < 24) slots['soir (18h-24h)'].push(s.duration_min as number);
    });
  let bestSlot: { slot: string; avg: number; count: number } | null = null;
  let bestAvg = -Infinity;
  for (const [slot, durations] of Object.entries(slots)) {
    if (durations.length === 0) continue;
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestSlot = { slot, avg, count: durations.length };
    }
  }

  // 3. Most frequent interruption cause.
  const reasons = sessions
    .filter((s) => s.status === 'interrupted' && s.interruption_reason)
    .map((s) => s.interruption_reason as string);
  let topReason: { reason: string; count: number; total: number } | null = null;
  if (reasons.length > 0) {
    const counts = new Map<string, number>();
    reasons.forEach((r) => counts.set(r, (counts.get(r) ?? 0) + 1));
    const [reason, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    topReason = { reason, count, total: reasons.length };
  }

  // 4. Average duration of completed sessions.
  const completed = sessions.filter((s) => s.status === 'completed' && s.duration_min != null);
  const avgDuration = completed.length
    ? completed.reduce((sum, s) => sum + (s.duration_min as number), 0) / completed.length
    : null;

  // 5. Trend: completion rate over the last 7 days vs the 7 days
  // before that.
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const last7 = sessions.filter((s) => now - new Date(s.started_at).getTime() <= 7 * DAY_MS);
  const prev7 = sessions.filter((s) => {
    const age = now - new Date(s.started_at).getTime();
    return age > 7 * DAY_MS && age <= 14 * DAY_MS;
  });
  const completionRate = (arr: SessionRow[]) =>
    arr.length ? arr.filter((s) => s.status === 'completed').length / arr.length : null;
  const rateLast7 = completionRate(last7);
  const ratePrev7 = completionRate(prev7);
  let trend: { direction: string; rateLast7: number; ratePrev7: number } | null = null;
  if (rateLast7 != null && ratePrev7 != null) {
    const direction =
      rateLast7 > ratePrev7 + 0.05 ? 'amélioration' : rateLast7 < ratePrev7 - 0.05 ? 'dégradation' : 'stable';
    trend = { direction, rateLast7, ratePrev7 };
  }

  return {
    hardestDay,
    bestSlot,
    topReason,
    avgDuration,
    completedCount: completed.length,
    totalCount: sessions.length,
    trend,
  };
}

function buildDataLines(metrics: ReturnType<typeof computeMetrics>): string[] {
  const lines = [`Nombre total de sessions: ${metrics.totalCount} (${metrics.completedCount} complétée(s))`];
  if (metrics.hardestDay) {
    lines.push(
      `Jour le plus difficile: ${metrics.hardestDay.day} (${Math.round(metrics.hardestDay.rate * 100)}% de sessions complétées sur ${metrics.hardestDay.total} sessions ce jour-là)`
    );
  }
  if (metrics.bestSlot) {
    lines.push(
      `Meilleure tranche horaire: ${metrics.bestSlot.slot}, durée moyenne ${Math.round(metrics.bestSlot.avg)} min sur ${metrics.bestSlot.count} session(s) complétée(s)`
    );
  }
  if (metrics.topReason) {
    lines.push(
      `Cause d'interruption la plus fréquente: "${metrics.topReason.reason}" (${metrics.topReason.count} fois sur ${metrics.topReason.total} interruption(s))`
    );
  }
  if (metrics.avgDuration != null) {
    lines.push(`Durée moyenne des sessions complétées: ${Math.round(metrics.avgDuration)} min`);
  }
  if (metrics.trend) {
    lines.push(
      `Tendance sur les 7 derniers jours vs les 7 précédents: ${metrics.trend.direction} (${Math.round(metrics.trend.rateLast7 * 100)}% de complétion cette semaine vs ${Math.round(metrics.trend.ratePrev7 * 100)}% la semaine précédente)`
    );
  }
  return lines;
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

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !GROQ_API_KEY) {
    console.error('[generate-predictions] missing required secret(s): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY');
    return json({ error: 'Prédictions momentanément indisponibles (configuration serveur).' }, 500);
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

  const today = new Date().toISOString().slice(0, 10);

  // Cache hit: today's 3 predictions already exist — return them
  // without spending another Groq call. Without this, simply opening
  // the Prédictions page would burn a Groq call every single time.
  const { data: cached } = await supabaseAdmin
    .from('predictions')
    .select('prediction_text, prediction_index')
    .eq('user_id', user.id)
    .eq('prediction_date', today)
    .order('prediction_index', { ascending: true });

  if (cached && cached.length === 3) {
    return json({ predictions: cached.map((p) => p.prediction_text), notEnoughData: false });
  }

  const { data: allSessions } = await supabaseAdmin
    .from('sessions')
    .select('duration_min, status, started_at, interruption_reason')
    .eq('user_id', user.id)
    .order('started_at', { ascending: true });

  if (!allSessions || allSessions.length < MIN_SESSIONS) {
    return json({ predictions: [], notEnoughData: true });
  }

  const metrics = computeMetrics(allSessions);
  const dataLines = buildDataLines(metrics);

  const systemPrompt = `Tu es le moteur de prédiction de Prédicta.
Analyse les données de sessions de cet utilisateur et génère exactement 3 prédictions personnalisées en français.
Chaque prédiction doit être une phrase courte et précise basée sur les données réelles ci-dessous.
Exemples de bon format:
- "Tu as 75% de chances de décrocher avant 45 minutes le lundi"
- "Ton meilleur créneau est le matin entre 8h et 11h"
- "Tu interromps tes sessions 2x plus souvent quand tu travailles l'après-midi"
N'invente jamais de données : base-toi uniquement sur les faits listés ci-dessous. Si une donnée n'est pas disponible, n'en parle pas.
Réponds UNIQUEMENT avec un JSON: {"predictions": ["pred1", "pred2", "pred3"]}

Données de l'utilisateur:
${dataLines.join('\n')}`;

  let aiRes: Response;
  try {
    aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: PREDICTION_MODEL,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Génère mes 3 prédictions basées sur mes données réelles.' },
        ],
      }),
    });
  } catch (err) {
    console.error('[generate-predictions] fetch error', err);
    return json({ error: 'Prédictions momentanément indisponibles.' }, 502);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error('[generate-predictions] Groq error', aiRes.status, errText);
    return json({ error: 'Prédictions momentanément indisponibles.' }, 502);
  }

  const aiData = await aiRes.json();
  const rawContent: string = aiData.choices?.[0]?.message?.content?.trim() || '';

  let predictions: string[] = [];
  try {
    const parsed = JSON.parse(rawContent);
    if (Array.isArray(parsed.predictions)) {
      predictions = parsed.predictions
        .filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p: string) => p.trim().slice(0, 500))
        .slice(0, 3);
    }
  } catch (err) {
    console.error('[generate-predictions] JSON parse error', err, rawContent);
  }

  if (predictions.length !== 3) {
    console.error('[generate-predictions] unexpected prediction count', predictions.length, rawContent);
    return json({ error: 'Impossible de générer tes prédictions pour le moment, réessaie plus tard.' }, 502);
  }

  const rows = predictions.map((text, i) => ({
    user_id: user.id,
    prediction_text: text,
    prediction_date: today,
    prediction_index: i,
  }));

  const { error: upsertError } = await supabaseAdmin
    .from('predictions')
    .upsert(rows, { onConflict: 'user_id,prediction_date,prediction_index' });

  if (upsertError) {
    console.error('[generate-predictions] upsert error', upsertError);
  }

  return json({ predictions, notEnoughData: false });
});
