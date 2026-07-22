/**
 * Supabase Edge Function: ai-service
 *
 * A single unified AI proxy for StudyMate AI.
 * Provider priority: Groq (free) → Gemini (free tier) → Gemini 1.5 Flash (fallback)
 *
 * Endpoint: POST /functions/v1/ai-service
 *
 * Request body: { action, ...params }
 *
 * Actions:
 *   "chat"         → { action, messages, persona, subject }
 *   "notes"        → { action, raw_text, format }
 *   "quiz"         → { action, topic, count, difficulty }
 *   "flashcards"   → { action, topic, count }
 *   "plan"         → { action, subject, days, hours_day }
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

// ── Provider config ───────────────────────────────────────────────────────────
const GROQ_API_KEY   = Deno.env.get('GROQ_API_KEY')
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')

// Groq uses OpenAI-compatible endpoint
const GROQ_URL    = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL  = 'llama-3.3-70b-versatile'

// Gemini REST endpoint
const GEMINI_URL  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
}

// ── Detect active provider ────────────────────────────────────────────────────
function getProvider(): 'groq' | 'gemini' | null {
  if (GROQ_API_KEY && GROQ_API_KEY.trim().length > 10)   return 'groq'
  if (GEMINI_API_KEY && GEMINI_API_KEY.trim().length > 10) return 'gemini'
  return null
}

// ── Call Groq (OpenAI-compatible) ─────────────────────────────────────────────
async function callGroq(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature:  0.7,
      max_tokens:   1500,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}

// ── Call Gemini REST API ──────────────────────────────────────────────────────
async function callGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] },
      ],
      generationConfig: {
        temperature:     0.7,
        maxOutputTokens: 1500,
      },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
}

// ── Call Gemini Vision API (for image attachments) ───────────────────────────
async function callGeminiVision(
  systemPrompt: string,
  userPrompt: string,
  imageData: { mime_type: string; data: string }
): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for image analysis')

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: systemPrompt + '\n\n' + userPrompt },
            { inline_data: { mime_type: imageData.mime_type, data: imageData.data } },
          ],
        },
      ],
      generationConfig: {
        temperature:     0.7,
        maxOutputTokens: 1500,
      },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini Vision API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
}

// ── Universal LLM call (auto-selects provider, vision-aware) ──────────────────
async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  imageData?: { mime_type: string; data: string }
): Promise<string> {
  // Images require Gemini Vision regardless of priority setting
  if (imageData) {
    return callGeminiVision(systemPrompt, userPrompt, imageData)
  }
  const provider = getProvider()
  if (!provider) {
    throw new Error('No API key configured. Add GROQ_API_KEY or GEMINI_API_KEY in Supabase Edge Function Secrets.')
  }
  if (provider === 'groq')   return callGroq(systemPrompt, userPrompt)
  if (provider === 'gemini') return callGemini(systemPrompt, userPrompt)
  throw new Error('Unknown provider')
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleChat(body: any): Promise<object> {
  const {
    messages   = [],
    persona    = 'socratic',
    subject    = 'General',
    image_data,   // { mime_type, data } — base64 image for Gemini Vision
    pdf_text,     // extracted PDF text as string
    pdf_name,     // original PDF filename
  } = body

  const personaInstructions: Record<string, string> = {
    socratic: 'You are a Socratic Coach. Guide the student with probing questions rather than direct answers. Encourage critical thinking.',
    eli5:     'You are an ELI5 tutor. Explain everything with simple analogies, plain language, and no jargon. Make it easy for a 10-year-old.',
    academic: 'You are an Academic Expert. Provide formal, textbook-quality explanations with precise terminology.',
    coder:    'You are a Code Architect. Focus on code examples, algorithms, syntax, and technical implementation details.',
  }

  const systemPrompt = `You are StudyMate AI — an intelligent study assistant.
Subject domain: ${subject}
${personaInstructions[persona] ?? personaInstructions.socratic}
Keep responses concise (max 3–4 paragraphs). Format clearly with **bold** for key terms.`

  // Build conversation context from last 6 messages
  const recentMessages = messages.slice(-6)
  const conversationText = recentMessages
    .map((m: any) => `${m.sender === 'user' ? 'Student' : 'Tutor'}: ${m.text}`)
    .join('\n')

  const lastUserMsg = messages.filter((m: any) => m.sender === 'user').pop()?.text ?? ''
  let userPrompt    = conversationText
    ? `Conversation so far:\n${conversationText}\n\nStudent's latest question: ${lastUserMsg}`
    : `Student asks: ${lastUserMsg}`

  // Inject PDF text as context
  if (pdf_text) {
    userPrompt += `\n\n--- UPLOADED DOCUMENT: "${pdf_name ?? 'document.pdf'}" ---\n${pdf_text.substring(0, 6000)}\n--- END DOCUMENT ---\n\nPlease answer the student's question in relation to the above document.`
  }

  // If image_data present → use Gemini Vision
  const imageDataPayload = image_data?.data ? image_data : undefined
  if (imageDataPayload) {
    userPrompt += '\n\nThe student has also attached an image. Please analyse the image and answer their question in relation to it.'
  }

  const reply = await callLLM(systemPrompt, userPrompt, imageDataPayload)
  return { reply }
}

async function handleNotes(body: any): Promise<object> {
  const { raw_text = '', format = 'bullet' } = body

  const formatInstructions: Record<string, string> = {
    bullet:     'Create a structured bullet-point outline with clear H3 section headings and nested bullet points. Use **bold** for key terms.',
    cornell:    'Create Cornell Notes with three sections: "## Cues" (key questions/terms), "## Notes" (detailed content), and "## Summary" (3-line recap).',
    cheatsheet: 'Create a concise formula & term cheat sheet. Use tables or bullet lists with Term: Definition format. Include all formulas.',
  }

  const systemPrompt = `You are StudyMate AI — an expert at creating study materials.
Generate well-structured study notes from the provided raw text.
${formatInstructions[format] ?? formatInstructions.bullet}
Return clean HTML using only: h3, p, ul, li, strong, em, code, table, tr, td, th tags.
Do NOT include html/body/head tags. Just the content HTML.`

  const userPrompt = `Create ${format} format study notes from this content:\n\n${raw_text.substring(0, 4000)}`

  const outputHtml = await callLLM(systemPrompt, userPrompt)
  const title = raw_text.substring(0, 50).replace(/\s+/g, ' ').trim() + '...'
  return { output_html: outputHtml, title }
}

async function handleQuiz(body: any): Promise<object> {
  const { topic = 'General Knowledge', count = 3, difficulty = 'medium' } = body

  const difficultyMap: Record<string, string> = {
    easy:   'basic/introductory level, suitable for beginners',
    medium: 'intermediate level, requiring some understanding',
    hard:   'advanced/expert level, requiring deep knowledge',
  }

  const systemPrompt = `You are StudyMate AI — an expert quiz generator.
Generate exactly ${count} multiple-choice questions about "${topic}" at ${difficultyMap[difficulty] ?? difficultyMap.medium} difficulty.

Return ONLY a valid JSON array with this exact structure (no markdown, no explanation):
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0
  }
]

Rules:
- "correct" is the 0-based index of the correct option
- All 4 options must be plausible
- Questions must be clear and unambiguous
- Return ONLY the JSON array, nothing else`

  const userPrompt = `Generate ${count} ${difficulty} quiz questions about: ${topic}`

  const raw = await callLLM(systemPrompt, userPrompt)

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = raw.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('Invalid quiz format from AI')

  const questions = JSON.parse(jsonMatch[0])
  return { questions }
}

async function handleFlashcards(body: any): Promise<object> {
  const { topic = 'General Knowledge', count = 8 } = body

  const systemPrompt = `You are StudyMate AI — an expert flashcard creator.
Generate exactly ${count} study flashcards about "${topic}".

Return ONLY a valid JSON array with this exact structure (no markdown, no explanation):
[
  {
    "front": "Question or term on the front of the card",
    "back": "Answer or definition on the back of the card"
  }
]

Rules:
- Front should be a clear question or term
- Back should be a concise, accurate answer (1–3 sentences max)
- Cover different aspects of the topic
- Return ONLY the JSON array, nothing else`

  const userPrompt = `Generate ${count} flashcards about: ${topic}`

  const raw = await callLLM(systemPrompt, userPrompt)

  const jsonMatch = raw.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('Invalid flashcard format from AI')

  const cards = JSON.parse(jsonMatch[0])
  return { cards }
}

async function handlePlan(body: any): Promise<object> {
  const { subject = 'Exam', days = 7, hours_day = 2 } = body

  const systemPrompt = `You are StudyMate AI — an expert study planner.
Create a structured ${days}-day study plan for "${subject}" with ${hours_day} hours per day.

Return ONLY a valid JSON array with this exact structure (no markdown, no explanation):
[
  {
    "day": 1,
    "title": "Day title / focus area",
    "description": "Specific tasks and study activities for this day (1–2 sentences)"
  }
]

Rules:
- Exactly ${days} items in the array
- Progress from fundamentals → practice → mastery → review
- Each day should have specific, actionable tasks
- Mention hours: ${hours_day}h per day
- Return ONLY the JSON array, nothing else`

  const userPrompt = `Create a ${days}-day study plan for: ${subject} (${hours_day} hours/day)`

  const raw = await callLLM(systemPrompt, userPrompt)

  const jsonMatch = raw.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('Invalid plan format from AI')

  const planItems = JSON.parse(jsonMatch[0])
  return { plan_items: planItems }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  const provider = getProvider()
  if (!provider) {
    return new Response(JSON.stringify({ error: 'No AI API key configured. Add GROQ_API_KEY or GEMINI_API_KEY in Supabase Edge Function Secrets.' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  try {
    const body   = await req.json()
    const action = body.action

    let result: object

    switch (action) {
      case 'chat':       result = await handleChat(body);       break
      case 'notes':      result = await handleNotes(body);      break
      case 'quiz':       result = await handleQuiz(body);       break
      case 'flashcards': result = await handleFlashcards(body); break
      case 'plan':       result = await handlePlan(body);       break
      default:
        return new Response(JSON.stringify({ error: `Unknown action: "${action}"` }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    console.error('[ai-service] Error:', err)
    return new Response(JSON.stringify({ error: err.message ?? 'Internal server error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})
