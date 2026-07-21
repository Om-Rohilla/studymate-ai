/**
 * db.js — StudyMate AI
 *
 * Shared data-access layer for all feature pages.
 * Every function requires a valid Supabase session (user must be logged in).
 * All reads/writes go through RLS — users only ever touch their own rows.
 */
import { supabase } from './supabase-client.js'

// ─── Auth helpers ─────────────────────────────────────────────────────────────
export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

// ─── AI Service — calls the Edge Function ────────────────────────────────────
export async function callAI(action, params = {}) {
  const session  = await getSession()
  const anonKey  = import.meta.env.VITE_SUPABASE_ANON_KEY
  const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-service`

  const headers = {
    'Content-Type': 'application/json',
    'apikey':       anonKey,
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
    const errText = await res.text()
    throw new Error(`AI service error ${res.status}: ${errText}`)
  }

  return res.json()
}

// ─── Chat Sessions (Multi-session AI Tutor) ───────────────────────────────────

/** Create a brand new chat session. Returns the new session row. */
export async function createChatSession(userId, subject = 'General', persona = 'socratic') {
  const { data, error } = await supabase
    .from('chat_sessions')
    .insert({
      user_id:    userId,
      subject,
      persona,
      title:      'New Chat',
      messages:   [],
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) console.error('[DB] createChatSession:', error.message)
  return data
}

/** Save/update a specific chat session by its ID. */
export async function saveChatSession(userId, messages, subject = 'General', persona = 'socratic', sessionId = null) {
  // Auto-generate title from first user message
  const firstMsg = messages.find(m => m.sender === 'user')
  const title = firstMsg
    ? firstMsg.text.substring(0, 48) + (firstMsg.text.length > 48 ? '…' : '')
    : 'New Chat'

  if (sessionId) {
    // UPDATE existing session by ID
    const { data, error } = await supabase
      .from('chat_sessions')
      .update({
        subject,
        persona,
        title,
        messages,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) console.error('[DB] saveChatSession (update):', error.message)
    return data
  } else {
    // INSERT new session (multi-session: no unique constraint on user_id)
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({
        user_id:    userId,
        subject,
        persona,
        title,
        messages,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) console.error('[DB] saveChatSession (insert):', error.message)
    return data
  }
}

/** Load all chat sessions for the current user, newest first. */
export async function loadAllChatSessions(userId) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id, title, subject, persona, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(30)

  if (error) console.error('[DB] loadAllChatSessions:', error.message)
  return data || []
}

/** Load a single chat session's full messages. */
export async function loadChatSessionById(sessionId) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (error) console.error('[DB] loadChatSessionById:', error.message)
  return data
}

/** Load the most recent chat session for the current user. */
export async function loadChatSession(userId) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) console.error('[DB] loadChatSession:', error.message)
  return data
}

/** Delete a specific chat session. */
export async function deleteChatSession(sessionId, userId) {
  const { error } = await supabase
    .from('chat_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', userId)

  if (error) console.error('[DB] deleteChatSession:', error.message)
  return !error
}

/** Clear chat history for the current user (legacy single-session). */
export async function clearChatSession(userId) {
  const { error } = await supabase
    .from('chat_sessions')
    .update({ messages: [], title: 'New Chat', updated_at: new Date().toISOString() })
    .eq('user_id', userId)

  if (error) console.error('[DB] clearChatSession:', error.message)
}

// ─── Notes ────────────────────────────────────────────────────────────────────

/** Insert a new saved note for the current user. */
export async function saveNote(userId, { title, rawInput, outputHtml, format }) {
  const { data, error } = await supabase
    .from('notes')
    .insert({
      user_id:     userId,
      title:       title || 'Untitled Note',
      raw_input:   rawInput || '',
      output_html: outputHtml,
      format:      format || 'bullet',
    })
    .select()
    .single()

  if (error) console.error('[DB] saveNote:', error.message)
  return data
}

/** Load all saved notes for the current user, newest first. */
export async function loadNotes(userId) {
  const { data, error } = await supabase
    .from('notes')
    .select('id, title, format, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) console.error('[DB] loadNotes:', error.message)
  return data || []
}

/** Load a single note's full content. */
export async function loadNoteById(noteId) {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('id', noteId)
    .single()

  if (error) console.error('[DB] loadNoteById:', error.message)
  return data
}

/** Delete a saved note. */
export async function deleteNote(noteId) {
  const { error } = await supabase
    .from('notes')
    .delete()
    .eq('id', noteId)

  if (error) console.error('[DB] deleteNote:', error.message)
}

// ─── Quiz Sessions ────────────────────────────────────────────────────────────

/** Save a completed quiz result. */
export async function saveQuizScore(userId, { topic, difficulty, scorePct, correct, total }) {
  const { data, error } = await supabase
    .from('quiz_sessions')
    .insert({
      user_id:    userId,
      topic:      topic || 'General',
      difficulty: difficulty || 'medium',
      score_pct:  scorePct,
      correct,
      total,
    })
    .select()
    .single()

  if (error) console.error('[DB] saveQuizScore:', error.message)
  return data
}

/** Load the last 5 quiz scores for the current user. */
export async function loadQuizHistory(userId) {
  const { data, error } = await supabase
    .from('quiz_sessions')
    .select('topic, difficulty, score_pct, correct, total, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) console.error('[DB] loadQuizHistory:', error.message)
  return data || []
}

// ─── Flashcard Decks ──────────────────────────────────────────────────────────

/** Save / overwrite the default flashcard deck for the current user. */
export async function saveFlashcardDeck(userId, { name, cards }) {
  const { data, error } = await supabase
    .from('flashcard_decks')
    .upsert({
      user_id:    userId,
      name:       name || 'My Deck',
      cards,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    .select()
    .single()

  if (error) console.error('[DB] saveFlashcardDeck:', error.message)
  return data
}

/** Load the flashcard deck for the current user. */
export async function loadFlashcardDeck(userId) {
  const { data, error } = await supabase
    .from('flashcard_decks')
    .select('name, cards')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) console.error('[DB] loadFlashcardDeck:', error.message)
  return data
}

// ─── Planner Plans ────────────────────────────────────────────────────────────

/** Save a generated study plan for the current user. */
export async function savePlan(userId, { subject, days, hoursDay, planItems }) {
  const { data, error } = await supabase
    .from('planner_plans')
    .insert({
      user_id:    userId,
      subject,
      days,
      hours_day:  hoursDay,
      plan_items: planItems,
    })
    .select()
    .single()

  if (error) console.error('[DB] savePlan:', error.message)
  return data
}

/** Load the most recent study plan for the current user. */
export async function loadLatestPlan(userId) {
  const { data, error } = await supabase
    .from('planner_plans')
    .select('subject, days, hours_day, plan_items, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) console.error('[DB] loadLatestPlan:', error.message)
  return data
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

/** Load aggregate stats for the dashboard. */
export async function loadDashboardStats(userId) {
  const [chats, notes, quizzes, plans] = await Promise.allSettled([
    supabase.from('chat_sessions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('notes').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('quiz_sessions').select('score_pct').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    supabase.from('planner_plans').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ])

  const chatCount  = chats.status  === 'fulfilled' ? (chats.value.count  || 0) : 0
  const noteCount  = notes.status  === 'fulfilled' ? (notes.value.count  || 0) : 0
  const planCount  = plans.status  === 'fulfilled' ? (plans.value.count  || 0) : 0
  const quizData   = quizzes.status === 'fulfilled' ? (quizzes.value.data || []) : []
  const avgScore   = quizData.length
    ? Math.round(quizData.reduce((s, r) => s + (r.score_pct || 0), 0) / quizData.length)
    : null

  return { chatCount, noteCount, planCount, quizCount: quizData.length, avgScore }
}
