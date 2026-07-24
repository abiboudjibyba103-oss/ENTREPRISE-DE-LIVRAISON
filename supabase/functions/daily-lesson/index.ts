// ============================================================
// Prédicta — daily-lesson edge function
//
// Replaces the static 30-lesson catalogue: instead of letting
// the user browse pre-written lessons, this generates ONE
// teaching per day, grounded in the cognitive-science knowledge
// base below, but written specifically about what actually
// happened in the user's sessions today (when they dropped off,
// how long they held focus, etc). Cached per user/day in
// `daily_lessons` so re-opening the app doesn't regenerate it
// (it IS regenerated after every session that day, to reflect
// the most complete picture so far).
//
// Deploy with:
//   supabase functions deploy daily-lesson
//   (reuses the GROQ_API_KEY secret already set for coach-chat)
//
// Frontend: js/supabase-client.js -> predictaDailyLesson()
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!;

const COACH_MODEL = 'llama-3.3-70b-versatile';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Condensed cognitive-science knowledge base. The model picks
// whichever fact actually explains the user's behaviour today —
// it is never shown to the user as a catalogue.
const SCIENCE_BASE = `
- Baumeister (1998): résister à une tentation épuise la même réserve mentale que résoudre des problèmes complexes ("épuisement de l'ego").
- Raichle (2001): le cerveau bascule entre réseau par défaut (repos) et réseau attentionnel (focus) ; ce basculement prend 15-20 min.
- Réseau par défaut: surveille menaces/opportunités en permanence ; nommer une distraction active le cortex préfrontal et la réduit (UCLA).
- Gloria Mark (UC Irvine): 23 minutes pour retrouver un focus profond après une interruption ; Sophie Leroy: "attention résiduelle".
- Cortisol Awakening Response: pic de cortisol 30-45 min après le réveil, fenêtre de focus optimale pendant 2-4h.
- Olds & Milner (1954): la dopamine signale "ça pourrait être bon", jamais "c'est bon" — moteur de la recherche compulsive, pas du plaisir lui-même.
- Adrian Ward (UT Austin, 2017): un téléphone visible (même éteint) réduit les performances cognitives par surveillance inconsciente.
- Consommation de contenu ultra-court: recalibre les circuits de récompense vers plus de vitesse, moins de profondeur.
- Clifford Nass (Stanford): le multitâche n'existe pas neurologiquement, seulement du task-switching coûteux.
- Tristan Harris: schéma de récompense variable (notifications) = mécanisme le plus addictif connu.
- Ebbinghaus (1885): 50% oublié en 1h, 70% en 24h sans révision ; la répétition espacée aplatit la courbe.
- Matthew Walker: les souvenirs se consolident pendant le sommeil, pas pendant l'apprentissage ; manque de sommeil = -40% de formation de souvenirs.
- Roediger & Karpicke (2006): se souvenir sans notes (rappel actif) double la rétention vs relire.
- Goleman: en stress intense, le détournement amygdalien met le cortex préfrontal hors ligne — nommer l'état le réactive.
- Stephen Porges (théorie polyvagale): allonger l'expiration active le système parasympathique en quelques cycles.
- George Miller (1956) / Sweller: la mémoire de travail gère ~7 éléments ; au-delà, surcharge cognitive et blocage.
- Étude 2013: 2h de silence/jour stimulent la neurogenèse dans l'hippocampe.
- John Ratey (Harvard): l'exercice libère du BDNF, stimule la croissance neuronale et le cortex préfrontal.
- Sirois & Pychyl (2013): la procrastination est un problème de régulation émotionnelle, pas de gestion du temps.
- Flett & Hewitt: les perfectionnistes procrastinent le plus par peur du jugement.
- Bluma Zeigarnik (1927): une tâche commencée crée une tension cognitive vers sa complétion.
- BJ Fogg (Stanford): la plupart des comportements sont déclenchés par l'environnement avant toute décision consciente.
- Baumeister (fatigue décisionnelle): chaque décision de la journée réduit la qualité des suivantes ; le soir, le cortex préfrontal est épuisé.
- Eleanor Maguire (UCL): la neuroplasticité est active à tout âge, le cerveau se réorganise physiquement avec l'usage.
- Ann Graybiel (MIT): les habitudes répétées sont prises en charge par les ganglions de la base (chunking), réduisant le coût cognitif.
- Phillippa Lally (UCL, 2010): formation d'une habitude entre 18 et 254 jours, moyenne 66 jours (pas 21).
- Dunning-Kruger / métacognition: s'observer régulièrement accélère la progression bien plus que l'absence de suivi.
`.trim();

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
  const user = userData.user;

  const today = new Date().toISOString().slice(0, 10);
  const startOfDay = new Date(`${today}T00:00:00.000Z`);

  // Always re-derive today's sessions from our own trusted query, scoped
  // to the authenticated user.id — never from client-submitted data, even
  // if the caller passes a body. This matches every other write/read in
  // this function and avoids trusting a client-controlled session list.
  const { data: todaySessions } = await supabaseAdmin
    .from('sessions')
    .select('duration_min, focus_score, status, started_at, notes, interruption_reason')
    .eq('user_id', user.id)
    .gte('started_at', startOfDay.toISOString())
    .order('started_at', { ascending: true });

  if (!todaySessions || todaySessions.length === 0) {
    return json({ lessonText: null, hasSessionToday: false });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();

  const totalSessions = todaySessions.length;
  const completedSessions = todaySessions.filter((s) => s.status === 'completed').length;
  const interruptedSessions = todaySessions.filter((s) => s.status === 'interrupted').length;
  const interruptionReasons = todaySessions
    .filter((s) => s.status === 'interrupted' && s.interruption_reason)
    .map((s) => s.interruption_reason as string);

  const sessionLines = todaySessions
    .map((s, i) => {
      const parts = [`Session ${i + 1}: ${s.duration_min ?? '?'} min`, `focus ${s.focus_score ?? '—'}%`, `statut "${s.status}"`];
      if (s.notes) parts.push(`tâche: "${s.notes}"`);
      if (s.status === 'interrupted' && s.interruption_reason) parts.push(`cause de l'interruption: "${s.interruption_reason}"`);
      return parts.join(', ');
    })
    .join('\n');

  const summaryLine = `Résumé du jour: ${totalSessions} session(s) au total, ${completedSessions} terminée(s), ${interruptedSessions} interrompue(s).` +
    (interruptionReasons.length
      ? ` Raisons d'interruption données par l'utilisateur : ${interruptionReasons.map((r) => `"${r}"`).join(', ')}.`
      : '');

  const systemPrompt = `Tu es le moteur d'enseignement de Prédicta, une app cognitive pour des utilisateurs sénégalais. Ta seule mission ici: analyser les sessions de focus RÉELLES de l'utilisateur AUJOURD'HUI, et en tirer UN SEUL enseignement scientifique court qui explique précisément SON comportement de la journée — pas une leçon générique.

Base scientifique disponible (choisis le fait le plus pertinent par rapport au comportement réel observé ci-dessous, n'en cite qu'un ou deux):
${SCIENCE_BASE}

Règles strictes:
- Réponds en français, ton direct et chaleureux, jamais condescendant.
- Commence par nommer précisément ce qui s'est passé aujourd'hui (ex: "Tu as décroché après X minutes").
- Explique le mécanisme scientifique derrière CE comportement précis, en citant le chercheur.
- Termine par une action concrète à appliquer dès la prochaine session.
- 4 à 6 phrases maximum. Pas de titres, pas de listes, juste un texte fluide adressé directement à l'utilisateur ("tu").
- N'invente jamais de données : utilise uniquement les sessions et le résumé listés ci-dessous.

Comment choisir l'angle scientifique selon ce qui s'est vraiment passé:
- Si une ou plusieurs interruptions ont pour cause "une pensée ou une tâche extérieure a capté mon attention": explique le vagabondage mental (mind-wandering) et la façon dont le réseau cérébral par défaut reprend le dessus sur le réseau attentionnel (Raichle).
- Si une session a duré environ 10 minutes ou moins avant d'être interrompue ou terminée: parle de la résistance au démarrage plutôt que d'un décrochage en cours de tâche (Sirois & Pychyl — la procrastination est une régulation émotionnelle, pas un manque de temps).
- Si une session longue (45 minutes ou plus) a été menée jusqu'au bout (statut "completed"): explique le coût de transition cognitif et pourquoi enchaîner immédiatement sur une autre tâche est difficile (Gloria Mark, Sophie Leroy — attention résiduelle).
- S'il y a plusieurs sessions interrompues aujourd'hui, concentre-toi sur la raison la plus fréquente parmi celles données par l'utilisateur plutôt que de toutes les citer.

Prénom: ${profile?.display_name ?? 'utilisateur'}
${summaryLine}
Sessions d'aujourd'hui (dans l'ordre chronologique):
${sessionLines}`;

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
        max_tokens: 350,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: "Donne-moi l'enseignement de ce soir, basé sur mes sessions d'aujourd'hui." },
        ],
      }),
    });
  } catch (err) {
    console.error('[daily-lesson] fetch error', err);
    return json({ error: 'Enseignement momentanément indisponible.' }, 502);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error('[daily-lesson] Groq error', aiRes.status, errText);
    return json({ error: 'Enseignement momentanément indisponible.' }, 502);
  }

  const aiData = await aiRes.json();
  const lessonText: string =
    aiData.choices?.[0]?.message?.content?.trim() ||
    "Impossible de générer ton enseignement du jour pour le moment, réessaie plus tard.";

  await supabaseAdmin
    .from('daily_lessons')
    .upsert(
      { user_id: user.id, lesson_date: today, lesson_text: lessonText.slice(0, 4000) },
      { onConflict: 'user_id,lesson_date' }
    );

  return json({ lessonText, hasSessionToday: true });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
