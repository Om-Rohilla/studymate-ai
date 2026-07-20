/**
 * auth-guard.js — StudyMate AI
 *
 * Import this as the FIRST module script on any protected page:
 *   <script type="module" src="auth-guard.js"></script>
 *
 * If the user has no active session → instantly redirect to login.html.
 * If logged in → do nothing, let the page load normally.
 */
import { supabase } from './supabase-client.js'

;(async function () {
  const { data: { session } } = await supabase.auth.getSession()

  if (!session) {
    // Preserve where the user was trying to go so we can redirect back after login
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search)
    window.location.replace(`login.html?returnTo=${returnTo}`)
  }
})()
