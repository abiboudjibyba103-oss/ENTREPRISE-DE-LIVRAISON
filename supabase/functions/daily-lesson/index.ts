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

const COACH_MODEL = 'openai/gpt-oss-120b';

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
- Eleanor Maguire (UCL): la neuroplasticité est active à tout âge, le cerveau se réorganise physiquement avec l'usage.
- Ann Graybiel (MIT): les habitudes répétées sont prises en charge par les ganglions de la base (chunking), réduisant le coût cognitif.
- Phillippa Lally (UCL, 2010): formation d'une habitude entre 18 et 254 jours, moyenne 66 jours (pas 21).
- Dunning-Kruger / métacognition: s'observer régulièrement accélère la progression bien plus que l'absence de suivi.
- Kaplan (théorie de la restauration attentionnelle): l'attention dirigée est une ressource qui s'épuise avec l'usage prolongé et se restaure par un vrai temps de récupération, pas juste une interruption courte.
- Yerkes-Dodson (1908): la performance suit une courbe en U inversé selon le niveau de pression/difficulté — au-delà d'un seuil optimal propre à la tâche et à la compétence du moment, plus de difficulté ou de stress dégrade la performance au lieu de l'améliorer.
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
    .select('duration_min, focus_score, status, started_at, ended_at, notes, interruption_reason, pause_count, total_paused_sec')
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
      // Real fact for the "logically consistent advice" rule below —
      // e.g. never suggest "take a longer break" if one was already taken.
      if (s.pause_count) parts.push(`a déjà pris ${s.pause_count} pause(s) pendant cette session, totalisant ${Math.round((s.total_paused_sec || 0) / 60)} min`);
      return parts.join(', ');
    })
    .join('\n');

  const summaryLine = `Résumé du jour: ${totalSessions} session(s) au total, ${completedSessions} terminée(s), ${interruptedSessions} interrompue(s).` +
    (interruptionReasons.length
      ? ` Raisons d'interruption données par l'utilisateur : ${interruptionReasons.map((r) => `"${r}"`).join(', ')}.`
      : '');

  // Détecte le pattern longue session → relance rapide → abandon
  const sessionsCompletees = todaySessions.filter((s) => s.status === 'completed');
  const sessionsInterrompues = todaySessions.filter((s) => s.status === 'interrupted');

  const longueSessions = sessionsCompletees.filter((s) => (s.duration_min || 0) >= 60);

  let patternEpuisement = false;
  let tempsAvantDeuxiemeSession: number | null = null;

  if (longueSessions.length > 0 && sessionsInterrompues.length > 0) {
    // Vérifie si une session interrompue a été lancée peu après une longue session
    const derniereLogueSession = longueSessions[longueSessions.length - 1];
    const sessionApres = todaySessions.find((s) =>
      s.status === 'interrupted' &&
      derniereLogueSession.ended_at &&
      new Date(s.started_at).getTime() > new Date(derniereLogueSession.ended_at).getTime()
    );

    if (sessionApres && derniereLogueSession.ended_at) {
      const minutesAvant = Math.floor(
        (new Date(sessionApres.started_at).getTime() - new Date(derniereLogueSession.ended_at).getTime()) / (1000 * 60)
      );
      tempsAvantDeuxiemeSession = minutesAvant;
      patternEpuisement = true;
    }
  }

  const deuxLonguesSessionsCompletees = sessionsCompletees.filter((s) => (s.duration_min || 0) >= 60).length >= 2;

  const patternLine = patternEpuisement
    ? `Pattern détecté : longue session complétée suivie d'une session relancée ${tempsAvantDeuxiemeSession} minutes après et interrompue. Utilise la restauration attentionnelle (Kaplan) — l'attention dirigée a besoin d'un vrai temps de récupération après un effort soutenu — et suggère d'espacer davantage la prochaine fois.`
    : deuxLonguesSessionsCompletees
    ? `Pattern détecté : deux longues sessions complétées aujourd'hui. Ne pas mentionner les pauses ou l'épuisement — ce n'est pas son problème. Parle d'autre chose.`
    : '';

  // Récurrence sur 14 jours de la MÊME raison d'interruption (texte
  // exact), même approche que groupInterruptionsByReason() dans
  // generate-predictions — un vrai comptage en code, jamais estimé par
  // le modèle. Ne dit rien de plus que "cette raison est revenue N
  // fois" ; c'est au prompt de décider si ça concerne l'interruption
  // d'aujourd'hui avant de le mentionner.
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000);
  const { data: recentInterrupted } = await supabaseAdmin
    .from('sessions')
    .select('interruption_reason')
    .eq('user_id', user.id)
    .eq('status', 'interrupted')
    .gte('started_at', fourteenDaysAgo.toISOString());

  const reasonCounts = new Map<string, number>();
  (recentInterrupted ?? []).forEach((s) => {
    const reason = (s.interruption_reason || '').trim();
    if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  });
  let recurringReason: { reason: string; count: number } | null = null;
  for (const [reason, count] of reasonCounts) {
    if (count >= 3 && (!recurringReason || count > recurringReason.count)) {
      recurringReason = { reason, count };
    }
  }
  const recurrenceLine = recurringReason
    ? `Récurrence détectée sur 14 jours : la raison "${recurringReason.reason}" est revenue exactement ${recurringReason.count} fois. Si l'interruption d'aujourd'hui a cette même raison, dis explicitement que c'est un vrai pattern structurel à corriger, pas un incident isolé — sinon ignore cette information.`
    : '';

  const systemPrompt = `Tu es le moteur d'enseignement de Prédicta. Ta mission : analyser les sessions RÉELLES de l'utilisateur aujourd'hui et générer UN SEUL enseignement scientifique personnalisé de 4 à 6 phrases maximum.

RÈGLES STRICTES :
- Commence TOUJOURS par nommer précisément ce qui s'est passé : durée exacte, statut (complété ou interrompu), contexte
- Choisis UN SEUL fait scientifique pertinent, et UNIQUEMENT parmi la liste fermée ci-dessous (BASE SCIENTIFIQUE DISPONIBLE) — jamais deux, et jamais un chercheur, une théorie ou un concept hors de cette liste. En particulier, n'utilise JAMAIS Baumeister ni "l'épuisement de l'ego" (fatigue décisionnelle incluse) — ce ne sont plus des concepts autorisés ici, même si tu les connais par ailleurs.
- Ne cite JAMAIS Gloria Mark ou Sophie Leroy si la session a été complétée — ils concernent uniquement les interruptions et transitions
- Le conseil final doit être logiquement cohérent avec les faits réels listés plus bas : par exemple, si l'utilisateur a déjà pris une pause pendant cette session, ne recommande JAMAIS "prends une pause plus longue" comme solution — propose autre chose qui tient compte de ce qu'il a déjà essayé
- Termine par UNE action concrète applicable dès la prochaine session
- Ton direct et chaleureux, jamais condescendant
- 4 à 6 phrases maximum, texte fluide sans titres ni listes
- Utilise le profil de l'utilisateur pour personnaliser la leçon — si son déclencheur habituel est le perfectionnisme, parle de perfectionnisme. Si sa tâche urgente est mentionnée, fais le lien avec elle.
- Si l'utilisateur a enchaîné deux longues sessions (60+ min chacune) ET les deux sont complétées → NE JAMAIS mentionner les pauses ou l'épuisement cognitif. Ce n'est pas son pattern. Parle d'autre chose basé sur ses données.

CLASSIFICATION DE LA RAISON D'INTERRUPTION — à déduire toi-même du texte donné par l'utilisateur :
- Raison EXTERNE / TECHNIQUE (ex: connexion internet instable, coupure de courant, bruit extérieur, quelqu'un t'a interrompu, appareil défaillant) → N'utilise JAMAIS de conseil psychologique ou motivationnel (repos, discipline, fatigue mentale) : ce serait hors sujet, la cause n'est pas comportementale. Donne à la place un conseil pratique/logistique concret (préparer son travail à l'avance pour résister à une coupure, méthode de travail hors-ligne, batterie ou connexion de secours...).
- Raison COMPORTEMENTALE (distraction, fatigue, tâche trop difficile, ennui, procrastination) → utilise le fait scientifique adapté de la liste ci-dessous.
- Si l'utilisateur a complété une session entière plus tôt dans la même journée, ne cherche PAS une explication de fatigue qui contredirait ce fait — souligne plutôt cette réussite positivement.

CHOIX DU FAIT SCIENTIFIQUE SELON CE QUI S'EST PASSÉ (uniquement parmi ces concepts) :
- Session longue complétée (45+ min) → Ann Graybiel (MIT) : neuroplasticité et automatisation des habitudes (chunking)
- Session courte complétée (moins de 20 min) → Bluma Zeigarnik : la tâche commencée crée une tension vers sa complétion
- Session interrompue par une pensée ou une distraction extérieure → Raichle : réseau par défaut qui reprend le dessus
- Session interrompue par fatigue (raison comportementale) → Kaplan (restauration attentionnelle) : l'attention dirigée s'épuise avec l'usage et a besoin d'un vrai temps de récupération, pas juste une pause courte
- Session interrompue parce que la tâche est devenue trop difficile → Yerkes-Dodson : au-delà d'un certain niveau de difficulté ou de pression par rapport à la compétence du moment, la performance chute
- Plusieurs sessions interrompues → Sirois & Pychyl : procrastination comme régulation émotionnelle
- Aucune session aujourd'hui → BJ Fogg : l'environnement déclenche 80% des comportements avant toute décision consciente
- Session après une longue absence → Phillippa Lally : formation d'habitude entre 18 et 254 jours, moyenne 66 jours
- Session très productive → Eleanor Maguire : neuroplasticité active à tout âge
- Longue session complétée (60+ min) suivie d'une deuxième session lancée rapidement (moins de 20 min après) ET cette deuxième session a été interrompue → Kaplan (restauration attentionnelle) : l'attention dirigée a besoin d'un vrai temps de récupération après un effort soutenu. Explique que la prochaine fois, après une session de 60+ minutes, il faudrait attendre [temps_avant_session] minutes de plus avant de relancer.

EXEMPLES DE LEÇONS PARFAITES :

Exemple 1 — Session de 240 minutes complétée :
"${profile?.display_name ?? 'utilisateur'}. Tu as tenu 4 heures aujourd'hui sans interruption. Ce n'est pas de la volonté — c'est de la neuroplasticité en action. Ann Graybiel (MIT) a montré que les comportements répétés sont progressivement pris en charge par les ganglions de la base, ce qui les rend automatiques et moins coûteux en énergie. Chaque session longue que tu complètes recâble ton cerveau pour que la suivante soit plus facile. Demain, commence à la même heure — ton cerveau a commencé à intégrer ce rythme."

Exemple 2 — Session interrompue par une pensée extérieure :
"${profile?.display_name ?? 'utilisateur'}. Tu as décroché après 23 minutes à cause d'une pensée qui a capté ton attention. C'est le réseau par défaut de ton cerveau (Raichle, 2001) qui a repris le dessus — ce réseau surveille en permanence ton environnement et tes pensées, même quand tu essaies de te concentrer. Ce n'est pas un manque de discipline. La prochaine fois que tu sens une pensée arriver, note-la en 3 mots sur un papier et reviens à ta tâche."

Exemple 3 — Aucune session aujourd'hui :
"${profile?.display_name ?? 'utilisateur'}. Pas de session aujourd'hui. BJ Fogg (Stanford) a montré que 80% de nos comportements sont déclenchés par l'environnement avant toute décision consciente. Si tu n'as pas travaillé aujourd'hui, c'est probablement que ton environnement ne t'y a pas invité. Ce soir, prépare ta session de demain : ouvre les fichiers, note la première action à faire, pose ton téléphone dans une autre pièce."

Exemple 4 — Session interrompue par perfectionnisme :
"${profile?.display_name ?? 'utilisateur'}. Tu as repoussé cette tâche. Flett et Hewitt ont montré que les perfectionnistes procrastinent plus que les autres — pas par paresse, mais par peur de confronter leurs vraies limites. La prochaine fois, fixe-toi un objectif délibérément imparfait : produire quelque chose de moyen en 20 minutes. Le perfectionnisme ne peut pas survivre à l'action."

Exemple 5 — Session interrompue par une raison externe/technique :
"${profile?.display_name ?? 'utilisateur'}. Ta session s'est arrêtée après 15 minutes à cause d'une coupure de connexion internet — ce n'est pas un manque de concentration, c'est un problème technique indépendant de toi. Pas besoin de chercher une explication psychologique ici. La prochaine fois, prépare en amont de quoi continuer hors-ligne quelques minutes (documents téléchargés, idées notées sur papier) pour ne pas perdre le fil si ça recoupe. Ce sera ta meilleure parade."

BASE SCIENTIFIQUE DISPONIBLE :
${SCIENCE_BASE}

Prénom : ${profile?.display_name ?? 'utilisateur'}
Profil de l'utilisateur (utilise ces informations pour personnaliser la leçon) :
- Problème principal : ${profile?.probleme_principal?.join(', ') ?? 'non renseigné'}
- Déclencheur habituel : ${profile?.declencheur?.join(', ') ?? 'non renseigné'}
- Ce qui l'aide à continuer : ${profile?.declencheur_naturel ?? 'non renseigné'}
- Objectif : ${profile?.objectif ?? 'non renseigné'}
- Tâche urgente en cours : ${profile?.tache_urgente ?? 'non renseignée'}

${patternLine}
${recurrenceLine}
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
        max_tokens: 600,
        // openai/gpt-oss-120b defaults to "thinking mode" — its
        // reasoning tokens eat into max_tokens before the actual
        // lesson text, which can leave content empty or truncated.
        // This model only accepts low/medium/high (no 'none'); low
        // keeps reasoning minimal without erroring.
        reasoning_effort: 'low',
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
  const lessonText: string = aiData.choices?.[0]?.message?.content?.trim() || '';

  if (!lessonText) {
    // Don't cache a placeholder as if it were a real lesson — that
    // would stick for the rest of the day (the cache check only
    // regenerates on staleness, not on "content looks like a
    // fallback"). Leaving the row at RESERVATION_PLACEHOLDER is safe:
    // the next request just falls through the reservation checks and
    // tries Groq again.
    console.error('[daily-lesson] empty content from Groq', JSON.stringify(aiData).slice(0, 500));
    return json({ error: 'Impossible de générer ton enseignement du jour pour le moment, réessaie plus tard.' }, 502);
  }

  // The row already exists (reserved above, or from an earlier attempt
  // today that failed after reserving) — fill it in rather than upsert.
  await supabaseAdmin
    .from('daily_lessons')
    .update({ lesson_text: lessonText.slice(0, 4000) })
    .eq('user_id', user.id)
    .eq('lesson_date', today);

  return json({ lessonText, hasSessionToday: true });
});
