-- Align legacy deployments with the notes table used by the production frontend.
-- Safe to run repeatedly.
ALTER TABLE public.notes
  ADD COLUMN IF NOT EXISTS depth text NOT NULL DEFAULT 'detailed'
    CHECK (depth IN ('standard', 'detailed', 'comprehensive')),
  ADD COLUMN IF NOT EXISTS word_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT timezone('utc', now());
