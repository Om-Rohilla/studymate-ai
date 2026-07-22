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
  const { raw_text = '', format = 'bullet', depth = 'detailed', pdf_name } = body

  const depthInstructions: Record<string, string> = {
    standard:      'Provide a clear, concise overview. Aim for 400–600 words of output.',
    detailed:      'Be thorough and detailed. Include explanations, sub-points, and definitions. Aim for 700–1000 words.',
    comprehensive: 'Be exhaustive and highly detailed. Include all key concepts, sub-concepts, worked examples, formulas, edge cases, and real-world applications. Aim for 1000–1500+ words.',
  }

  const formatPrompts: Record<string, string> = {
    bullet: `Generate RICH STRUCTURED STUDY NOTES in HTML format.

Structure requirements:
- Start with an <h2> tag for the main title (topic name, not "Study Notes")
- Use <h3> tags for each major section/concept (prefix with emoji like 🔬 📐 💡)
- Use <h4> tags for sub-sections within a section
- Use <ul><li> or <ol><li> for bullet points with detailed explanations
- Use <strong>term:</strong> pattern for key term definitions
- Use <table><thead><tr><th></th></tr></thead><tbody>...</tbody></table> for comparison data
- Use <blockquote> for important quotes, principles, or rules to remember
- Use <code> for formulas, variables, or technical terms
- Include a ✅ Key Takeaways <h3> section at the end with 3–5 bullet point summary

Each bullet point must be a complete sentence with explanation — NOT just a keyword.
${depthInstructions[depth] || depthInstructions.detailed}`,

    cornell: `Generate CORNELL-FORMAT STUDY NOTES in HTML.

Structure:
<h2>[Topic Name]</h2>

<h3>📌 Cue Column — Key Questions & Terms</h3>
<ul>
  <li><strong>Q:</strong> [question] → <em>[brief answer hint]</em></li>
  ...at least 6–8 cues
</ul>

<h3>📝 Notes Column — Detailed Content</h3>
[For each cue question, provide a full <h4> + <p> + <ul> explanation block]

<h3>🔑 Key Definitions</h3>
<table with Term | Definition | Example columns>

<h3>📊 Summary</h3>
<blockquote>[3–5 sentence summary capturing the most important ideas]</blockquote>

<h3>✅ Review Questions</h3>
<ol>5 self-test questions to check understanding</ol>

Be thorough. ${depthInstructions[depth] || depthInstructions.detailed}`,

    cheatsheet: `Generate a COMPREHENSIVE FORMULA & TERM CHEAT SHEET in HTML.

Structure:
<h2>⚡ [Topic] — Quick Reference</h2>

<h3>📐 Key Formulas & Equations</h3>
<table>
  <thead><tr><th>Formula</th><th>Meaning</th><th>Variables</th></tr></thead>
  <tbody>rows for every formula</tbody>
</table>

<h3>📖 Definitions — Key Terms</h3>
<table>
  <thead><tr><th>Term</th><th>Definition</th><th>Example</th></tr></thead>
  <tbody>rows for all important terms</tbody>
</table>

<h3>⚠️ Common Mistakes to Avoid</h3>
<ul>mistake bullets</ul>

<h3>💡 Quick Rules & Tips</h3>
<ul>shortcut / mnemonic / quick-reference bullets</ul>

<h3>🔗 Connections & Relationships</h3>
<p>How these concepts link together</p>

Be exhaustive with ALL formulas, terms, and rules. ${depthInstructions[depth] || depthInstructions.detailed}`,

    mindmap: `Generate a CONCEPT BREAKDOWN / MIND-MAP in HTML format.

Structure:
<h2>🧠 [Topic] — Concept Map</h2>
<p>[1-sentence overview of the entire topic]</p>

For each CORE CONCEPT (use <h3> with emoji):
  <h3>🔷 [Core Concept Name]</h3>
  <p>[What it is, why it matters — 2–3 sentences]</p>
  
  <h4>Key Properties / Characteristics</h4>
  <ul>bullets</ul>

  <h4>How It Works</h4>
  <p>step-by-step or mechanism explanation</p>

  <h4>Real-World Example</h4>
  <blockquote>concrete example</blockquote>

  <h4>Common Misconceptions</h4>
  <ul>what people get wrong</ul>

  <h4>Connects To</h4>
  <p>links to other concepts in this topic</p>

End with:
<h3>🗺️ Big Picture Summary</h3>
<p>[How all concepts weave together]</p>

${depthInstructions[depth] || depthInstructions.detailed}`,
  }

  const sourceLabel = pdf_name ? `(extracted from: "${pdf_name}")` : ''

  const systemPrompt = `You are StudyMate AI — an expert educational content creator and study notes specialist.
Your notes are used by students studying for exams. They must be:
1. ACCURATE and factually correct
2. COMPREHENSIVE — cover all important aspects of the topic
3. WELL-STRUCTURED — easy to scan and study
4. ACTIONABLE — students should be able to use these to answer exam questions

CRITICAL HTML RULES:
- Return ONLY clean HTML — no markdown, no \`\`\`html, no code fences
- Only use: h2, h3, h4, p, ul, ol, li, strong, em, code, pre, table, thead, tbody, tr, th, td, blockquote
- Do NOT include: html, head, body, style, script tags
- Make the content rich and detailed — never produce sparse or thin notes
- Every section must have actual educational content, not just a heading`

  const userPrompt = `Create detailed study notes ${sourceLabel} using this format:

${formatPrompts[format] ?? formatPrompts.bullet}

Content to process:
${raw_text.substring(0, 6000)}`

  const outputHtml = await callLLM(systemPrompt, userPrompt)

  // Clean up any accidental markdown code fences
  const clean = outputHtml
    .replace(/^```html?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  const title = pdf_name
    ? pdf_name.replace(/\.pdf$/i, '').replace(/_/g, ' ')
    : raw_text.substring(0, 55).replace(/\s+/g, ' ').trim() + (raw_text.length > 55 ? '…' : '')

  return { output_html: clean, title }
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
