/**
 * Supabase Edge Function: ai-service — PRODUCTION VERSION
 *
 * Features:
 *  - Per-user rate limiting (10 req/min stored in memory map)
 *  - Input validation & sanitisation on all params
 *  - Structured error logging with request IDs
 *  - Gemini 1.5 Flash (vision) + Groq llama-3.3-70b with fallback chain
 *  - Chat history trimming (max 3000 chars context)
 *  - All 5 actions: chat | notes | quiz | flashcards | plan
 *
 * Endpoint: POST /functions/v1/ai-service
 * Auth: Bearer JWT (Supabase anon key or user JWT)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Environment ───────────────────────────────────────────────────────────────
const GROQ_API_KEY    = Deno.env.get('GROQ_API_KEY')   ?? ''
const GEMINI_API_KEY  = Deno.env.get('GEMINI_API_KEY') ?? ''
const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')   ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Model endpoints
const GROQ_URL    = 'https://api.groq.com/openai/v1/chat/completions'
// Llama 3.3 70B was retired for this Groq account tier. Use Groq's current
// recommended production replacement instead.
const GROQ_MODEL  = 'openai/gpt-oss-120b'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_FLASH_URL  = `${GEMINI_BASE}/gemini-1.5-flash:generateContent`
const GEMINI_PRO_URL    = `${GEMINI_BASE}/gemini-1.5-pro:generateContent`   // fallback

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
}

// ── Rate limiter (in-memory, per edge function instance) ──────────────────────
// Resets on cold start — good enough for edge functions; for stricter limits use Redis/Upstash
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 15       // requests per window
const RATE_WINDOW_MS = 60_000  // 1 minute

function checkRateLimit(userId: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(userId)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (entry.count >= RATE_LIMIT) return false
  entry.count++
  return true
}

// ── Structured logger ─────────────────────────────────────────────────────────
function log(level: 'info' | 'warn' | 'error', reqId: string, msg: string, data?: unknown) {
  const entry = { level, reqId, msg, ts: new Date().toISOString(), ...(data ? { data } : {}) }
  if (level === 'error') console.error(JSON.stringify(entry))
  else console.log(JSON.stringify(entry))
}

// ── Input sanitisation helpers ────────────────────────────────────────────────
function sanitiseStr(v: unknown, maxLen = 8000, def = ''): string {
  if (typeof v !== 'string') return def
  return v.trim().substring(0, maxLen)
}

function sanitiseInt(v: unknown, min: number, max: number, def: number): number {
  const n = parseInt(String(v), 10)
  if (isNaN(n)) return def
  return Math.min(Math.max(n, min), max)
}

function sanitiseEnum<T extends string>(v: unknown, allowed: T[], def: T): T {
  if (typeof v === 'string' && (allowed as string[]).includes(v)) return v as T
  return def
}

// ── Provider detection ────────────────────────────────────────────────────────
function getProvider(): 'groq' | 'gemini' | null {
  if (GROQ_API_KEY.length   > 10) return 'groq'
  if (GEMINI_API_KEY.length > 10) return 'gemini'
  return null
}

// ── LLM Callers ───────────────────────────────────────────────────────────────
async function callGroq(systemPrompt: string, userPrompt: string, maxTokens = 2000): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature:  0.7,
      max_tokens:   maxTokens,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq ${res.status}: ${err.substring(0, 200)}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}

async function callGemini(systemPrompt: string, userPrompt: string, url = GEMINI_FLASH_URL, maxTokens = 2000): Promise<string> {
  const res = await fetch(`${url}?key=${GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini ${res.status}: ${err.substring(0, 200)}`)
  }
  const data = await res.json()
  // Handle safety blocks
  if (data.candidates?.[0]?.finishReason === 'SAFETY') {
    throw new Error('Content blocked by safety filters. Please rephrase your question.')
  }
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
}

async function callGeminiVision(
  systemPrompt: string,
  userPrompt: string,
  imageData: { mime_type: string; data: string },
  maxTokens = 2000
): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for image analysis')

  const res = await fetch(`${GEMINI_FLASH_URL}?key=${GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: `${systemPrompt}\n\n${userPrompt}` },
          { inline_data: { mime_type: imageData.mime_type, data: imageData.data } },
        ],
      }],
      generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini Vision ${res.status}: ${err.substring(0, 200)}`)
  }
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
}

/** Universal LLM call with automatic provider selection and Groq→Gemini fallback */
async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens?: number; imageData?: { mime_type: string; data: string } } = {}
): Promise<string> {
  const { maxTokens = 2000, imageData } = options

  // Images MUST use Gemini Vision
  if (imageData) return callGeminiVision(systemPrompt, userPrompt, imageData, maxTokens)

  const provider = getProvider()
  if (!provider) throw new Error('No AI provider configured. Set GROQ_API_KEY or GEMINI_API_KEY in Supabase secrets.')

  if (provider === 'groq') {
    try {
      return await callGroq(systemPrompt, userPrompt, maxTokens)
    } catch (err: any) {
      // Fallback to Gemini if Groq fails (rate limit, etc.)
      if (GEMINI_API_KEY.length > 10) {
        console.warn('[ai-service] Groq failed, falling back to Gemini:', err.message)
        return await callGemini(systemPrompt, userPrompt, GEMINI_FLASH_URL, maxTokens)
      }
      throw err
    }
  }

  return callGemini(systemPrompt, userPrompt, GEMINI_FLASH_URL, maxTokens)
}

