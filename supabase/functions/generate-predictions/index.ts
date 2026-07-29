// ============================================================
// Prédicta — generate-predictions edge function
//
// Two independent, code-computed outputs from the user's real session
// history — never left to the LLM to invent or miscount:
//
// 1. "memories" — up to 3 POSITIVE repeated patterns (same time slot,
//    weekday+slot, or duration bracket, each requiring >= 3 real
//    occurrences), phrased by an LLM (Llama 3.3 70B via Groq) into:
//      "Les [N] dernières fois que [situation], [ce qui a marché]."
//    Only what WORKED is surfaced — never a failure or interruption.
//    Cached per user/day in `predictions` (one row per memory, via
//    upsert on user_id+prediction_date+prediction_index) so re-opening
//    the Ma mémoire page doesn't regenerate it.
//
// 2. "insights" — forward-looking statistics (completion rate before
//    10h, a weekday that struggles across multiple distinct weeks, the
//    time slot with the highest drop-off rate). Pure arithmetic over
//    the same session list, no LLM call, so it's recomputed on every
//    request rather than cached — there's no generation cost to save.
//
// Returns { memories: [], insights: [], notEnoughData: true } when
// there isn't enough session history yet.
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
const MAX_MEMORIES = 3;

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
};

type PatternCandidate = { count: number; description: string };
type Insight = { text: string; basis: number };

function timeSlotOf(hour: number): string {
  if (hour >= 5 && hour < 12) return 'le matin';
  if (hour >= 12 && hour < 18) return "l'après-midi";
  if (hour >= 18 && hour < 20) return 'en début de soirée';
  return 'tard le soir'; // 20h-5h
}

// Every candidate here requires >= 3 real occurrences to exist at
// all — that's the actual enforcement of "minimum 3 occurrences",
// computed in code rather than trusted to the LLM's obedience. Only
// POSITIVE outcomes (completed sessions) are considered — this is a
// memory of what worked, never a record of what failed.
function computeRepeatedPatterns(sessions: SessionRow[]): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];

  // A. Same time-of-day slot -> session completed in full.
  const bySlotCompleted = new Map<string, number>();
  sessions.forEach((s) => {
    if (s.status !== 'completed') return;
    const slot = timeSlotOf(new Date(s.started_at).getHours());
    bySlotCompleted.set(slot, (bySlotCompleted.get(slot) ?? 0) + 1);
  });
  for (const [slot, count] of bySlotCompleted) {
    if (count >= 3) {
      candidates.push({ count, description: `tu as lancé ta session ${slot}, tu l'as complétée jusqu'au bout` });
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

  // C. Long sessions (45 min or more) completed all the way through.
  const longCompleted = sessions.filter((s) => s.status === 'completed' && s.duration_min != null && s.duration_min >= 45);
  if (longCompleted.length >= 3) {
    candidates.push({
      count: longCompleted.length,
      description: "tu as travaillé plus de 45 minutes d'affilée, tu es allé jusqu'au bout de ta session",
    });
  }

  // D. Same weekday + time slot, with every session in that bucket
  // completed (zero interruptions) — a real "you never drop this one".
  const byDaySlot = new Map<string, { day: string; slot: string; total: number; completed: number }>();
  sessions.forEach((s) => {
    const d = new Date(s.started_at);
    const day = DAY_NAMES[d.getDay()];
    const slot = timeSlotOf(d.getHours());
    const key = `${day}|${slot}`;
    const existing = byDaySlot.get(key) ?? { day, slot, total: 0, completed: 0 };
    existing.total += 1;
    if (s.status === 'completed') existing.completed += 1;
    byDaySlot.set(key, existing);
  });
  for (const { day, slot, total, completed } of byDaySlot.values()) {
    if (completed >= 3 && completed === total) {
      candidates.push({ count: completed, description: `tu as travaillé le ${day} ${slot}, tu n'as eu aucune interruption` });
    }
  }

  return candidates.sort((a, b) => b.count - a.count).slice(0, MAX_MEMORIES);
}

const SLOT_HOUR_LABEL: Record<string, string> = {
  'le matin': '5h',
  "l'après-midi": '12h',
  'en début de soirée': '18h',
  'tard le soir': '20h',
};

// Coarse "distinct week" bucket for the current user's own history —
// only ever compared for equality within one user, so it doesn't need
// to match the strict ISO week definition.
function weekKeyOf(date: Date): string {
  const first = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date.getTime() - first.getTime()) / 86400000);
  const week = Math.ceil((days + first.getDay() + 1) / 7);
  return `${date.getFullYear()}-W${week}`;
}

