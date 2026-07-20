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
/**
 * callAI(action, params)
 *
 * Calls the Supabase Edge Function ai-service with the user's auth token.
 * Falls back gracefully if the function is not deployed or API key is missing.
 *
 * @param {string} action  - 'chat' | 'notes' | 'quiz' | 'flashcards' | 'plan'
 * @param {object} params  - Action-specific parameters
 * @returns {Promise<object>} - Response from the Edge Function
 */
export async function callAI(action, params = {}) {
  const session  = await getSession()
  const anonKey  = import.meta.env.VITE_SUPABASE_ANON_KEY
  const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-service`

  // Supabase Edge Functions require BOTH apikey AND Authorization headers
  const headers = {
    'Content-Type': 'application/json',
    'apikey':       anonKey,
    'Authorization': session?.access_token
      ? `Bearer ${session.access_token}`
      : `Bearer ${anonKey}`,   // anon fallback so unauthenticated calls still reach the function
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

// ─── Chat Sessions (AI Tutor) ─────────────────────────────────────────────────

/** Save / overwrite the active chat session for the current user. */
export async function saveChatSession(userId, messages, subject = 'General', persona = 'socratic') {
  const { data, error } = await supabase
    .from('chat_sessions')
    .upsert({
      user_id:    userId,
      subject,
      persona,
      messages,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    .select()
    .single()

  if (error) console.error('[DB] saveChatSession:', error.message)
  return data
}

/** Load the most recent chat session for the current user. */
export async function loadChatSession(userId) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('messages, subject, persona')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) console.error('[DB] loadChatSession:', error.message)
  return data
}

/** Clear chat history for the current user. */
export async function clearChatSession(userId) {
  const { error } = await supabase
    .from('chat_sessions')
    .update({ messages: [], updated_at: new Date().toISOString() })
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
    .limit(10)

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
