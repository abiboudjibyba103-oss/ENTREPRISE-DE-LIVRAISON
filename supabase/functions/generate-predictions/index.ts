// ============================================================
// Prédicta — generate-predictions edge function
//
// Generates 4 kinds of content per user per day, each computed from
// real session data — never left to the LLM to invent a count or a
// percentage. For every kind, code detects real candidates (with
// their exact real numbers), and Groq's only job is to phrase each
// candidate into the kind's required template:
//
//   patterns     — up to 3 factual, neutral observations
//                  ("Tu [comportement], [fréquence].")
//   predictions  — up to 2 forward-looking, percentage-based alerts
//                  ("[Contexte]. Tu as [X]% de chances de [...]")
//   memoire      — up to 3 "mémoire personnalisée" lines, mixing what
//                  worked and what didn't, each needing >= 3 real
//                  occurrences ("Les [N] dernières fois que [...]")
//   anticipation — up to 1 message combining the strongest pattern +
//                  prediction + mémoire into one actionable message
//
// All 4 are generated together in a single Groq call and cached
// together in `predictions` (kind column + prediction_index per kind,
// upsert on user_id+prediction_date+kind+prediction_index) so
// re-opening Ma mémoire doesn't regenerate them. Returns
// { patterns: [], predictions: [], memoire: [], anticipation: [],
//   notEnoughData: true } when there isn't enough session history.
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

const PREDICTION_MODEL = 'openai/gpt-oss-120b';
const MIN_SESSIONS = 3;

const PATTERNS_MAX = 3;
const PREDICTIONS_MAX = 2;
const MEMOIRE_MAX = 3;

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

type Candidate = { count: number; description: string };

function timeSlotOf(hour: number): string {
  if (hour >= 5 && hour < 12) return 'le matin';
  if (hour >= 12 && hour < 18) return "l'après-midi";
  if (hour >= 18 && hour < 20) return 'en début de soirée';
  return 'tard le soir'; // 20h-5h
}

// ---- TYPE 1: patterns détectés — factual, no advice, code-computed ----
function computePatternCandidates(sessions: SessionRow[]): Candidate[] {
  const candidates: Candidate[] = [];

  // Long sessions (>=45min) ending in an interruption.
  const longThenDrop = sessions.filter((s) => s.status === 'interrupted' && s.duration_min != null && s.duration_min >= 45);
  if (longThenDrop.length >= 3) {
    candidates.push({ count: longThenDrop.length, description: 'tu décroches souvent après une longue période de concentration' });
  }

  // A weekday with clearly fewer sessions than the others.
  if (sessions.length >= 7) {
    const counts = new Array(7).fill(0);
    sessions.forEach((s) => counts[new Date(s.started_at).getDay()]++);
    const avg = sessions.length / 7;
    let minIdx = 0;
    for (let i = 1; i < 7; i++) if (counts[i] < counts[minIdx]) minIdx = i;
    if (avg >= 1 && counts[minIdx] <= avg * 0.5) {
      candidates.push({ count: sessions.length, description: `le ${DAY_NAMES[minIdx]} tu lances moins de sessions que les autres jours` });
    }
  }

  // Morning vs late-evening average duration, whichever is notably longer.
  const withDuration = (slot: string) => sessions.filter((s) => s.duration_min != null && timeSlotOf(new Date(s.started_at).getHours()) === slot);
  const morning = withDuration('le matin');
  const evening = withDuration('tard le soir');
  if (morning.length >= 3 && evening.length >= 3) {
    const avg = (arr: SessionRow[]) => arr.reduce((sum, s) => sum + (s.duration_min ?? 0), 0) / arr.length;
    const avgMorning = avg(morning);
    const avgEvening = avg(evening);
    if (avgEvening > 0 && avgMorning / avgEvening >= 1.5) {
      const ratio = Math.round((avgMorning / avgEvening) * 10) / 10;
      candidates.push({ count: morning.length + evening.length, description: `tes sessions du matin durent en moyenne ${ratio} fois plus longtemps que celles du soir` });
    } else if (avgMorning > 0 && avgEvening / avgMorning >= 1.5) {
      const ratio = Math.round((avgEvening / avgMorning) * 10) / 10;
      candidates.push({ count: morning.length + evening.length, description: `tes sessions du soir durent en moyenne ${ratio} fois plus longtemps que celles du matin` });
    }
  }

  return candidates.sort((a, b) => b.count - a.count).slice(0, PATTERNS_MAX);
}

