// ============================================================
// Prédicta — coach-chat edge function
//
// Acts as the AI Coach: authenticates the caller via their
// Supabase JWT, loads their real session/lesson/brain-metrics
// data from the database, and asks an LLM (Llama 3.1 70B via
// Groq, OpenAI-compatible API) for a short, personalized
// coaching reply in French.
//
// Deploy with:
//   supabase functions deploy coach-chat
//   supabase secrets set GROQ_API_KEY=...
//
// Frontend: js/supabase-client.js -> predictaCoachChat(message, history)
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!;

const MAX_MESSAGE_LEN = 500;
const MAX_HISTORY = 10;
const COACH_MODEL = 'llama-3.3-70b-versatile';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Browsers send a CORS preflight OPTIONS request before the real POST.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Identify the caller from their Supabase JWT (sent automatically
  // by supabase.functions.invoke as the Authorization header).
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

  let body: { message?: string; history?: { role?: string; content?: string }[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const message = String(body.message ?? '').trim().slice(0, MAX_MESSAGE_LEN);

  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          (m): m is { role: 'user' | 'assistant'; content: string } =>
            !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
        )
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LEN) }))
    : [];

  // Rate limit: at most 1 user question per day. The daily greeting
  // (empty message) is always answered and doesn't count against
  // this limit.
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count: questionsToday } = await supabaseAdmin
    .from('predictions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', startOfDay.toISOString());

  const limitReached = (questionsToday ?? 0) > 0;

  if (message && limitReached) {
    return json(
      { error: 'Tu as déjà posé ta question au coach aujourd\'hui. Reviens demain pour une nouvelle question !' },
      429
    );
  }

  // Load the user's real data to ground the coach's response.
  const [{ data: profile }, { data: sessions }, { data: brain }, { data: lessons }] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    supabaseAdmin
      .from('sessions')
      .select('duration_min, focus_score, status, started_at')
      .eq('user_id', user.id)
      .order('started_at', { ascending: false })
      .limit(7),
    supabaseAdmin
      .from('brain_metrics')
      .select('*')
      .eq('user_id', user.id)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin.from('lesson_progress').select('lesson_id, status').eq('user_id', user.id),
  ]);

  const completedLessons = (lessons ?? []).filter((l) => l.status === 'done').length;
  const focusScores = (sessions ?? []).map((s) => s.focus_score).filter((f): f is number => typeof f === 'number');
  const avgFocus = focusScores.length
    ? Math.round(focusScores.reduce((sum, f) => sum + f, 0) / focusScores.length)
    : null;

  const contextLines = [
    `Prénom: ${profile?.display_name ?? 'utilisateur'}`,
    `Phase actuelle: ${profile?.phase ?? 'Phase 1 — Découverte'}`,
    `Sessions récentes (7 dernières): ${sessions?.length ?? 0}`,
    avgFocus != null ? `Score de focus moyen récent: ${avgFocus}%` : null,
    `Leçons complétées: ${completedLessons}/30`,
    brain
      ? `Profil cognitif (0-100): concentration ${brain.concentration}, mémoire ${brain.memoire}, régulation ${brain.regulation}, régularité ${brain.regularite}, récupération ${brain.recuperation}`
      : null,
  ].filter(Boolean);

  const systemPrompt = `Tu es le Coach IA de Prédicta, une application qui aide des utilisateurs sénégalais à comprendre et améliorer leur concentration et leurs habitudes cognitives.

Règles:
- Réponds toujours en français, avec un ton chaleureux mais direct — jamais générique.
- Base-toi sur les données réelles de l'utilisateur ci-dessous quand c'est pertinent.
- Sois concis: 2 à 4 phrases maximum.
- Quand c'est pertinent, ancre ton conseil dans la science cognitive (dopamine, attention, charge cognitive, sommeil, etc.).
- Ne donne jamais de conseil médical.
- Si l'utilisateur n'a pas encore de données (aucune session), encourage-le à démarrer sa première session.

Données de l'utilisateur:
${contextLines.join('\n')}`;

  const messages = [{ role: 'system', content: systemPrompt }, ...history];
  if (message) {
    messages.push({ role: 'user', content: message });
  }
  if (messages.length === 1) {
    messages.push({ role: 'user', content: 'Donne-moi mon message de coaching du jour, basé sur mes données.' });
  }

  let aiRes: Response;
  try {
    aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: COACH_MODEL,
        max_tokens: 300,
        messages,
      }),
    });
  } catch (err) {
    console.error('[coach-chat] fetch error', err);
    return json({ error: 'Le coach est momentanément indisponible.' }, 502);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error('[coach-chat] Groq error', aiRes.status, errText);
    return json({ error: 'Le coach est momentanément indisponible.' }, 502);
  }

  const aiData = await aiRes.json();
  const reply: string = aiData.choices?.[0]?.message?.content?.trim() || "Je n'ai pas pu générer de réponse, réessaie dans un instant.";

  // Best-effort: keep a history of coach messages. Only real user
  // questions count toward the daily limit, not the greeting.
  if (message) {
    await supabaseAdmin.from('predictions').insert({
      user_id: user.id,
      prediction_text: reply.slice(0, 2000),
    });
  }

  return json({ reply, limitReached: !!message || limitReached });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
