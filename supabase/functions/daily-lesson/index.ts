// ============================================================
// Prédicta — daily-lesson edge function
//
// Replaces the static 30-lesson catalogue: instead of letting
// the user browse pre-written lessons, this generates ONE
// teaching per day, grounded in the cognitive-science knowledge
// base below, but written specifically about what actually
// happened in the user's sessions today (when they dropped off,
// how long they held focus, etc). Cached per user/day in
// `daily_lessons`, and genuinely regenerated (not just re-served)
// whenever a session has finished more recently than the cached
// lesson (daily_lessons.updated_at vs the latest session's
// ended_at) — see migration_daily_lessons_updated_at.sql. The
// prompt also gets the last 3 days' lessons so it can vary which
// researcher/concept it leans on instead of repeating itself.
//
// Deploy with:
//   supabase functions deploy daily-lesson
//   (reuses the GROQ_API_KEY secret already set for coach-chat)
//
// Frontend: js/supabase-client.js -> predictaDailyLesson()
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY');

const COACH_MODEL = 'qwen/qwen3-32b';

// Written to lesson_text while a generation is in flight, so a concurrent
// request can tell "reserved but not done yet" apart from "no row yet".
const RESERVATION_PLACEHOLDER = '__generating__';

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

  // Fail fast and loudly if required secrets are missing, instead of
  // proceeding with `undefined` and failing later with a cryptic error
  // (the previous `!` was a TypeScript-only assertion with no runtime effect).
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !GROQ_API_KEY) {
    console.error('[daily-lesson] missing required secret(s): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY');
    return json({ error: 'Enseignement momentanément indisponible (configuration serveur).' }, 500);
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
    .select('duration_min, focus_score, status, started_at, ended_at, notes, interruption_reason')
    .eq('user_id', user.id)
    .gte('started_at', startOfDay.toISOString())
    .order('started_at', { ascending: true });

  if (!todaySessions || todaySessions.length === 0) {
    return json({ lessonText: null, hasSessionToday: false });
  }

  // Cache check: a lesson already exists for today — return it without
  // spending another Groq call, UNLESS a session has finished more
  // recently than the lesson was last generated, in which case it's
  // stale and needs regenerating to reflect the fuller picture.
  const { data: cachedLesson } = await supabaseAdmin
    .from('daily_lessons')
    .select('lesson_text, updated_at')
    .eq('user_id', user.id)
    .eq('lesson_date', today)
    .maybeSingle();

  const finishedSessions = todaySessions.filter((s) => s.status === 'completed' || s.status === 'interrupted');
  const latestSessionEndedAt = finishedSessions.reduce((latest, s) => {
    const t = s.ended_at ? new Date(s.ended_at).getTime() : 0;
    return t > latest ? t : latest;
  }, 0);
  const isStale = latestSessionEndedAt > 0
    && !!cachedLesson?.updated_at
    && new Date(cachedLesson.updated_at).getTime() < latestSessionEndedAt;

  if (cachedLesson?.lesson_text && cachedLesson.lesson_text !== RESERVATION_PLACEHOLDER && !isStale) {
    return json({ lessonText: cachedLesson.lesson_text, hasSessionToday: true });
  }

  // Reserve today's slot before calling Groq. A brand-new day's row is
  // reserved with a conditional INSERT (daily_lessons has a unique
  // (user_id, lesson_date) constraint, so only one concurrent INSERT
  // succeeds); a stale existing row is reserved with a conditional
  // UPDATE that only succeeds if it still holds the exact text just
  // read. Either way, a losing concurrent request doesn't call Groq at
  // all, closing the TOCTOU window a plain "check then write" would leave open.
  if (!cachedLesson) {
    const { error: reserveError } = await supabaseAdmin
      .from('daily_lessons')
      .insert({ user_id: user.id, lesson_date: today, lesson_text: RESERVATION_PLACEHOLDER });

    if (reserveError) {
      // Unique violation: another concurrent request just reserved (or
      // finished) this slot. Give it a moment then return what's there.
      const { data: raceWinner } = await supabaseAdmin
        .from('daily_lessons')
        .select('lesson_text')
        .eq('user_id', user.id)
        .eq('lesson_date', today)
        .maybeSingle();
      if (raceWinner?.lesson_text && raceWinner.lesson_text !== RESERVATION_PLACEHOLDER) {
        return json({ lessonText: raceWinner.lesson_text, hasSessionToday: true });
      }
      return json({ error: "Ton enseignement du soir est déjà en cours de génération, réessaie dans quelques secondes." }, 429);
    }
  } else if (isStale && cachedLesson.lesson_text !== RESERVATION_PLACEHOLDER) {
    const { data: reserved } = await supabaseAdmin
      .from('daily_lessons')
      .update({ lesson_text: RESERVATION_PLACEHOLDER })
      .eq('user_id', user.id)
      .eq('lesson_date', today)
      .eq('lesson_text', cachedLesson.lesson_text)
      .select('lesson_text')
      .maybeSingle();

    if (!reserved) {
      // Someone else already started (or finished) regenerating this
      // lesson — return whatever's there now instead of racing a
      // second Groq call.
      const { data: raceWinner } = await supabaseAdmin
        .from('daily_lessons')
        .select('lesson_text')
        .eq('user_id', user.id)
        .eq('lesson_date', today)
        .maybeSingle();
      if (raceWinner?.lesson_text && raceWinner.lesson_text !== RESERVATION_PLACEHOLDER) {
        return json({ lessonText: raceWinner.lesson_text, hasSessionToday: true });
      }
      return json({ error: "Ton enseignement du soir est déjà en cours de génération, réessaie dans quelques secondes." }, 429);
    }
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('display_name, probleme_principal, declencheur, declencheur_naturel, objectif, tache_urgente')
    .eq('id', user.id)
    .maybeSingle();

  // Last 3 days' lessons, so the prompt can steer away from repeating
  // the same researcher/concept two days running. Excludes today's own
  // row (real content or the just-set reservation placeholder).
  const { data: recentLessons } = await supabaseAdmin
    .from('daily_lessons')
    .select('lesson_date, lesson_text')
    .eq('user_id', user.id)
    .neq('lesson_date', today)
    .order('lesson_date', { ascending: false })
    .limit(3);

  const pastLessons = (recentLessons ?? []).filter((l) => l.lesson_text && l.lesson_text !== RESERVATION_PLACEHOLDER);
  const lessonsHistory = pastLessons.length > 0
    ? pastLessons.map((l) => `${l.lesson_date}: ${l.lesson_text.slice(0, 100)}...`).join('\n')
    : 'Aucune leçon précédente';

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

  const systemPrompt = `Tu es le moteur d'enseignement de Prédicta. Ta mission : analyser les sessions RÉELLES de l'utilisateur aujourd'hui et générer UN SEUL enseignement scientifique personnalisé de 4 à 6 phrases maximum.

RÈGLES STRICTES :
- Commence TOUJOURS par nommer précisément ce qui s'est passé : durée exacte, statut (complété ou interrompu), contexte
- Choisis UN SEUL fait scientifique pertinent — jamais deux
- Ne cite JAMAIS Gloria Mark ou Sophie Leroy si la session a été complétée — ils concernent uniquement les interruptions et transitions
- Termine par UNE action concrète applicable dès la prochaine session
- Ton direct et chaleureux, jamais condescendant
- 4 à 6 phrases maximum, texte fluide sans titres ni listes
- Utilise le profil de l'utilisateur pour personnaliser la leçon — si son déclencheur habituel est le perfectionnisme, parle de perfectionnisme. Si sa tâche urgente est mentionnée, fais le lien avec elle.

CHOIX DU FAIT SCIENTIFIQUE SELON CE QUI S'EST PASSÉ :
- Session longue complétée (45+ min) → Ann Graybiel (MIT) : neuroplasticité et automatisation des habitudes
- Session courte complétée (moins de 20 min) → Bluma Zeigarnik : la tâche commencée crée une tension vers sa complétion
- Session interrompue par pensée extérieure → Raichle : réseau par défaut qui reprend le dessus
- Session interrompue par fatigue ou difficulté → Baumeister : épuisement de l'ego et fatigue décisionnelle
- Plusieurs sessions interrompues → Sirois & Pychyl : procrastination comme régulation émotionnelle
- Aucune session aujourd'hui → BJ Fogg : l'environnement déclenche 80% des comportements avant toute décision consciente
- Session après une longue absence → Phillippa Lally : formation d'habitude entre 18 et 254 jours, moyenne 66 jours
- Session très productive → Eleanor Maguire : neuroplasticité active à tout âge

EXEMPLES DE LEÇONS PARFAITES :

Exemple 1 — Session de 240 minutes complétée :
"${profile?.display_name ?? 'utilisateur'}. Tu as tenu 4 heures aujourd'hui sans interruption. Ce n'est pas de la volonté — c'est de la neuroplasticité en action. Ann Graybiel (MIT) a montré que les comportements répétés sont progressivement pris en charge par les ganglions de la base, ce qui les rend automatiques et moins coûteux en énergie. Chaque session longue que tu complètes recâble ton cerveau pour que la suivante soit plus facile. Demain, commence à la même heure — ton cerveau a commencé à intégrer ce rythme."

Exemple 2 — Session interrompue par une pensée extérieure :
"${profile?.display_name ?? 'utilisateur'}. Tu as décroché après 23 minutes à cause d'une pensée qui a capté ton attention. C'est le réseau par défaut de ton cerveau (Raichle, 2001) qui a repris le dessus — ce réseau surveille en permanence ton environnement et tes pensées, même quand tu essaies de te concentrer. Ce n'est pas un manque de discipline. La prochaine fois que tu sens une pensée arriver, note-la en 3 mots sur un papier et reviens à ta tâche."

Exemple 3 — Aucune session aujourd'hui :
"${profile?.display_name ?? 'utilisateur'}. Pas de session aujourd'hui. BJ Fogg (Stanford) a montré que 80% de nos comportements sont déclenchés par l'environnement avant toute décision consciente. Si tu n'as pas travaillé aujourd'hui, c'est probablement que ton environnement ne t'y a pas invité. Ce soir, prépare ta session de demain : ouvre les fichiers, note la première action à faire, pose ton téléphone dans une autre pièce."

Exemple 4 — Session interrompue par perfectionnisme :
"${profile?.display_name ?? 'utilisateur'}. Tu as repoussé cette tâche. Flett et Hewitt ont montré que les perfectionnistes procrastinent plus que les autres — pas par paresse, mais par peur de confronter leurs vraies limites. La prochaine fois, fixe-toi un objectif délibérément imparfait : produire quelque chose de moyen en 20 minutes. Le perfectionnisme ne peut pas survivre à l'action."

BASE SCIENTIFIQUE DISPONIBLE :
${SCIENCE_BASE}

Prénom : ${profile?.display_name ?? 'utilisateur'}
Profil de l'utilisateur (utilise ces informations pour personnaliser la leçon) :
- Problème principal : ${profile?.probleme_principal?.join(', ') ?? 'non renseigné'}
- Déclencheur habituel : ${profile?.declencheur?.join(', ') ?? 'non renseigné'}
- Ce qui l'aide à continuer : ${profile?.declencheur_naturel ?? 'non renseigné'}
- Objectif : ${profile?.objectif ?? 'non renseigné'}
- Tâche urgente en cours : ${profile?.tache_urgente ?? 'non renseignée'}

${summaryLine}
Sessions d'aujourd'hui :
${sessionLines}
Leçons des 3 derniers jours (ne répète pas les mêmes concepts) :
${lessonsHistory}`;

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

  // The row already exists (reserved above, or from an earlier attempt
  // today that failed after reserving) — fill it in rather than upsert.
  await supabaseAdmin
    .from('daily_lessons')
    .update({ lesson_text: lessonText.slice(0, 4000) })
    .eq('user_id', user.id)
    .eq('lesson_date', today);

  return json({ lessonText, hasSessionToday: true });
});
