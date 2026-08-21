/**
 * supabase-client.js
 * Shared singleton Supabase client — imported by all pages.
 * Uses Vite env vars (VITE_ prefix = safe for browser).
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error(
    '[StudyMate] Missing Supabase env vars. ' +
    'Create frontend/.env with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY'
  )
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession:    true,   // keeps session in localStorage automatically
    autoRefreshToken:  true,   // silently refreshes JWTs before expiry
    // PKCE returns a one-time authorization code, rather than exposing an
    // access token in the OAuth redirect URL. Supabase exchanges it locally.
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
})
