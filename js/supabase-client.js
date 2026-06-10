/* ============================================================
   Prédicta — Supabase client (browser)
   Loaded after the Supabase UMD bundle:
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
   <script src="/js/supabase-client.js"></script>

   The anon/public key below is safe to expose in the browser:
   it is the "publishable" key and all data access is governed
   by the Row Level Security policies in supabase/schema.sql.
   ============================================================ */

const SUPABASE_URL = 'https://hqdzbeykutvmjnuzhnwy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_P-tNenm-AP1SIX8x6aIJRA_Cv9lpasr';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
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
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('[predicta] getSession error', error.message);
    return null;
  }
  return data.session;
}

/**
 * Sends a magic-link sign-in email. Used by the landing page form.
 * Also inserts the email into the public waitlist table.
 */
async function predictaSignInWithEmail(email, redirectTo) {
  // Best-effort waitlist capture (insert-only, RLS protected)
  await supabase.from('waitlist').insert({ email }).select().maybeSingle();

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo || `${window.location.origin}/predicta-dashboard.html`,
    },
  });

  if (error) throw error;
  return true;
}

/**
 * Signs the current user out and redirects to the landing page.
 */
async function predictaSignOut(redirectTo) {
  await supabase.auth.signOut();
  window.location.href = redirectTo || '/predicta-landing.html';
}

/**
 * Guards a page: redirects to the landing page if no session exists.
 * Returns the session when present.
 */
async function predictaRequireAuth() {
  const session = await predictaGetSession();
  if (!session) {
    window.location.href = '/predicta-landing.html';
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

  const { data, error } = await supabase
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

  const { data, error } = await supabase
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
async function predictaGetLessonProgress() {
  const session = await predictaGetSession();
  if (!session) return {};

  const { data, error } = await supabase
    .from('lesson_progress')
    .select('lesson_id, status, completed_at')
    .eq('user_id', session.user.id);

  if (error) {
    console.error('[predicta] getLessonProgress error', error.message);
    return {};
  }
  return Object.fromEntries(data.map((row) => [row.lesson_id, row]));
}

/**
 * Marks a lesson as in_progress / done for the current user.
 */
async function predictaSetLessonStatus(lessonId, status) {
  const session = await predictaGetSession();
  if (!session) throw new Error('Not authenticated');

  if (!/^[A-F][1-5]$/.test(lessonId)) throw new Error('Invalid lesson id');
  if (!['todo', 'in_progress', 'done'].includes(status)) throw new Error('Invalid status');

  const { data, error } = await supabase
    .from('lesson_progress')
    .upsert(
      {
        user_id: session.user.id,
        lesson_id: lessonId,
        status,
        completed_at: status === 'done' ? new Date().toISOString() : null,
      },
      { onConflict: 'user_id,lesson_id' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Loads the most recent brain_metrics snapshot for the radar chart.
 */
async function predictaGetLatestBrainMetrics() {
  const session = await predictaGetSession();
  if (!session) return null;

  const { data, error } = await supabase
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

  const { data, error } = await supabase
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
