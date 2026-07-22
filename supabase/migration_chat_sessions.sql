-- ══════════════════════════════════════════════════════════════════════════
-- StudyMate AI — MIGRATION: Fix chat_sessions to multi-session schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ══════════════════════════════════════════════════════════════════════════

-- Step 1: Drop the old single-session table (had user_id as unique key, no title)
DROP TABLE IF EXISTS public.chat_sessions CASCADE;

-- Step 2: Recreate with correct multi-session structure
CREATE TABLE public.chat_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT 'New Chat',
  subject     text NOT NULL DEFAULT 'General',
  persona     text NOT NULL DEFAULT 'socratic',
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz DEFAULT timezone('utc', now()),
  updated_at  timestamptz DEFAULT timezone('utc', now())
);

-- Step 3: Performance index
CREATE INDEX chat_sessions_user_updated ON public.chat_sessions (user_id, updated_at DESC);

-- Step 4: Enable RLS
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;

-- Step 5: RLS policy — users can only see/edit their own chats
CREATE POLICY "chat_sessions_owner_all" ON public.chat_sessions
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Done! Verify:
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'chat_sessions' AND table_schema = 'public'
ORDER BY ordinal_position;