// ── Clean markdown code fences from output ────────────────────────────────────
function cleanMarkdown(raw: string): string {
  return raw
    .replace(/^```(?:html|json|javascript|typescript|python)?\s*/im, '')
    .replace(/```\s*$/im, '')
    .trim()
}

// ── Action Handlers ───────────────────────────────────────────────────────────

async function handleChat(body: any, reqId: string): Promise<object> {
  const messages  = Array.isArray(body.messages) ? body.messages.slice(-12) : []
  const persona   = sanitiseEnum(body.persona, ['socratic', 'eli5', 'academic', 'coder'], 'socratic')
  const subject   = sanitiseStr(body.subject, 100, 'General')
  const image_data = body.image_data?.data && body.image_data?.mime_type ? body.image_data : undefined
  const pdf_text  = sanitiseStr(body.pdf_text, 8000)
  const pdf_name  = sanitiseStr(body.pdf_name, 200)

  const personaInstructions: Record<string, string> = {
    socratic: 'You are a Socratic Coach. Ask probing questions to guide critical thinking. Never just give the answer — lead the student to discover it.',
    eli5:     'You are an ELI5 tutor. Explain everything like the student is 10 years old. Use fun analogies, simple language, no jargon.',
    academic: 'You are an Academic Expert. Provide rigorous, textbook-quality explanations with precise terminology, citations-style structure, and thorough depth.',
    coder:    'You are a Code Architect. Focus on working code examples, algorithms, complexity analysis, design patterns, and technical implementation.',
  }

  const systemPrompt = `You are StudyMate AI — a world-class AI study assistant designed to help students excel.
Subject domain: ${subject}
Persona: ${personaInstructions[persona]}
Response guidelines:
- Keep answers focused and clear (max 4 paragraphs unless the question demands more)
- Use **bold** for key terms, \`code\` for technical terms
- If the student makes an error, gently correct them with an explanation
- Always encourage and support the student's learning journey`

  // Build trimmed conversation context (max 3000 chars to avoid token overflow)
  const conversationText = messages
    .map((m: any) => `${m.sender === 'user' ? 'Student' : 'Tutor'}: ${sanitiseStr(m.text, 500)}`)
    .join('\n')
    .substring(0, 3000)

  const lastUserMsg = messages.filter((m: any) => m.sender === 'user').pop()?.text?.substring(0, 1000) ?? ''

  let userPrompt = conversationText
    ? `Previous conversation:\n${conversationText}\n\nStudent's latest question: ${lastUserMsg}`
    : `Student asks: ${lastUserMsg}`

  if (pdf_text) {
    userPrompt += `\n\n--- DOCUMENT CONTEXT: "${pdf_name || 'Uploaded PDF'}" ---\n${pdf_text}\n--- END DOCUMENT ---\n\nAnswer the student's question in relation to this document.`
  }

  if (image_data) {
    userPrompt += '\n\nThe student has attached an image. Analyse it thoroughly and answer their question.'
  }

  const reply = await callLLM(systemPrompt, userPrompt, { maxTokens: 1500, imageData: image_data })
  return { reply }
}