// ---- TYPE 2: prédictions — forward-looking risk alerts. The real
// rate/count behind each candidate only ever gates whether it's
// worth surfacing — it never appears in the description text, since
// predictions must never state a percentage or a statistic. ----
function computePredictionCandidates(sessions: SessionRow[]): Candidate[] {
  const candidates: Candidate[] = [];
  const countable = sessions.filter((s) => s.status !== 'in_progress');

  const beforeTen = countable.filter((s) => new Date(s.started_at).getHours() < 10);
  if (beforeTen.length >= 3) {
    const rate = beforeTen.filter((s) => s.status === 'completed').length / beforeTen.length;
    if (rate >= 0.6) {
      candidates.push({ count: beforeTen.length, description: 'si tu ne lances pas ta session avant 10h aujourd\'hui, tu risques de ne pas la terminer' });
    }
  }

  const byWeekday = new Map<number, { weeks: Set<string> }>();
  countable.forEach((s) => {
    if (s.status !== 'interrupted') return;
    const d = new Date(s.started_at);
    const wd = d.getDay();
    const entry = byWeekday.get(wd) ?? { weeks: new Set<string>() };
    const first = new Date(d.getFullYear(), 0, 1);
    const days = Math.floor((d.getTime() - first.getTime()) / 86400000);
    const week = Math.ceil((days + first.getDay() + 1) / 7);
    entry.weeks.add(`${d.getFullYear()}-W${week}`);
    byWeekday.set(wd, entry);
  });
  let worstWeekday: { day: string; weeks: number } | null = null;
  for (const [wd, entry] of byWeekday) {
    if (entry.weeks.size >= 2 && (!worstWeekday || entry.weeks.size > worstWeekday.weeks)) {
      worstWeekday = { day: DAY_NAMES[wd], weeks: entry.weeks.size };
    }
  }
  if (worstWeekday) {
    candidates.push({ count: worstWeekday.weeks, description: `le ${worstWeekday.day} est une journée à risque pour toi, tu as tendance à interrompre tes sessions ce jour-là` });
  }

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
    candidates.push({ count: worstSlot.total, description: `tu décroches plus souvent quand tu travailles ${worstSlot.slot}` });
  }

  return candidates.sort((a, b) => b.count - a.count).slice(0, PREDICTIONS_MAX);
}

// ---- TYPE 3: mémoire personnalisée — mixes what worked and what
// didn't, each needing >= 3 real occurrences ----
function computeMemoryCandidates(sessions: SessionRow[]): Candidate[] {
  const candidates: Candidate[] = [];

  // Positive: short sessions (<=20min) completed in full.
  const shortCompleted = sessions.filter((s) => s.status === 'completed' && s.duration_min != null && s.duration_min <= 20);
  if (shortCompleted.length >= 3) {
    candidates.push({ count: shortCompleted.length, description: "tu as commencé par une petite action, tu as complété ta session jusqu'au bout" });
  }

  // Per weekday+slot: either always completed (positive) or always
  // interrupted quickly (negative), each needs every session in that
  // bucket to agree — not just "at least one".
  const byDaySlot = new Map<string, { day: string; slot: string; total: number; completed: number; quickInterrupt: number }>();
  sessions.forEach((s) => {
    const d = new Date(s.started_at);
    const day = DAY_NAMES[d.getDay()];
    const slot = timeSlotOf(d.getHours());
    const key = `${day}|${slot}`;
    const entry = byDaySlot.get(key) ?? { day, slot, total: 0, completed: 0, quickInterrupt: 0 };
    entry.total += 1;
    if (s.status === 'completed') entry.completed += 1;
    if (s.status === 'interrupted' && s.duration_min != null && s.duration_min < 15) entry.quickInterrupt += 1;
    byDaySlot.set(key, entry);
  });
  for (const { day, slot, total, completed, quickInterrupt } of byDaySlot.values()) {
    if (completed >= 3 && completed === total) {
      candidates.push({ count: completed, description: `tu as travaillé le ${day} ${slot}, tu n'as eu aucune interruption` });
    }
    if (quickInterrupt >= 3 && quickInterrupt === total) {
      candidates.push({ count: quickInterrupt, description: `tu as lancé une session le ${day} ${slot}, tu l'as interrompue dans les 15 premières minutes` });
    }
  }

  // Negative: same time slot, quick interruption (<15min), regardless of weekday.
  const bySlotQuick = new Map<string, number>();
  sessions.forEach((s) => {
    if (s.status === 'interrupted' && s.duration_min != null && s.duration_min < 15) {
      const slot = timeSlotOf(new Date(s.started_at).getHours());
      bySlotQuick.set(slot, (bySlotQuick.get(slot) ?? 0) + 1);
    }
  });
  for (const [slot, count] of bySlotQuick) {
    if (count >= 3) {
      candidates.push({ count, description: `tu as travaillé ${slot}, tu as abandonné avant 15 minutes` });
    }
  }

  return candidates.sort((a, b) => b.count - a.count).slice(0, MEMOIRE_MAX);
}

