-- ══════════════════════════════════════════════════════════════════════════
-- StudyMate AI — Complete Supabase Database Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1. PROFILES (1:1 with auth.users)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text UNIQUE NOT NULL,
  full_name   text NOT NULL DEFAULT 'StudyMate User',
  avatar_url  text,
  created_at  timestamptz DEFAULT timezone('utc', now())
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_owner_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_owner_update" ON public.profiles;
CREATE POLICY "profiles_owner_select" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_owner_update" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. CHAT SESSIONS (multi-session tutor chat history)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT 'New Chat',
  subject     text NOT NULL DEFAULT 'General',
  persona     text NOT NULL DEFAULT 'socratic',
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz DEFAULT timezone('utc', now()),
  updated_at  timestamptz DEFAULT timezone('utc', now())
);

-- Index for fast per-user queries sorted by updated_at
CREATE INDEX IF NOT EXISTS chat_sessions_user_updated ON public.chat_sessions (user_id, updated_at DESC);

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
  format      text NOT NULL DEFAULT 'bullet',
  created_at  timestamptz DEFAULT timezone('utc', now())
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
  difficulty  text NOT NULL DEFAULT 'medium',
  score_pct   integer NOT NULL DEFAULT 0,
  correct     integer NOT NULL DEFAULT 0,
  total       integer NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS quiz_sessions_user_created ON public.quiz_sessions (user_id, created_at DESC);

ALTER TABLE public.quiz_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quiz_sessions_owner_all" ON public.quiz_sessions;
CREATE POLICY "quiz_sessions_owner_all" ON public.quiz_sessions
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. FLASHCARD DECKS
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.flashcard_decks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT 'My Deck',
  cards       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz DEFAULT timezone('utc', now()),
  updated_at  timestamptz DEFAULT timezone('utc', now()),
  UNIQUE (user_id)  -- one default deck per user (upserted)
);

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
  days        integer NOT NULL DEFAULT 7,
  hours_day   integer NOT NULL DEFAULT 2,
  plan_items  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS planner_plans_user_created ON public.planner_plans (user_id, created_at DESC);

ALTER TABLE public.planner_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "planner_plans_owner_all" ON public.planner_plans;
CREATE POLICY "planner_plans_owner_all" ON public.planner_plans
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. DOCUMENTS (for file-grounded AI)
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

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "documents_owner_all" ON public.documents;
CREATE POLICY "documents_owner_all" ON public.documents
  FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 8. AUTO-CREATE PROFILE TRIGGER
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'StudyMate User')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