async function handleNotes(body: any, reqId: string): Promise<object> {
  const raw_text = sanitiseStr(body.raw_text, 8000)
  const format   = sanitiseEnum(body.format, ['bullet', 'cornell', 'cheatsheet', 'mindmap'], 'bullet')
  const depth    = sanitiseEnum(body.depth, ['standard', 'detailed', 'comprehensive'], 'detailed')
  const pdf_name = sanitiseStr(body.pdf_name, 200)

  if (!raw_text) throw new Error('raw_text is required for notes generation')

  const depthGuide: Record<string, string> = {
    standard:      'Concise overview — 400–600 words.',
    detailed:      'Thorough with sub-points and definitions — 700–1000 words.',
    comprehensive: 'Exhaustive with examples, edge cases, and real-world applications — 1200–1800 words.',
  }

  const formatPrompts: Record<string, string> = {
    bullet: `Create RICH STRUCTURED STUDY NOTES as HTML.
- <h2> for main title (the topic itself, not "Study Notes")
- <h3> for each major section with a relevant emoji prefix (🔬 📐 💡 ⚙️ 🧪)
- <h4> for sub-sections
- <ul><li> bullets — each must be a complete explanatory sentence, not just a keyword
- <strong>term:</strong> for key definitions
- <table> for comparisons with proper thead/tbody
- <blockquote> for important rules, principles, or quotes
- <code> for formulas, variable names, code snippets
- End with a ✅ <h3>Key Takeaways</h3> section listing 4–6 critical points
${depthGuide[depth]}`,

    cornell: `Create CORNELL-FORMAT NOTES as HTML.
<h2>[Topic]</h2>
<h3>📌 Cue Column — Key Questions &amp; Terms</h3>
<ul> — 8+ cues as <li><strong>Q:</strong> question → <em>hint</em></li>
<h3>📝 Detailed Notes</h3>
— For every cue: <h4> heading + <p> explanation + <ul> bullets
<h3>🔑 Key Definitions</h3>
— <table> with Term | Definition | Example columns (8+ rows)
<h3>📊 Summary</h3>
— <blockquote> with 4–5 sentence synthesis
<h3>✅ Self-Test Questions</h3>
— <ol> with 6 review questions (no answers — student fills these in)
${depthGuide[depth]}`,

    cheatsheet: `Create a COMPREHENSIVE CHEAT SHEET as HTML.
<h2>⚡ [Topic] — Quick Reference</h2>
<h3>📐 Formulas &amp; Equations</h3> — full table: Formula | Meaning | Variables | When to use
<h3>📖 Key Terms</h3> — full table: Term | Definition | Example
<h3>⚠️ Common Mistakes</h3> — bulleted list
<h3>💡 Tips &amp; Tricks</h3> — bulleted shortcuts and mnemonics
<h3>🔗 Concept Relationships</h3> — how concepts connect
<h3>⏱️ Quick Review Checklist</h3> — checkbox-style bullets starting with "Can I explain..."
${depthGuide[depth]}`,

    mindmap: `Create a CONCEPT BREAKDOWN as HTML.
<h2>🧠 [Topic] — Concept Map</h2>
<p>[1-sentence topic overview]</p>
For each CORE CONCEPT use this exact structure:
<h3>🔷 [Concept Name]</h3>
<p>What it is and why it matters (2–3 sentences)</p>
<h4>Key Properties</h4><ul>...</ul>
<h4>How It Works</h4><p>step-by-step mechanism</p>
<h4>Real-World Example</h4><blockquote>concrete analogy or application</blockquote>
<h4>Common Misconceptions</h4><ul>...</ul>
<h4>Connects To</h4><p>relationships to other concepts</p>
End with: <h3>🗺️ Big Picture</h3><p>synthesis paragraph</p>
${depthGuide[depth]}`,
  }

  const sourceLabel = pdf_name ? `(from: "${pdf_name}")` : ''
  const systemPrompt = `You are StudyMate AI — a specialist in creating exceptional study materials for students preparing for exams.

ABSOLUTE RULES:
1. Return ONLY clean HTML — no markdown, no \`\`\`html fences, no prose outside HTML tags
2. Use ONLY these tags: h2, h3, h4, p, ul, ol, li, strong, em, code, pre, table, thead, tbody, tr, th, td, blockquote
3. NO html/head/body/style/script tags
4. Every section must contain substantive educational content — never leave a heading with no body
5. Be accurate, thorough, and formatted for maximum study value`

  const userPrompt = `Generate study notes ${sourceLabel} using this exact format specification:

${formatPrompts[format]}

Source content to process:
${raw_text}`

  const raw = await callLLM(systemPrompt, userPrompt, { maxTokens: 3000 })
  const output_html = cleanMarkdown(raw)

  const title = pdf_name
    ? pdf_name.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim()
    : raw_text.substring(0, 60).replace(/\s+/g, ' ').trim() + (raw_text.length > 60 ? '…' : '')

  return { output_html, title }
}