// ---- TYPE 4: anticipation — combines the single strongest signal
// from each of the 3 types above into one candidate ----
function computeAnticipationCandidate(
  patterns: Candidate[],
  predictions: Candidate[],
  memories: Candidate[],
): Candidate | null {
  const top = [patterns[0], predictions[0], memories[0]].filter((c): c is Candidate => !!c);
  if (top.length === 0) return null;
  return {
    count: Math.max(...top.map((c) => c.count)),
    description: top.map((c) => c.description).join(' ; '),
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

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !GROQ_API_KEY) {
    console.error('[generate-predictions] missing required secret(s): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY');
    return json({ error: 'Analyse momentanément indisponible (configuration serveur).' }, 500);
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
  const EMPTY = { patterns: [], predictions: [], memoire: [], anticipation: [] };

  // Always re-derive the user's own sessions from our own trusted
  // query, scoped to the authenticated user.id — never from a
  // client-submitted session list, which could be tampered with.
  const { data: allSessions } = await supabaseAdmin
    .from('sessions')
    .select('duration_min, status, started_at')
    .eq('user_id', user.id)
    .order('started_at', { ascending: true });

  if (!allSessions || allSessions.length < MIN_SESSIONS) {
    return json({ ...EMPTY, notEnoughData: true });
  }

  const patternCandidates = computePatternCandidates(allSessions);
  const predictionCandidates = computePredictionCandidates(allSessions);
  const memoryCandidates = computeMemoryCandidates(allSessions);
  const anticipationCandidate = computeAnticipationCandidate(patternCandidates, predictionCandidates, memoryCandidates);

  // Cache hit: today's content already exists — return it without
  // spending another Groq call. A kind only counts as cached when its
  // row count matches what today's candidates say it should be; this
  // also self-heals from stale/partial rows (e.g. old pre-migration
  // rows backfilled to kind='memoire') instead of trusting them
  // forever and leaving the other kinds permanently empty.
  const { data: cached } = await supabaseAdmin
    .from('predictions')
    .select('kind, prediction_text, prediction_index, occurrence_count')
    .eq('user_id', user.id)
    .eq('prediction_date', today)
    .order('prediction_index', { ascending: true });

  const cachedFor = (kind: string, expectedCount: number) => {
    const rows = (cached ?? []).filter((r) => r.kind === kind);
    if (rows.length !== expectedCount) return null;
    return rows.map((r) => ({ text: r.prediction_text, count: r.occurrence_count ?? 0 }));
  };

  const cachedPatterns = cachedFor('pattern', patternCandidates.length);
  const cachedPredictions = cachedFor('prediction', predictionCandidates.length);
  const cachedMemoire = cachedFor('memoire', memoryCandidates.length);
  const cachedAnticipation = cachedFor('anticipation', anticipationCandidate ? 1 : 0);

  if (cachedPatterns && cachedPredictions && cachedMemoire && cachedAnticipation) {
    return json({
      patterns: cachedPatterns,
      predictions: cachedPredictions,
      memoire: cachedMemoire,
      anticipation: cachedAnticipation,
      notEnoughData: false,
    });
  }

  if (patternCandidates.length === 0 && predictionCandidates.length === 0 && memoryCandidates.length === 0) {
    // Nothing repeats often enough yet — nothing to ask Groq about,
    // so this costs nothing beyond the queries above.
    return json({ ...EMPTY, notEnoughData: false });
  }

  const listForPrompt = (candidates: Candidate[]) => candidates.length
    ? candidates.map((c, i) => `${i + 1}. (${c.count}) ${c.description}`).join('\n')
    : 'Aucune';

  const systemPrompt = `Tu es le moteur d'analyse de Prédicta. On te fournit des observations RÉELLES déjà calculées à partir des sessions d'un utilisateur, avec leurs valeurs exactes (occurrences ou pourcentages, entre parenthèses). Ta seule tâche : transformer CHAQUE observation fournie en une phrase suivant EXACTEMENT le format de son type — jamais inventer de nombre, jamais inventer un nouveau pattern.

TYPE "patterns" — observations factuelles, sans jugement.
Format : "Tu [comportement observé] [fréquence/contexte]."
Exemple : "Tu décroches souvent après une longue période de concentration."

TYPE "predictions" — alertes basées sur les patterns observés.
RÈGLE STRICTE : une prédiction n'est JAMAIS un pourcentage ni une statistique chiffrée. Aucun nombre dans la phrase.
Format : "Aujourd'hui [contexte]. Tu risques de [comportement]."
Exemples :
- "Aujourd'hui est une journée à risque. Tu as plus de chances de décrocher que d'habitude."
- "Basé sur tes lundis des dernières semaines, tu risques d'interrompre ta première session rapidement."

TYPE "memoire" — ce qui a marché ET ce qui n'a pas marché, mélangés.
Format : "Les [N] dernières fois que [situation], [ce qui s'est passé]." (N = le nombre fourni)
Exemple : "Les 3 dernières fois que tu as commencé par une petite action, tu as complété ta session jusqu'au bout."

TYPE "anticipation" — combine l'observation fournie (qui mélange déjà pattern + prédiction + mémoire) en UN SEUL message d'action.
Format : "[Alerte de risque]. [Ce qui a marché dans cette situation]."
Exemple : "Tu risques de décrocher dans les prochaines minutes. La dernière fois dans cette situation, commencer par une petite action t'a aidé à continuer."

RÈGLES STRICTES :
- N'utilise QUE les observations fournies ci-dessous, dans le même ordre pour chaque type.
- Une phrase par observation fournie, pas plus, pas moins. Si "Aucune" est indiqué pour un type, réponds un tableau vide pour ce type.
- Jamais de conseil générique.
- Pour le type "predictions" : jamais de pourcentage, jamais de nombre, jamais de statistique dans la phrase — uniquement le format "Aujourd'hui [contexte]. Tu risques de [comportement]."
- Réponds UNIQUEMENT avec un JSON : {"patterns": [...], "predictions": [...], "memoire": [...], "anticipation": [...]}

Observations "patterns" :
${listForPrompt(patternCandidates)}

Observations "predictions" :
${listForPrompt(predictionCandidates)}

Observations "memoire" :
${listForPrompt(memoryCandidates)}

Observation "anticipation" :
${anticipationCandidate ? `1. (${anticipationCandidate.count}) ${anticipationCandidate.description}` : 'Aucune'}`;

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
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Transforme ces observations selon le format de chaque type, dans le même ordre.' },
        ],
      }),
    });
  } catch (err) {
    console.error('[generate-predictions] fetch error', err);
    return json({ error: 'Analyse momentanément indisponible.' }, 502);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error('[generate-predictions] Groq error', aiRes.status, errText);
    return json({ error: 'Analyse momentanément indisponible.' }, 502);
  }

  const aiData = await aiRes.json();
  const rawContent: string = aiData.choices?.[0]?.message?.content?.trim() || '';

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    console.error('[generate-predictions] JSON parse error', err, rawContent);
  }

  function pairWithCandidates(key: string, candidates: Candidate[]): { text: string; count: number }[] {
    const arr = Array.isArray(parsed[key]) ? (parsed[key] as unknown[]) : [];
    const texts = arr
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim().slice(0, 500))
      .slice(0, candidates.length);
    return texts.map((text, i) => ({ text, count: candidates[i].count }));
  }

  const patterns = pairWithCandidates('patterns', patternCandidates);
  const predictions = pairWithCandidates('predictions', predictionCandidates);
  const memoire = pairWithCandidates('memoire', memoryCandidates);
  const anticipation = anticipationCandidate ? pairWithCandidates('anticipation', [anticipationCandidate]) : [];

  if (patterns.length === 0 && predictions.length === 0 && memoire.length === 0 && anticipation.length === 0) {
    console.error('[generate-predictions] no content returned', rawContent);
    return json({ error: 'Impossible de générer ton analyse pour le moment, réessaie plus tard.' }, 502);
  }

  // Clear any stale rows per kind beyond today's new counts, in case
  // an earlier call today produced more items than this one.
  const groups: { kind: string; items: { text: string; count: number }[] }[] = [
    { kind: 'pattern', items: patterns },
    { kind: 'prediction', items: predictions },
    { kind: 'memoire', items: memoire },
    { kind: 'anticipation', items: anticipation },
  ];

  for (const { kind, items } of groups) {
    await supabaseAdmin
      .from('predictions')
      .delete()
      .eq('user_id', user.id)
      .eq('prediction_date', today)
      .eq('kind', kind)
      .gte('prediction_index', items.length);
  }

  const rows = groups.flatMap(({ kind, items }) => items.map((item, i) => ({
    user_id: user.id,
    prediction_text: item.text,
    prediction_date: today,
    kind,
    prediction_index: i,
    occurrence_count: item.count,
  })));

  if (rows.length > 0) {
    const { error: upsertError } = await supabaseAdmin
      .from('predictions')
      .upsert(rows, { onConflict: 'user_id,prediction_date,kind,prediction_index' });

    if (upsertError) {
      console.error('[generate-predictions] upsert error', upsertError);
    }
  }

  return json({ patterns, predictions, memoire, anticipation, notEnoughData: false });
});
