/* ============================================================
   Prédicta — Supabase client (browser)
   Loaded after the Supabase UMD bundle:
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
   <script src="/js/supabase-client.js"></script>

   The anon/public key below is safe to expose in the browser:
   it is the "publishable" key and all data access is governed
   by the Row Level Security policies in supabase/schema.sql.
   ============================================================ */

const SUPABASE_URL = 'https://zxldqphiqhfpbqrrsazb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4bGRxcGhpcWhmcGJxcnJzYXpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MTg0NTAsImV4cCI6MjA5NTI5NDQ1MH0.spgh0mGRllw08DdYRPRZHZn_F2psSptyOsHDQEI9a1I';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/**
 * Returns the current session, or null if the visitor is not signed in.
 */
async function predictaGetSession() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.error('[predicta] getSession error', error.message);
    return null;
  }
  return data.session;
}

/**
 * Pre-launch sign-up: registers name + email + phone on the waitlist via
 * the `waitlist-join` edge function, optionally linking the signup to
 * whoever referred them. Returns { referralCode, alreadyRegistered }.
 */
async function predictaWaitlistJoin({ name, email, phone, ref }) {
  const safeName = String(name || '').trim().slice(0, 100);
  const safeEmail = String(email || '').trim().toLowerCase().slice(0, 255);
  const safeRef = String(ref || '').trim().toUpperCase().slice(0, 16);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!safeName) throw new Error('Le prénom est requis.');
  if (!emailRegex.test(safeEmail)) throw new Error('Adresse email invalide.');

  const { data, error } = await supabaseClient.functions.invoke('waitlist-join', {
    body: { name: safeName, email: safeEmail, ref: safeRef },
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return { referralCode: data.referralCode, alreadyRegistered: !!data.alreadyRegistered };
}

/**
 * Returns how many people joined the waitlist using the given referral code.
 */
async function predictaGetWaitlistReferralCount(code) {
  const safeCode = String(code || '').trim().toUpperCase().slice(0, 16);
  if (!safeCode) return 0;

  const { data, error } = await supabaseClient.rpc('get_waitlist_referral_count', { code: safeCode });
  if (error) {
    console.error('[predicta] getWaitlistReferralCount error', error.message);
    return 0;
  }
  return typeof data === 'number' ? data : 0;
}

/**
 * Creates a new account with email + password.
 * A `profiles` row is auto-created by the `handle_new_user` trigger,
 * using `displayName` from the user metadata.
 */
async function predictaSignUpWithPassword(email, password, displayName, referralCode) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw new Error('Adresse email invalide');
  if (password.length < 8) throw new Error('Le mot de passe doit contenir au moins 8 caractères');

  const signUpData = { display_name: (displayName || email.split('@')[0]).trim().slice(0, 80) };
  const safeReferralCode = String(referralCode || '').trim().toUpperCase().slice(0, 16);
  if (/^[A-Z0-9]{4,16}$/.test(safeReferralCode)) {
    signUpData.referral_code = safeReferralCode;
  }

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: signUpData,
      emailRedirectTo: `${window.location.origin}/predicta-dashboard.html`,
    },
  });

  if (error) throw error;

  // Best-effort waitlist capture (insert-only, RLS protected)
  await supabaseClient.from('waitlist').insert({ email }).select().maybeSingle();

  return data;
}

/**
 * Signs in an existing user with email + password.
 */
