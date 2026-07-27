-- ══════════════════════════════════════════════════════════════════════════
-- StudyMate AI — Production Database Schema (Full Reset & Migration)
-- Run this ONCE in: Supabase Dashboard → SQL Editor → New Query → Run All
-- ══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1. PROFILES (auto-created via trigger on auth.users insert)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text UNIQUE NOT NULL,
  full_name   text NOT NULL DEFAULT 'StudyMate User',
  avatar_url  text,
  bio         text DEFAULT '',
  created_at  timestamptz DEFAULT timezone('utc', now()),
  updated_at  timestamptz DEFAULT timezone('utc', now())
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_owner_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_owner_insert" ON public.profiles;
DROP POLICY IF EXISTS "profiles_owner_update" ON public.profiles;
-- Users can read their own profile
CREATE POLICY "profiles_owner_select" ON public.profiles FOR SELECT USING (auth.uid() = id);
-- Users can insert their own profile (needed for manual registration fallback)
CREATE POLICY "profiles_owner_insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
-- Users can update their own profile
CREATE POLICY "profiles_owner_update" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. CHAT SESSIONS (multi-session AI Tutor history)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT 'New Chat',
  subject     text NOT NULL DEFAULT 'General',
  persona     text NOT NULL DEFAULT 'socratic',
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_count integer GENERATED ALWAYS AS (jsonb_array_length(messages)) STORED,
  created_at  timestamptz DEFAULT timezone('utc', now()),
  updated_at  timestamptz DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS chat_sessions_user_updated ON public.chat_sessions (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_user_created ON public.chat_sessions (user_id, created_at DESC);

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_sessions_owner_all" ON public.chat_sessions;
CREATE POLICY "chat_sessions_owner_all" ON public.chat_sessions
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. NOTES
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT 'Untitled Note',
  raw_input   text NOT NULL DEFAULT '',
  output_html text NOT NULL DEFAULT '',
  format      text NOT NULL DEFAULT 'bullet' CHECK (format IN ('bullet','cornell','cheatsheet','mindmap')),
  depth       text NOT NULL DEFAULT 'detailed' CHECK (depth IN ('standard','detailed','comprehensive')),
  word_count  integer DEFAULT 0,
  created_at  timestamptz DEFAULT timezone('utc', now()),
  updated_at  timestamptz DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS notes_user_created ON public.notes (user_id, created_at DESC);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notes_owner_all" ON public.notes;
CREATE POLICY "notes_owner_all" ON public.notes
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. QUIZ SESSIONS
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.quiz_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  topic       text NOT NULL DEFAULT 'General',
  difficulty  text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  score_pct   integer NOT NULL DEFAULT 0 CHECK (score_pct BETWEEN 0 AND 100),
  correct     integer NOT NULL DEFAULT 0,
  total       integer NOT NULL DEFAULT 0,
  time_taken  integer DEFAULT 0,  -- seconds
  created_at  timestamptz DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS quiz_sessions_user_created ON public.quiz_sessions (user_id, created_at DESC);

ALTER TABLE public.quiz_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quiz_sessions_owner_all" ON public.quiz_sessions;
CREATE POLICY "quiz_sessions_owner_all" ON public.quiz_sessions
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. FLASHCARD DECKS (multi-deck support)
-- ─────────────────────────────────────────────────────────────────────────

-- Drop the old single-deck constraint if it exists
ALTER TABLE IF EXISTS public.flashcard_decks DROP CONSTRAINT IF EXISTS flashcard_decks_user_id_key;

CREATE TABLE IF NOT EXISTS public.flashcard_decks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT 'My Deck',
  topic       text NOT NULL DEFAULT '',
  difficulty  text NOT NULL DEFAULT 'intermediate',
  cards       jsonb NOT NULL DEFAULT '[]'::jsonb,
  card_count  integer GENERATED ALWAYS AS (jsonb_array_length(cards)) STORED,
  is_default  boolean DEFAULT FALSE,
  created_at  timestamptz DEFAULT timezone('utc', now()),
  updated_at  timestamptz DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS flashcard_decks_user_updated ON public.flashcard_decks (user_id, updated_at DESC);

ALTER TABLE public.flashcard_decks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "flashcard_decks_owner_all" ON public.flashcard_decks;
CREATE POLICY "flashcard_decks_owner_all" ON public.flashcard_decks
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. PLANNER PLANS
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.planner_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject     text NOT NULL DEFAULT '',
  goal        text DEFAULT '',
  days        integer NOT NULL DEFAULT 7 CHECK (days BETWEEN 1 AND 30),
  hours_day   integer NOT NULL DEFAULT 2 CHECK (hours_day BETWEEN 1 AND 12),
  plan_items  jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active   boolean DEFAULT TRUE,
  created_at  timestamptz DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS planner_plans_user_created ON public.planner_plans (user_id, created_at DESC);

ALTER TABLE public.planner_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "planner_plans_owner_all" ON public.planner_plans;
CREATE POLICY "planner_plans_owner_all" ON public.planner_plans
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. USER PROGRESS (aggregate stats & streak tracking)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_progress (
  user_id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  study_streak     integer DEFAULT 0,          -- consecutive days studied
  last_study_date  date DEFAULT NULL,
  total_study_mins integer DEFAULT 0,
  xp_points        integer DEFAULT 0,          -- gamification
  level            integer DEFAULT 1,
  badges           jsonb DEFAULT '[]'::jsonb,
  updated_at       timestamptz DEFAULT timezone('utc', now())
);

ALTER TABLE public.user_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_progress_owner_all" ON public.user_progress;
CREATE POLICY "user_progress_owner_all" ON public.user_progress
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 8. DOCUMENTS (uploaded files for AI grounding)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename        text NOT NULL,
  file_path       text NOT NULL DEFAULT '',
  file_type       text NOT NULL DEFAULT '',
  file_size       integer NOT NULL DEFAULT 0,
  extracted_text  text,
  created_at      timestamptz DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS documents_user_created ON public.documents (user_id, created_at DESC);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "documents_owner_all" ON public.documents;
CREATE POLICY "documents_owner_all" ON public.documents
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 9. FUNCTIONS & TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────

-- Auto-create profile on new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;

  -- Also initialise user_progress row
  INSERT INTO public.user_progress (user_id)
  VALUES (new.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_chat_sessions_updated_at ON public.chat_sessions;
CREATE TRIGGER set_chat_sessions_updated_at BEFORE UPDATE ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_flashcard_decks_updated_at ON public.flashcard_decks;
CREATE TRIGGER set_flashcard_decks_updated_at BEFORE UPDATE ON public.flashcard_decks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_notes_updated_at ON public.notes;
CREATE TRIGGER set_notes_updated_at BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 10. DASHBOARD STATS VIEW (fast aggregated stats for homepage)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.dashboard_stats AS
SELECT
  u.id                                         AS user_id,
  (SELECT COUNT(*) FROM public.chat_sessions  cs WHERE cs.user_id = u.id) AS chat_count,
  (SELECT COUNT(*) FROM public.notes          n  WHERE n.user_id  = u.id) AS note_count,
  (SELECT COUNT(*) FROM public.quiz_sessions  qs WHERE qs.user_id = u.id) AS quiz_count,
  (SELECT COUNT(*) FROM public.planner_plans  pp WHERE pp.user_id = u.id) AS plan_count,
  (SELECT COUNT(*) FROM public.flashcard_decks fd WHERE fd.user_id = u.id) AS deck_count,
  (SELECT AVG(score_pct)::integer FROM public.quiz_sessions qs WHERE qs.user_id = u.id AND qs.created_at > now() - interval '30 days') AS avg_score_30d,
  up.study_streak,
  up.xp_points,
  up.level
FROM auth.users u
LEFT JOIN public.user_progress up ON up.user_id = u.id;

-- Grant select to authenticated users (RLS on underlying tables handles data isolation)
GRANT SELECT ON public.dashboard_stats TO authenticated;
