/**
 * db.js — StudyMate AI Data Access Layer (Production)
 *
 * All Supabase calls are centralised here.
 * RLS policies on the server ensure users only ever access their own data.
 * Every function returns null/[] on error — callers check for null, never throw.
 */

import { supabase } from './supabase-client.js'

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

// ─── AI Edge Function caller ───────────────────────────────────────────────────

export async function callAI(action, params = {}) {
  const session = await getSession()
  const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-service`
  const anonKey  = import.meta.env.VITE_SUPABASE_ANON_KEY

  const headers = {
    'Content-Type': 'application/json',
    'apikey': anonKey,
    'Authorization': session?.access_token
      ? `Bearer ${session.access_token}`
      : `Bearer ${anonKey}`,
  }

  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, ...params }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? `AI service error ${res.status}`)
  }

  return res.json()
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

/** Load the current user's profile. Creates one if it doesn't exist. */
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (error && error.code === 'PGRST116') {
    // Row not found — create it
    return upsertProfile(userId, {})
  }
  if (error) { console.error('[DB] getProfile:', error.message); return null }
  return data
}

export async function upsertProfile(userId, { fullName, avatarUrl, bio } = {}) {
  const { data: { user } } = await supabase.auth.getUser()
  const meta = user?.user_metadata ?? {}

  const { data, error } = await supabase
    .from('profiles')
    .upsert({
      id:         userId,
      email:      user?.email ?? '',
      full_name:  fullName ?? meta.full_name ?? meta.name ?? user?.email?.split('@')[0] ?? 'StudyMate User',
      avatar_url: avatarUrl ?? meta.avatar_url ?? null,
      bio:        bio ?? '',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })
    .select()
    .single()

  if (error) { console.error('[DB] upsertProfile:', error.message); return null }
  return data
}

// ─── Chat Sessions ─────────────────────────────────────────────────────────────

export async function createChatSession(userId, subject = 'General', persona = 'socratic') {
  const { data, error } = await supabase
    .from('chat_sessions')
    .insert({
      user_id: userId,
      subject,
      persona,
      title:    'New Chat',
      messages: [],
    })
    .select()
    .single()

  if (error) { console.error('[DB] createChatSession:', error.message); return null }
  return data
}

export async function saveChatSession(userId, messages, subject = 'General', persona = 'socratic', sessionId = null) {
  const firstMsg = messages.find(m => m.sender === 'user')
  const title = firstMsg
    ? firstMsg.text.substring(0, 48) + (firstMsg.text.length > 48 ? '…' : '')
    : 'New Chat'

  if (sessionId) {
    const { data, error } = await supabase
      .from('chat_sessions')
      .update({ subject, persona, title, messages, updated_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) { console.error('[DB] saveChatSession (update):', error.message); return null }
    return data
  } else {
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({ user_id: userId, subject, persona, title, messages })
      .select()
      .single()

    if (error) { console.error('[DB] saveChatSession (insert):', error.message); return null }
    return data
  }
}

export async function loadAllChatSessions(userId) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id, title, subject, persona, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(40)

  if (error) { console.error('[DB] loadAllChatSessions:', error.message); return [] }
  return data ?? []
}

export async function loadChatSessionById(sessionId) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (error) { console.error('[DB] loadChatSessionById:', error.message); return null }
  return data
}

export async function loadChatSession(userId) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) { console.error('[DB] loadChatSession:', error.message); return null }
  return data
}

export async function deleteChatSession(sessionId, userId) {
  const { error } = await supabase
    .from('chat_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', userId)

  if (error) { console.error('[DB] deleteChatSession:', error.message); return false }
  return true
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function saveNote(userId, { title, rawInput, outputHtml, format, depth }) {
  const wordCount = outputHtml?.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).length ?? 0

  const { data, error } = await supabase
    .from('notes')
    .insert({
      user_id:     userId,
      title:       title?.substring(0, 200) || 'Untitled Note',
      raw_input:   rawInput?.substring(0, 10000) || '',
      output_html: outputHtml,
      format:      format || 'bullet',
      depth:       depth  || 'detailed',
      word_count:  wordCount,
    })
    .select()
    .single()

  if (error) { console.error('[DB] saveNote:', error.message); return null }
  return data
}

export async function loadNotes(userId) {
  const { data, error } = await supabase
    .from('notes')
    .select('id, title, format, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(30)

  if (error) { console.error('[DB] loadNotes:', error.message); return [] }
  return data ?? []
}

export async function loadNoteById(noteId) {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('id', noteId)
    .single()

  if (error) { console.error('[DB] loadNoteById:', error.message); return null }
  return data
}

export async function deleteNote(noteId) {
  const { error } = await supabase.from('notes').delete().eq('id', noteId)
  if (error) { console.error('[DB] deleteNote:', error.message); return false }
  return true
}

// ─── Quiz Sessions ─────────────────────────────────────────────────────────────

export async function saveQuizScore(userId, { topic, difficulty, scorePct, correct, total, timeTaken }) {
  const { data, error } = await supabase
    .from('quiz_sessions')
    .insert({
      user_id:    userId,
      topic:      topic?.substring(0, 200) || 'General',
      difficulty: difficulty || 'medium',
      score_pct:  scorePct  ?? 0,
      correct:    correct   ?? 0,
      total:      total     ?? 0,
      time_taken: timeTaken ?? 0,
    })
    .select()
    .single()

  if (error) { console.error('[DB] saveQuizScore:', error.message); return null }

  // Award XP for completing a quiz
  const xp = Math.round((scorePct ?? 0) / 10) * 5 // 0–50 XP per quiz
  await addXP(userId, xp)

  return data
}

export async function loadQuizHistory(userId) {
  const { data, error } = await supabase
    .from('quiz_sessions')
    .select('topic, difficulty, score_pct, correct, total, time_taken, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) { console.error('[DB] loadQuizHistory:', error.message); return [] }
  return data ?? []
}

// ─── Flashcard Decks (multi-deck) ─────────────────────────────────────────────

/** Save a new flashcard deck (creates a new row each time). */
export async function saveFlashcardDeck(userId, { name, cards, topic, difficulty }) {
  const { data, error } = await supabase
    .from('flashcard_decks')
    .insert({
      user_id:    userId,
      name:       name?.substring(0, 200) || 'My Deck',
      topic:      topic?.substring(0, 200) || name || '',
      difficulty: difficulty || 'intermediate',
      cards:      cards || [],
      is_default: false,
    })
    .select()
    .single()

  if (error) { console.error('[DB] saveFlashcardDeck:', error.message); return null }
  return data
}

/** Load all flashcard decks for a user, newest first. */
export async function loadFlashcardDecks(userId) {
  const { data, error } = await supabase
    .from('flashcard_decks')
    .select('id, name, topic, difficulty, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(20)

  if (error) { console.error('[DB] loadFlashcardDecks:', error.message); return [] }
  return data ?? []
}

/** Load a single deck with all cards. */
export async function loadFlashcardDeckById(deckId) {
  const { data, error } = await supabase
    .from('flashcard_decks')
    .select('*')
    .eq('id', deckId)
    .single()

  if (error) { console.error('[DB] loadFlashcardDeckById:', error.message); return null }
  return data
}

/** Legacy: load most recent deck (keeps old pages working). */
export async function loadFlashcardDeck(userId) {
  const { data, error } = await supabase
    .from('flashcard_decks')
    .select('name, cards, topic, difficulty')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) { console.error('[DB] loadFlashcardDeck:', error.message); return null }
  return data
}

export async function deleteFlashcardDeck(deckId) {
  const { error } = await supabase.from('flashcard_decks').delete().eq('id', deckId)
  if (error) { console.error('[DB] deleteFlashcardDeck:', error.message); return false }
  return true
}

// ─── Planner Plans ─────────────────────────────────────────────────────────────

export async function savePlan(userId, { subject, goal, days, hoursDay, planItems }) {
  const { data, error } = await supabase
    .from('planner_plans')
    .insert({
      user_id:    userId,
      subject:    subject?.substring(0, 300) || '',
      goal:       goal?.substring(0, 500) || '',
      days:       days     || 7,
      hours_day:  hoursDay || 2,
      plan_items: planItems || [],
      is_active:  true,
    })
    .select()
    .single()

  if (error) { console.error('[DB] savePlan:', error.message); return null }
  return data
}

export async function loadLatestPlan(userId) {
  const { data, error } = await supabase
    .from('planner_plans')
    .select('id, subject, goal, days, hours_day, plan_items, is_active, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) { console.error('[DB] loadLatestPlan:', error.message); return null }
  return data
}

export async function loadAllPlans(userId) {
  const { data, error } = await supabase
    .from('planner_plans')
    .select('id, subject, goal, days, hours_day, is_active, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) { console.error('[DB] loadAllPlans:', error.message); return [] }
  return data ?? []
}

// ─── User Progress / XP ───────────────────────────────────────────────────────

export async function getUserProgress(userId) {
  const { data, error } = await supabase
    .from('user_progress')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error && error.code === 'PGRST116') {
    // Create row if missing
    const { data: created } = await supabase
      .from('user_progress')
      .insert({ user_id: userId })
      .select()
      .single()
    return created
  }
  if (error) { console.error('[DB] getUserProgress:', error.message); return null }
  return data
}

export async function addXP(userId, xp) {
  if (!userId || xp <= 0) return
  const { data: current } = await supabase
    .from('user_progress')
    .select('xp_points, level')
    .eq('user_id', userId)
    .single()

  if (!current) return

  const newXP    = (current.xp_points ?? 0) + xp
  const newLevel = Math.floor(newXP / 500) + 1  // Level up every 500 XP

  await supabase.from('user_progress').update({
    xp_points: newXP,
    level:     newLevel,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId)
}

export async function updateStudyStreak(userId) {
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase
    .from('user_progress')
    .select('study_streak, last_study_date')
    .eq('user_id', userId)
    .single()

  if (!data) return

  const last = data.last_study_date
  const streak = last === today
    ? data.study_streak  // already counted today
    : last === new Date(Date.now() - 86400000).toISOString().split('T')[0]
      ? (data.study_streak ?? 0) + 1   // consecutive day
      : 1  // streak broken

  await supabase.from('user_progress').update({
    study_streak:    streak,
    last_study_date: today,
    updated_at:      new Date().toISOString(),
  }).eq('user_id', userId)

  return streak
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

export async function loadDashboardStats(userId) {
  // Parallel queries — all settle, none throw
  const [chats, notes, quizzes, plans, decks, progress] = await Promise.allSettled([
    supabase.from('chat_sessions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('notes').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('quiz_sessions').select('score_pct, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
    supabase.from('planner_plans').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('flashcard_decks').select('id, card_count').eq('user_id', userId),
    supabase.from('user_progress').select('study_streak, xp_points, level').eq('user_id', userId).single(),
  ])

  const val = (p) => p.status === 'fulfilled' ? p.value : null

  const quizData  = val(quizzes)?.data ?? []
  const deckData  = val(decks)?.data ?? []

  return {
    chatCount:   val(chats)?.count  ?? 0,
    noteCount:   val(notes)?.count  ?? 0,
    planCount:   val(plans)?.count  ?? 0,
    quizCount:   quizData.length,
    deckCount:   deckData.length,
    totalCards:  deckData.reduce((s, d) => s + (d.card_count ?? 0), 0),
    avgScore:    quizData.length
      ? Math.round(quizData.reduce((s, r) => s + (r.score_pct ?? 0), 0) / quizData.length)
      : null,
    studyStreak: val(progress)?.data?.study_streak ?? 0,
    xpPoints:    val(progress)?.data?.xp_points    ?? 0,
    level:       val(progress)?.data?.level         ?? 1,
  }
}