async function predictaSignInWithPassword(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw new Error('Adresse email invalide');
  if (!password) throw new Error('Mot de passe requis');

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/**
 * Signs the current user out and redirects to the auth page.
 */
async function predictaSignOut(redirectTo) {
  await supabaseClient.auth.signOut();
  window.location.href = redirectTo || '/predicta-auth.html';
}

/**
 * Guards a page: redirects to the auth page if no session exists.
 * Returns the session when present.
 */
async function predictaRequireAuth() {
  const session = await predictaGetSession();
  if (!session) {
    window.location.href = '/predicta-auth.html';
    return null;
  }
  return session;
}

/**
 * Loads (or lazily creates) the profile row for the current user.
 */
async function predictaGetProfile() {
  const session = await predictaGetSession();
  if (!session) return null;

  const { data, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) {
    console.error('[predicta] getProfile error', error.message);
    return null;
  }
  return data;
}

/**
 * Returns the current user's referral code and how many people signed
 * up using it: { code, count }.
 */
async function predictaGetReferralStats() {
  const session = await predictaGetSession();
  if (!session) return null;

  const [{ data: profile, error: profileError }, { data: count, error: countError }] = await Promise.all([
    supabaseClient.from('profiles').select('referral_code').eq('id', session.user.id).maybeSingle(),
    supabaseClient.rpc('get_referral_count'),
  ]);

  if (profileError) console.error('[predicta] getReferralStats profile error', profileError.message);
  if (countError) console.error('[predicta] getReferralStats count error', countError.message);

  return { code: profile?.referral_code ?? null, count: typeof count === 'number' ? count : 0 };
}

/**
 * Updates the current user's profile. Only columns owned by the
 * caller can be changed thanks to the profiles_update_own RLS policy.
 */
async function predictaUpdateProfile(patch) {
  const session = await predictaGetSession();
  if (!session) throw new Error('Not authenticated');

  const allowed = ['display_name', 'default_session_minutes', 'notifications_enabled'];
  const safePatch = {};
  for (const key of allowed) {
    if (key in patch) safePatch[key] = patch[key];
  }

  const { data, error } = await supabaseClient
    .from('profiles')
    .update(safePatch)
    .eq('id', session.user.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Loads lesson progress for the current user as a map { lesson_id: status }.
 */
/**
 * Asks Prédicta to generate (or fetch the cached version of)
 * today's personal teaching, grounded in the user's real
 * sessions of the day (Supabase edge function `daily-lesson`).
 * Returns { lessonText, hasSessionToday }: `lessonText` is null
 * when the user hasn't done a session yet today.
 */
async function predictaDailyLesson() {
  const session = await predictaGetSession();
  if (!session) throw new Error('Not authenticated');

  const invoke = () => supabaseClient.functions.invoke('daily-lesson', { body: {} });

  let { data, error } = await invoke();

  if (error?.context?.status === 401) {
    const { data: refreshed, error: refreshError } = await supabaseClient.auth.refreshSession();
    if (!refreshError && refreshed?.session) {
      ({ data, error } = await invoke());
    }
  }

  if (error) {
    if (error.context?.status === 401) {
      throw new Error('Ta session a expiré, reconnecte-toi pour continuer.');
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return { lessonText: data.lessonText ?? null, hasSessionToday: !!data.hasSessionToday };
}

/**
 * Loads the most recent brain_metrics snapshot for the radar chart.
 */
async function predictaGetLatestBrainMetrics() {
  const session = await predictaGetSession();
  if (!session) return null;

  const { data, error } = await supabaseClient
    .from('brain_metrics')
    .select('*')
    .eq('user_id', session.user.id)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[predicta] getLatestBrainMetrics error', error.message);
    return null;
  }
  return data;
}

/**
 * Loads the current user's most recent sessions (default: last 30),
 * most recent first.
 */
async function predictaGetRecentSessions(limit = 30) {
  const session = await predictaGetSession();
  if (!session) return [];

  const { data, error } = await supabaseClient
    .from('sessions')
    .select('id, duration_min, focus_score, status, started_at, ended_at, notes')
    .eq('user_id', session.user.id)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[predicta] getRecentSessions error', error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Records a completed work session for the current user.
 * `durationMin` and `focusScore` are validated client-side as a
 * first line of defense, but the authoritative checks are the
 * CHECK constraints + RLS policies defined in supabase/schema.sql.
 */
async function predictaLogSession({ durationMin, focusScore, status = 'completed', notes = '' }) {
  const session = await predictaGetSession();
  if (!session) throw new Error('Not authenticated');

  const duration = Number(durationMin);
  const focus = focusScore == null ? null : Number(focusScore);

  if (!Number.isInteger(duration) || duration <= 0 || duration > 240) {
    throw new Error('Invalid duration');
  }
  if (focus != null && (!Number.isInteger(focus) || focus < 0 || focus > 100)) {
    throw new Error('Invalid focus score');
  }
  if (!['completed', 'interrupted', 'in_progress'].includes(status)) {
    throw new Error('Invalid status');
  }

  const { data, error } = await supabaseClient
    .from('sessions')
    .insert({
      user_id: session.user.id,
      duration_min: duration,
      focus_score: focus,
      status,
      notes: String(notes).slice(0, 500),
      ended_at: status === 'completed' ? new Date().toISOString() : null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Sends a message to the AI coach (Supabase edge function `coach-chat`).
 * The function authenticates the caller via their JWT, builds a context
 * from the user's real sessions/lessons/brain metrics, and returns a
 * personalized reply. Pass an empty message + empty history to get the
 * coach's daily greeting.
 */
async function predictaCoachChat(message, history) {
  const session = await predictaGetSession();
  if (!session) throw new Error('Not authenticated');

  const safeMessage = String(message || '').slice(0, 500);
  const safeHistory = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }))
    : [];

  const invokeCoach = () =>
    supabaseClient.functions.invoke('coach-chat', {
      body: { message: safeMessage, history: safeHistory },
    });

  let { data, error } = await invokeCoach();

  // The access token may have expired without being refreshed in time
  // (e.g. a tab left open for a while). Refresh once and retry before
  // giving up.
  if (error?.context?.status === 401) {
    const { data: refreshed, error: refreshError } = await supabaseClient.auth.refreshSession();
    if (!refreshError && refreshed?.session) {
      ({ data, error } = await invokeCoach());
    }
  }

  if (error) {
    // When the edge function returns a non-2xx status, supabase-js
    // sets `error` to a generic FunctionsHttpError and leaves `data`
    // null, with the original HTTP status on `error.context.status`.
    const status = error.context?.status;
    if (status === 429) {
      throw new Error("Tu as déjà posé ta question au coach aujourd'hui. Reviens demain pour une nouvelle question !");
    }
    if (status === 401) {
      throw new Error('Ta session a expiré, reconnecte-toi pour continuer.');
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return { reply: data.reply, limitReached: !!data.limitReached };
}