// Pure arithmetic over the session list — no LLM involved, so nothing
// here needs caching (recomputing costs nothing beyond the query
// already made for the memories above).
function computeInsights(sessions: SessionRow[]): Insight[] {
  const insights: Insight[] = [];
  const countable = sessions.filter((s) => s.status !== 'in_progress');

  // 1. Completion rate for sessions started before 10h.
  const beforeTen = countable.filter((s) => new Date(s.started_at).getHours() < 10);
  if (beforeTen.length >= 3) {
    const rate = Math.round((beforeTen.filter((s) => s.status === 'completed').length / beforeTen.length) * 100);
    if (rate >= 60) {
      insights.push({ text: `Tu as ${rate}% de chances de compléter ta session si tu la lances avant 10h.`, basis: beforeTen.length });
    }
  }

  // 2. Weekday that struggles across multiple distinct weeks.
  const byWeekday = new Map<number, { weeks: Set<string> }>();
  countable.forEach((s) => {
    if (s.status !== 'interrupted') return;
    const d = new Date(s.started_at);
    const wd = d.getDay();
    const entry = byWeekday.get(wd) ?? { weeks: new Set<string>() };
    entry.weeks.add(weekKeyOf(d));
    byWeekday.set(wd, entry);
  });
  let worstWeekday: { day: string; weeks: number } | null = null;
  for (const [wd, entry] of byWeekday) {
    if (entry.weeks.size >= 2 && (!worstWeekday || entry.weeks.size > worstWeekday.weeks)) {
      worstWeekday = { day: DAY_NAMES[wd], weeks: entry.weeks.size };
    }
  }
  if (worstWeekday) {
    insights.push({
      text: `Ce ${worstWeekday.day} risque d'être difficile — pattern observé ${worstWeekday.weeks} semaines de suite.`,
      basis: worstWeekday.weeks,
    });
  }

  // 3. Time slot with the highest interruption (drop-off) rate.
  const bySlot = new Map<string, { total: number; interrupted: number }>();
  countable.forEach((s) => {
    const slot = timeSlotOf(new Date(s.started_at).getHours());
    const entry = bySlot.get(slot) ?? { total: 0, interrupted: 0 };
    entry.total += 1;
    if (s.status === 'interrupted') entry.interrupted += 1;
    bySlot.set(slot, entry);
  });
  let worstSlot: { slot: string; rate: number; total: number } | null = null;
  for (const [slot, entry] of bySlot) {
    if (slot === 'le matin' || entry.total < 3) continue;
    const rate = entry.interrupted / entry.total;
    if (rate >= 0.5 && (!worstSlot || rate > worstSlot.rate)) {
      worstSlot = { slot, rate, total: entry.total };
    }
  }
  if (worstSlot) {
    insights.push({ text: `Tu décroches plus souvent quand tu travailles après ${SLOT_HOUR_LABEL[worstSlot.slot]}.`, basis: worstSlot.total });
  }

  return insights;
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

  // Always re-derive the user's own sessions from our own trusted
  // query, scoped to the authenticated user.id — never from a
  // client-submitted session list, which could be tampered with.
  // Needed for both memories (below) and insights, so this always
  // runs, even on a memories cache hit.
  const { data: allSessions } = await supabaseAdmin
    .from('sessions')
    .select('duration_min, status, started_at')
    .eq('user_id', user.id)
    .order('started_at', { ascending: true });

  if (!allSessions || allSessions.length < MIN_SESSIONS) {
    return json({ memories: [], insights: [], notEnoughData: true });
  }

  const insights = computeInsights(allSessions);

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
      memories: cached.map((p) => ({ text: p.prediction_text, count: p.occurrence_count ?? 0 })),
      insights,
      notEnoughData: false,
    });
  }

  const candidates = computeRepeatedPatterns(allSessions);
  if (candidates.length === 0) {
    // No positive pattern repeats often enough yet — nothing to ask
    // Groq about, so this costs nothing beyond the queries above.
    return json({ memories: [], insights, notEnoughData: false });
  }

  const systemPrompt = `Tu es le moteur de mémoire personnalisée de Prédicta.
On te fournit une liste de patterns POSITIFS RÉELS déjà détectés dans les sessions de l'utilisateur, avec leur nombre exact d'occurrences.
Ta seule tâche : transformer CHAQUE pattern fourni en une phrase suivant EXACTEMENT ce format, rien d'autre :
"Les [N] dernières fois que [situation], [ce qui a marché]."

Exemples de bon format :
- "Les 3 dernières fois que tu as lancé ta session avant 10h, tu l'as complétée jusqu'au bout."
- "Les 4 dernières fois que tu as commencé par une tâche courte, tu as tenu plus de 45 minutes."
- "Chaque fois que tu as travaillé le mardi matin, tu n'as eu aucune interruption."

Règles strictes :
- Uniquement des observations positives : ce qui A MARCHÉ. Ne mentionne jamais un échec ou une interruption.
- N'utilise QUE les patterns fournis ci-dessous, dans le même ordre — n'invente jamais de nouveau pattern, ne change jamais le nombre N fourni.
- Jamais de conseil, jamais de suggestion — uniquement des observations.
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

  return json({ memories, insights, notEnoughData: false });
});