async function handleQuiz(body: any, reqId: string): Promise<object> {
  const topic      = sanitiseStr(body.topic, 200, 'General Knowledge')
  const count      = sanitiseInt(body.count, 1, 20, 5)
  const difficulty = sanitiseEnum(body.difficulty, ['easy', 'medium', 'hard'], 'medium')

  const diffMap: Record<string, string> = {
    easy:   'beginner level — definitions, basic recall, straightforward concepts',
    medium: 'intermediate level — application, comprehension, and analysis',
    hard:   'advanced level — synthesis, evaluation, edge cases, and expert-level reasoning',
  }

  const systemPrompt = `You are StudyMate AI — an expert at creating high-quality, educational multiple-choice assessments.
Generate exactly ${count} MCQ questions about "${topic}" at ${diffMap[difficulty]} difficulty.

Return ONLY a valid JSON array — no markdown, no explanation, no code fences:
[
  {
    "question": "Clear, unambiguous question text ending with ?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Brief explanation of why the answer is correct (1–2 sentences)"
  }
]

Rules:
- "correct" is 0-indexed position of the correct answer
- All 4 options must be plausible (no obviously wrong distractors)
- Questions must be distinct — no repetition of similar concepts
- Include an "explanation" field for every question
- Return ONLY the JSON array`

  const userPrompt = `Create ${count} ${difficulty}-difficulty quiz questions about: ${topic}`

  const raw = await callLLM(systemPrompt, userPrompt, { maxTokens: 3000 })
  const jsonMatch = cleanMarkdown(raw).match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('AI returned invalid quiz JSON format')

  const questions = JSON.parse(jsonMatch[0])
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('No quiz questions generated')

  return { questions }
}

async function handleFlashcards(body: any, reqId: string): Promise<object> {
  const topic      = sanitiseStr(body.topic, 200, 'General Knowledge')
  const count      = sanitiseInt(body.count, 1, 30, 10)
  const difficulty = sanitiseEnum(body.difficulty, ['beginner', 'intermediate', 'advanced'], 'intermediate')

  const diffMap: Record<string, string> = {
    beginner:     'Basic definitions, key terms, foundational facts. Questions should be direct and clear.',
    intermediate: 'Mix of definitions, "how/why" questions, applications, and conceptual understanding.',
    advanced:     'Deep mechanisms, edge cases, comparisons between similar concepts, complex applications.',
  }

  const systemPrompt = `You are StudyMate AI — expert flashcard creator for serious students.
Generate exactly ${count} high-quality study flashcards about "${topic}".
Difficulty: ${diffMap[difficulty]}

Return ONLY a valid JSON array — no markdown, no code fences, no explanation:
[
  {
    "front": "Clear question or term",
    "back": "Complete answer with explanation — minimum 1 full sentence, maximum 4 sentences"
  }
]

Rules:
- VARY question types: definitions ("What is...?"), mechanisms ("How does...?"), 
  comparisons ("What is the difference between...?"), applications ("In what scenario would you...?"),
  fill-in-the-blank, cause-and-effect
- Back must include the core fact PLUS context or why it matters or a brief example
- Cover DIVERSE aspects — never repeat similar questions
- Return ONLY the JSON array`

  const userPrompt = `Create ${count} ${difficulty} flashcards about: ${topic}`

  const raw = await callLLM(systemPrompt, userPrompt, { maxTokens: 3000 })
  const jsonMatch = cleanMarkdown(raw).match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('AI returned invalid flashcard JSON format')

  const cards = JSON.parse(jsonMatch[0])
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('No flashcards generated')

  return { cards }
}

