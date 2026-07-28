// ============================================================
// Prédicta — generate-predictions edge function
//
// Detects real repeated behavioral patterns in the user's session
// history (same time-of-day + quick interruption, short sessions
// completed in full, long sessions interrupted, same weekday+slot +
// same interruption reason — each requiring at least 3 real
// occurrences, computed in code, never left to the LLM to invent or
// miscount) and asks an LLM (Llama 3.3 70B via Groq) to phrase each
// one into a short French "mémoire personnalisée":
//   "Les [N] dernières fois que [situation], [ce qui s'est passé]."
// Up to 4 memories, cached per user/day in `predictions` (one row per
// memory, via upsert on user_id+prediction_date+prediction_index) so
// re-opening the Ma mémoire page doesn't regenerate it. Returns
// { predictions: [], notEnoughData: true } when there isn't enough
// data or no pattern repeats often enough yet.
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
const MAX_MEMORIES = 4;

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

type PatternCandidate = { count: number; description: string };

function timeSlotOf(hour: number): string {
  if (hour >= 5 && hour < 12) return 'le matin';
  if (hour >= 12 && hour < 18) return "l'après-midi";
  if (hour >= 18 && hour < 20) return 'en début de soirée';
  return 'tard le soir'; // 20h-5h
}

// Every candidate here requires >= 3 real occurrences to exist at
// all — that's the actual enforcement of "minimum 3 occurrences",
// computed in code rather than trusted to the LLM's obedience.
function computeRepeatedPatterns(sessions: SessionRow[]): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];

  // A. Same time-of-day slot -> quick interruption (before 15 min).
  const bySlotQuickInterrupt = new Map<string, number>();
  sessions.forEach((s) => {
    if (s.status !== 'interrupted' || s.duration_min == null || s.duration_min >= 15) return;
    const slot = timeSlotOf(new Date(s.started_at).getHours());
    bySlotQuickInterrupt.set(slot, (bySlotQuickInterrupt.get(slot) ?? 0) + 1);
  });
  for (const [slot, count] of bySlotQuickInterrupt) {
    if (count >= 3) {
      candidates.push({ count, description: `tu as travaillé ${slot}, tu as interrompu ta session avant 15 minutes` });
    }
  }

  // B. Short sessions (20 min or less) completed all the way through.
  const shortCompleted = sessions.filter((s) => s.status === 'completed' && s.duration_min != null && s.duration_min <= 20);
  if (shortCompleted.length >= 3) {
    candidates.push({
      count: shortCompleted.length,
      description: "tu as commencé par une session courte (20 minutes ou moins), tu l'as menée jusqu'au bout",
    });
  }

  // C. Long sessions (45 min or more) ending in an interruption.
  const longInterrupted = sessions.filter((s) => s.status === 'interrupted' && s.duration_min != null && s.duration_min >= 45);
  if (longInterrupted.length >= 3) {
    candidates.push({
      count: longInterrupted.length,
      description: "tu as travaillé plus de 45 minutes d'affilée, ta session s'est terminée par une interruption",
    });
  }

  // D. Same weekday + time slot -> same interruption reason, repeated.
  const byDaySlotReason = new Map<string, { count: number; day: string; slot: string; reason: string }>();
  sessions.forEach((s) => {
    if (s.status !== 'interrupted' || !s.interruption_reason) return;
    const d = new Date(s.started_at);
    const day = DAY_NAMES[d.getDay()];
    const slot = timeSlotOf(d.getHours());
    const key = `${day}|${slot}|${s.interruption_reason}`;
    const existing = byDaySlotReason.get(key);
    if (existing) existing.count += 1;
    else byDaySlotReason.set(key, { count: 1, day, slot, reason: s.interruption_reason });
  });
  for (const { count, day, slot, reason } of byDaySlotReason.values()) {
    if (count >= 3) {
      candidates.push({
        count,
        description: `tu as lancé une session le ${day} ${slot}, tu l'as interrompue pour la raison : "${reason}"`,
      });
    }
  }

  return candidates.sort((a, b) => b.count - a.count).slice(0, MAX_MEMORIES);
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
    return json({ error: 'Mémoires momentanément indisponibles (configuration serveur).' }, 500);
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

  // Cache hit: today's memories already exist — return them without
  // spending another Groq call. Without this, simply opening the Ma
  // mémoire page would burn a Groq call every single time.
  const { data: cached } = await supabaseAdmin
    .from('predictions')
    .select('prediction_text, prediction_index, occurrence_count')
    .eq('user_id', user.id)
    .eq('prediction_date', today)
    .order('prediction_index', { ascending: true });

  if (cached && cached.length > 0) {
    return json({
      predictions: cached.map((p) => ({ text: p.prediction_text, count: p.occurrence_count ?? 0 })),
      notEnoughData: false,
    });
  }

  // Always re-derive the user's own sessions from our own trusted
  // query, scoped to the authenticated user.id — never from a
  // client-submitted session list, which could be tampered with.
  const { data: allSessions } = await supabaseAdmin
    .from('sessions')
    .select('duration_min, status, started_at, interruption_reason')
    .eq('user_id', user.id)
    .order('started_at', { ascending: true });

  if (!allSessions || allSessions.length < MIN_SESSIONS) {
    return json({ predictions: [], notEnoughData: true });
  }

  const candidates = computeRepeatedPatterns(allSessions);
  if (candidates.length === 0) {
    // No pattern repeats often enough yet — nothing to ask Groq about,
    // so this costs nothing beyond the two queries above.
    return json({ predictions: [], notEnoughData: true });
  }

  const systemPrompt = `Tu es le moteur de mémoire personnalisée de Prédicta.
On te fournit une liste de patterns RÉELS déjà détectés dans les sessions de l'utilisateur, avec leur nombre exact d'occurrences.
Ta seule tâche : transformer CHAQUE pattern fourni en une phrase suivant EXACTEMENT ce format, rien d'autre :
"Les [N] dernières fois que [situation], [ce qui s'est passé]."

Exemples de bon format :
- "Les 3 dernières fois que tu as travaillé après 20h, tu as interrompu ta session avant 15 minutes."
- "Les 4 dernières fois que tu as commencé par une tâche courte, tu as complété ta session jusqu'au bout."
- "Chaque fois que tu as lancé une session le lundi matin, tu l'as interrompue avec la raison 'pensée extérieure'."

Règles strictes :
- N'utilise QUE les patterns fournis ci-dessous, dans le même ordre — n'invente jamais de nouveau pattern, ne change jamais le nombre N fourni.
- Jamais de conseil générique.
- Une phrase par pattern fourni, pas plus, pas moins.
- Réponds UNIQUEMENT avec un JSON : {"memories": ["phrase1", "phrase2", ...]}

Patterns détectés (nombre réel d'occurrences entre parenthèses) :
${candidates.map((c, i) => `${i + 1}. (${c.count} fois) ${c.description}`).join('\n')}`;

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
          { role: 'user', content: 'Transforme ces patterns en mémoires personnalisées, dans le même ordre.' },
        ],
      }),
    });
  } catch (err) {
    console.error('[generate-predictions] fetch error', err);
    return json({ error: 'Mémoires momentanément indisponibles.' }, 502);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error('[generate-predictions] Groq error', aiRes.status, errText);
    return json({ error: 'Mémoires momentanément indisponibles.' }, 502);
  }

  const aiData = await aiRes.json();
  const rawContent: string = aiData.choices?.[0]?.message?.content?.trim() || '';

  let memoryTexts: string[] = [];
  try {
    const parsed = JSON.parse(rawContent);
    if (Array.isArray(parsed.memories)) {
      memoryTexts = parsed.memories
        .filter((m: unknown): m is string => typeof m === 'string' && m.trim().length > 0)
        .map((m: string) => m.trim().slice(0, 500))
        .slice(0, candidates.length);
    }
  } catch (err) {
    console.error('[generate-predictions] JSON parse error', err, rawContent);
  }

  if (memoryTexts.length === 0) {
    console.error('[generate-predictions] no memories returned', rawContent);
    return json({ error: 'Impossible de générer tes mémoires pour le moment, réessaie plus tard.' }, 502);
  }

  // Pair each phrased memory with its candidate's real, code-computed
  // occurrence count (never a number the LLM made up).
  const memories = memoryTexts.map((text, i) => ({ text, count: candidates[i].count }));

  // Clear any stale rows beyond today's new count, in case an earlier
  // call today produced more memories than this one.
  await supabaseAdmin
    .from('predictions')
    .delete()
    .eq('user_id', user.id)
    .eq('prediction_date', today)
    .gte('prediction_index', memories.length);

  const rows = memories.map((m, i) => ({
    user_id: user.id,
    prediction_text: m.text,
    prediction_date: today,
    prediction_index: i,
    occurrence_count: m.count,
  }));

  const { error: upsertError } = await supabaseAdmin
    .from('predictions')
    .upsert(rows, { onConflict: 'user_id,prediction_date,prediction_index' });

  if (upsertError) {
    console.error('[generate-predictions] upsert error', upsertError);
  }

  return json({ predictions: memories, notEnoughData: false });
});