async function handlePlan(body: any, reqId: string): Promise<object> {
  const subject   = sanitiseStr(body.subject, 300, 'General Study')
  const days      = sanitiseInt(body.days, 1, 30, 7)
  const hours_day = sanitiseInt(body.hours_day, 1, 12, 2)
  const goal      = sanitiseStr(body.goal, 500)

  const systemPrompt = `You are StudyMate AI — a world-class academic study planner.
Create a structured ${days}-day study plan for: "${subject}"
Study time: ${hours_day} hours/day
${goal ? `Student's goal: ${goal}` : ''}

Return ONLY a valid JSON array — no markdown, no prose, no code fences:
[
  {
    "day": 1,
    "title": "Day focus area (concise, 5–8 words)",
    "tasks": [
      "Specific task 1 with time estimate (e.g., Read Chapter 1 — 45 min)",
      "Specific task 2 with time estimate"
    ],
    "tip": "One actionable study tip for this day's material"
  }
]

Rules:
- Exactly ${days} items
- Realistic progression: foundation → core concepts → application → practice → review → exam prep
- Each day's tasks should total approximately ${hours_day} hours
- Be SPECIFIC — name actual topics, chapters, techniques (not vague like "study topic X")
- Return ONLY the JSON array`

  const userPrompt = `Build a ${days}-day plan for: ${subject} (${hours_day}h/day)`

  const raw = await callLLM(systemPrompt, userPrompt, { maxTokens: 3000 })
  const jsonMatch = cleanMarkdown(raw).match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('AI returned invalid plan JSON format')

  const plan_items = JSON.parse(jsonMatch[0])
  if (!Array.isArray(plan_items) || plan_items.length === 0) throw new Error('No plan items generated')

  return { plan_items }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const reqId = crypto.randomUUID().substring(0, 8)

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // ── Provider check ──────────────────────────────────────────────────────────
  const provider = getProvider()
  if (!provider) {
    return new Response(JSON.stringify({
      error: 'No AI provider configured. Set GROQ_API_KEY or GEMINI_API_KEY in Supabase Edge Function Secrets.',
    }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
  }

  // ── Auth & rate limiting ────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? ''
  let userId = 'anonymous'

  if (authHeader.startsWith('Bearer ') && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      const token = authHeader.replace('Bearer ', '').trim()
      const { data: { user } } = await supabase.auth.getUser(token)
      if (user?.id) userId = user.id
    } catch {
      // Non-fatal — allow anonymous usage with fallback rate limit
    }
  }

  if (!checkRateLimit(userId)) {
    log('warn', reqId, 'Rate limit exceeded', { userId })
    return new Response(JSON.stringify({
      error: 'Too many requests. Please wait a moment before trying again.',
    }), { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Retry-After': '60' } })
  }

  try {
    const body = await req.json()
    const action = sanitiseStr(body?.action, 50)

    if (!action) {
      return new Response(JSON.stringify({ error: 'Missing required field: action' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    log('info', reqId, `Action: ${action}`, { userId, provider })

    let result: object

    switch (action) {
      case 'chat':       result = await handleChat(body, reqId);       break
      case 'notes':      result = await handleNotes(body, reqId);      break
      case 'quiz':       result = await handleQuiz(body, reqId);       break
      case 'flashcards': result = await handleFlashcards(body, reqId); break
      case 'plan':       result = await handlePlan(body, reqId);       break
      default:
        return new Response(JSON.stringify({ error: `Unknown action: "${action}"` }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
    }

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    log('error', reqId, 'Unhandled error', { message: err.message, userId })

    // Friendly error messages
    let userMsg = err.message ?? 'Internal server error'
    let status = 500

    if (userMsg.includes('rate limit') || userMsg.includes('429')) {
      userMsg = 'AI provider rate limit reached. Please try again in a moment.'
      status = 429
    } else if (userMsg.includes('API key') || userMsg.includes('401') || userMsg.includes('403')) {
      userMsg = 'AI provider authentication failed. Please check your API keys.'
      status = 503
    } else if (userMsg.includes('safety') || userMsg.includes('blocked')) {
      userMsg = 'Content was blocked by safety filters. Please rephrase your request.'
      status = 422
    }

    return new Response(JSON.stringify({ error: userMsg, reqId }), {
      status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})
