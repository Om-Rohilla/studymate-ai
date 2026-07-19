"""
llm_service.py — Centralised LLM interface for StudyMate AI.

Auto-detects available credentials in priority order:
    Groq → OpenAI → Gemini

Falls back to deterministic mock responses when no API key is configured.

All generation methods accept an optional `document_context` string.
When provided, it is injected into the system/user prompt so the LLM
answers questions grounded in the uploaded study material.

Streaming is supported via the `stream_tutor_response` and
`stream_notes_response` async generators, which yield raw text chunks
suitable for Server-Sent Events (SSE).

Multi-turn conversation history is accepted by the tutor methods as a
list of {"role": str, "content": str} dicts (OpenAI chat format). The
frontend is responsible for maintaining and sending the history; the
backend is fully stateless.

Retry strategy: transient API errors are retried up to 2 times with
exponential backoff using the `tenacity` library.
"""

import os
import re
import json
import asyncio
import logging
from typing import AsyncIterator, List, Optional

from openai import OpenAI, AsyncOpenAI, APIStatusError, APIConnectionError
from dotenv import load_dotenv

try:
    from tenacity import (
        retry,
        stop_after_attempt,
        wait_exponential,
        retry_if_exception_type,
        before_sleep_log,
    )
    _TENACITY_OK = True
except ImportError:
    _TENACITY_OK = False

# ─────────────────────────────────────────────────────────────────────────────
# Logging & env
# ─────────────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("StudyMate_LLM")
load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
# Client initialisation — auto-detect credentials
# ─────────────────────────────────────────────────────────────────────────────
def _is_valid(key: Optional[str]) -> bool:
    return bool(key and not key.startswith("your-") and key.strip())


openai_key = os.getenv("OPENAI_API_KEY")
groq_key   = os.getenv("GROQ_API_KEY")
gemini_key = os.getenv("GEMINI_API_KEY")

client:       Optional[OpenAI]      = None
async_client: Optional[AsyncOpenAI] = None
model_name = ""
provider   = ""

if _is_valid(groq_key):
    logger.info("LLM: Groq (llama-3.3-70b-versatile)")
    _base        = "https://api.groq.com/openai/v1"
    client       = OpenAI(api_key=groq_key, base_url=_base)
    async_client = AsyncOpenAI(api_key=groq_key, base_url=_base)
    model_name   = "llama-3.3-70b-versatile"
    provider     = "groq"

elif _is_valid(openai_key):
    logger.info("LLM: OpenAI (gpt-4o)")
    client       = OpenAI(api_key=openai_key)
    async_client = AsyncOpenAI(api_key=openai_key)
    model_name   = "gpt-4o"
    provider     = "openai"

elif _is_valid(gemini_key):
    logger.info("LLM: Google Gemini (gemini-1.5-flash)")
    _base        = "https://generativelanguage.googleapis.com/v1beta/openai/"
    client       = OpenAI(api_key=gemini_key, base_url=_base)
    async_client = AsyncOpenAI(api_key=gemini_key, base_url=_base)
    model_name   = "gemini-1.5-flash"
    provider     = "gemini"

else:
    logger.warning("No valid LLM API key detected — running in fallback mock mode.")


# ─────────────────────────────────────────────────────────────────────────────
# Retry decorator factory
# ─────────────────────────────────────────────────────────────────────────────
def _make_retry():
    """Return a tenacity retry decorator for transient API errors, or a no-op."""
    if not _TENACITY_OK:
        def _noop(fn):
            return fn
        return _noop

    _retryable = (APIStatusError, APIConnectionError, ConnectionError, TimeoutError)
    return retry(
        retry=retry_if_exception_type(_retryable),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )

_with_retry = _make_retry()


# ─────────────────────────────────────────────────────────────────────────────
# Persona definitions
# ─────────────────────────────────────────────────────────────────────────────
PERSONA_PROMPTS: dict[str, str] = {
    # Legacy keys (kept for backwards compatibility)
    "socratic": (
        "You are a Socratic tutor. Guide the student step by step using questions "
        "rather than giving direct answers. Encourage logical deductions."
    ),
    "eli5": (
        "Explain the user's question as if explaining to a 5-year-old child. "
        "Use creative analogies and simple vocabulary."
    ),
    "academic": (
        "Provide a highly rigorous, formal academic review of the topic. "
        "Highlight theoretical constraints, equations, structures, and definitions."
    ),
    "coding": (
        "Provide logical code explanations using programming languages "
        "(like JavaScript/Python) to clarify concepts. Embed code snippets."
    ),

    # Current frontend persona keys
    "beginner": (
        "You are a friendly Beginner Tutor. Use simple language, clear step-by-step "
        "explanations, and relatable everyday analogies. Avoid jargon. Be encouraging "
        "and patient."
    ),
    "exam_coach": (
        "You are an Exam Coach. Focus on what is most likely to appear in exams. "
        "Highlight key formulas, definitions, and common question patterns. Keep "
        "answers concise and exam-ready."
    ),
    "professor": (
        "You are a Professor giving a formal academic lecture. Be comprehensive, "
        "precise, and intellectually rigorous. Include definitions, theoretical "
        "context, and scholarly depth."
    ),
    "friendly_mentor": (
        "You are a Friendly Mentor. Be warm, conversational, and encouraging. "
        "Use real-world examples and analogies. Make complex topics feel approachable "
        "and interesting."
    ),
}

_DEFAULT_PERSONA = "friendly_mentor"


def _persona_prompt(persona: str, subject: str) -> str:
    if persona not in PERSONA_PROMPTS:
        logger.warning(
            "Unknown persona '%s' — defaulting to '%s'.", persona, _DEFAULT_PERSONA
        )
        persona = _DEFAULT_PERSONA
    base = PERSONA_PROMPTS[persona]
    return f"{base} Subject area: {subject}."


# ─────────────────────────────────────────────────────────────────────────────
# Prompt helpers
# ─────────────────────────────────────────────────────────────────────────────
def _doc_context_block(context: Optional[str]) -> str:
    """Build the document context block to inject into prompts."""
    if not context:
        return ""
    return (
        "\n\n--- UPLOADED STUDY MATERIAL ---\n"
        f"{context}\n"
        "--- END OF STUDY MATERIAL ---\n\n"
        "Base your response primarily on the study material above. "
        "If the material does not cover a particular aspect, you may supplement "
        "with your own knowledge but clearly indicate when you are doing so.\n"
    )


def _use_json_format() -> dict:
    """Return response_format arg only for models that support it."""
    # Gemini via OpenAI-compat API doesn't support response_format
    if provider == "gemini":
        return {}
    return {"response_format": {"type": "json_object"}}


def _safe_json_parse(raw: str) -> dict:
    """
    Parse JSON from an LLM response, stripping Markdown fences if present.
    Handles responses like:
        ```json\n{...}\n```
        ```\n{...}\n```
        just {...}
    """
    raw = raw.strip()
    # Strip leading/trailing markdown code fences
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    return json.loads(raw.strip())


def _build_messages(
    system_prompt: str,
    user_content: str,
    history: Optional[List[dict]] = None,
) -> List[dict]:
    """
    Assemble the messages list for a chat completion, inserting history
    between the system prompt and the current user message.

    History items are {"role": "user"|"assistant", "content": str}.
    """
    messages: List[dict] = [{"role": "system", "content": system_prompt}]

    if history:
        for turn in history:
            role = turn.get("role", "")
            content = turn.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": user_content})
    return messages


# ─────────────────────────────────────────────────────────────────────────────
# LLMService
# ─────────────────────────────────────────────────────────────────────────────
class LLMService:

    # ── AI Tutor ─────────────────────────────────────────────────────────────

    @staticmethod
    def query_tutor(
        query: str,
        subject: str,
        persona: str,
        document_context: Optional[str] = None,
        history: Optional[List[dict]] = None,
    ) -> str:
        """
        Synchronous tutor call (used by the standard /api/tutor endpoint).

        Args:
            query:            The user's current question.
            subject:          Subject/domain label.
            persona:          Teaching persona key.
            document_context: Extracted document text for grounding.
            history:          List of previous {"role", "content"} turns.
        """
        if not client:
            return LLMService._fallback_tutor(query, subject, persona)

        system_prompt = _persona_prompt(persona, subject)
        user_content  = _doc_context_block(document_context) + query
        messages      = _build_messages(system_prompt, user_content, history)

        @_with_retry
        def _call():
            return client.chat.completions.create(
                model=model_name,
                messages=messages,
                max_tokens=1500,
                temperature=0.7,
            )

        try:
            response = _call()
            return response.choices[0].message.content or ""
        except Exception as exc:
            logger.error("Tutor API call failed after retries: %s", exc)
            return (
                f"*(LLM service error — please try again.)*\n\n"
                f"{LLMService._fallback_tutor(query, subject, persona)}"
            )

    @staticmethod
    async def stream_tutor_response(
        query: str,
        subject: str,
        persona: str,
        document_context: Optional[str] = None,
        history: Optional[List[dict]] = None,
    ) -> AsyncIterator[str]:
        """
        Async generator that yields text chunks for Server-Sent Events streaming.
        Each yielded value is a raw text delta (not SSE-formatted).

        Supports multi-turn conversation via the `history` parameter.
        """
        if not async_client:
            yield LLMService._fallback_tutor(query, subject, persona)
            return

        system_prompt = _persona_prompt(persona, subject)
        user_content  = _doc_context_block(document_context) + query
        messages      = _build_messages(system_prompt, user_content, history)

        try:
            stream = await async_client.chat.completions.create(
                model=model_name,
                messages=messages,
                max_tokens=1500,
                temperature=0.7,
                stream=True,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        except Exception as exc:
            logger.error("Streaming tutor failed: %s", exc)
            yield f"\n\n*(Stream error: {exc})*"

    # ── Notes / Summaries ────────────────────────────────────────────────────

    @staticmethod
    def generate_notes(
        topic: str,
        subject: str,
        style: str,
        length: str,
        summary_type: str = "detailed",
        document_context: Optional[str] = None,
    ) -> str:
        """
        Generate study notes in HTML.

        summary_type:
            "short"    — concise summary paragraph (3-5 sentences)
            "detailed" — full structured study notes (default)
            "exam"     — exam-focused bullet points, key facts, practice tips
        """
        if not client:
            return LLMService._fallback_notes(topic, subject, style, length)

        type_instruction = {
            "short": (
                "Write a SHORT SUMMARY (3–5 sentences) capturing the most "
                "essential ideas. Do NOT write long paragraphs."
            ),
            "detailed": (
                "Write COMPREHENSIVE STUDY NOTES with all important concepts, "
                "examples, definitions, and explanations."
            ),
            "exam": (
                "Write EXAM-FOCUSED NOTES. Highlight key facts likely to appear "
                "on exams, important formulas/definitions in bold, common "
                "question types, and a quick-revision bullet list."
            ),
        }.get(summary_type, "Write comprehensive study notes.")

        doc_block  = _doc_context_block(document_context)
        topic_line = f'the topic: "{topic}"' if topic.strip() else "the uploaded study material"

        prompt = f"""\
{doc_block}
Generate study notes on {topic_line}.
Subject field: {subject}
Format/Style: {style}
Target length: {length}
Instruction: {type_instruction}

IMPORTANT: Output content using clean HTML tags only (body content: <h1>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <code>).
Do NOT wrap output in ```html blocks or structural html/body tags.
"""

        @_with_retry
        def _call():
            return client.chat.completions.create(
                model=model_name,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are an expert curriculum writer who compiles "
                            "structured, readable study sheets in clean HTML."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=2500,
                temperature=0.6,
            )

        try:
            response = _call()
            return response.choices[0].message.content or ""
        except Exception as exc:
            logger.error("Notes API call failed after retries: %s", exc)
            return LLMService._fallback_notes(topic, subject, style, length)

    @staticmethod
    async def stream_notes_response(
        topic: str,
        subject: str,
        style: str,
        length: str,
        summary_type: str = "detailed",
        document_context: Optional[str] = None,
    ) -> AsyncIterator[str]:
        """
        Async generator for streaming notes generation via SSE.
        Each yielded value is a raw HTML text delta.
        """
        if not async_client:
            yield LLMService._fallback_notes(topic, subject, style, length)
            return

        type_instruction = {
            "short": (
                "Write a SHORT SUMMARY (3–5 sentences) capturing the most "
                "essential ideas."
            ),
            "detailed": (
                "Write COMPREHENSIVE STUDY NOTES with all important concepts, "
                "examples, definitions, and explanations."
            ),
            "exam": (
                "Write EXAM-FOCUSED NOTES. Highlight key facts, formulas, "
                "definitions, and a quick-revision bullet list."
            ),
        }.get(summary_type, "Write comprehensive study notes.")

        doc_block  = _doc_context_block(document_context)
        topic_line = f'the topic: "{topic}"' if topic.strip() else "the uploaded study material"

        prompt = f"""\
{doc_block}
Generate study notes on {topic_line}.
Subject field: {subject}
Format/Style: {style}
Target length: {length}
Instruction: {type_instruction}

IMPORTANT: Output content using clean HTML tags only (<h1>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <code>).
Do NOT wrap output in ```html blocks or structural html/body tags.
"""
        try:
            stream = await async_client.chat.completions.create(
                model=model_name,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are an expert curriculum writer who compiles "
                            "structured, readable study sheets in clean HTML."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=2500,
                temperature=0.6,
                stream=True,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        except Exception as exc:
            logger.error("Streaming notes failed: %s", exc)
            yield f"\n\n*(Stream error: {exc})*"

    # ── Quiz ─────────────────────────────────────────────────────────────────

    @staticmethod
    def generate_quiz(
        topic: str,
        count: int,
        difficulty: str,
        subject: str,
        document_context: Optional[str] = None,
    ) -> dict:
        """Generate multiple-choice quiz questions with answers and explanations."""
        if not client:
            return LLMService._fallback_quiz(topic, count)

        doc_block  = _doc_context_block(document_context)
        topic_line = (
            f'about the topic: "{topic}"' if topic.strip()
            else "based on the uploaded study material"
        )

        prompt = f"""\
{doc_block}
Generate a multiple-choice practice quiz {topic_line} ({subject} category).
Difficulty: {difficulty}
Number of questions: {count}

Respond with a single valid JSON object:
{{
    "questions": [
        {{
            "question": "A clear, multiple choice query text?",
            "options": ["Choice A", "Choice B", "Choice C", "Choice D"],
            "correctIndex": 0,
            "explanation": "Detailed explanation of why choice A is correct."
        }}
    ]
}}
Do not output any introductory or concluding text. Do not wrap in markdown ```json codes.
"""

        @_with_retry
        def _call():
            return client.chat.completions.create(
                model=model_name,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a quiz compiler. You output strictly valid, parsing-ready JSON objects.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=3000,
                temperature=0.5,
                **_use_json_format(),
            )

        try:
            response  = _call()
            raw_text  = response.choices[0].message.content or "{}"
            return _safe_json_parse(raw_text)
        except Exception as exc:
            logger.error("Quiz API call failed after retries: %s", exc)
            return LLMService._fallback_quiz(topic, count)

    # ── Flashcards ────────────────────────────────────────────────────────────

    @staticmethod
    def generate_flashcards(
        topic: str,
        count: int,
        mode: str,
        document_context: Optional[str] = None,
    ) -> dict:
        """Generate question-answer flashcard pairs."""
        if not client:
            return LLMService._fallback_flashcards(topic, count)

        doc_block  = _doc_context_block(document_context)
        topic_line = (
            f'for: "{topic}"' if topic.strip()
            else "based on the uploaded study material"
        )

        prompt = f"""\
{doc_block}
Generate {count} flashcards {topic_line} (Mode: {mode}).

Respond with a single valid JSON object:
{{
    "cards": [
        {{
            "front": "Term or Question text",
            "back": "Definition or short Answer text"
        }}
    ]
}}
Do not output any introductory or concluding text. Do not wrap in markdown ```json codes.
"""

        @_with_retry
        def _call():
            return client.chat.completions.create(
                model=model_name,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a flashcard compiler. You output strictly valid JSON structures.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=2500,
                temperature=0.6,
                **_use_json_format(),
            )

        try:
            response  = _call()
            raw_text  = response.choices[0].message.content or "{}"
            return _safe_json_parse(raw_text)
        except Exception as exc:
            logger.error("Flashcards API call failed after retries: %s", exc)
            return LLMService._fallback_flashcards(topic, count)

    # ── Key Points & Concepts ─────────────────────────────────────────────────

    @staticmethod
    def generate_key_points(
        topic: str,
        subject: str,
        document_context: Optional[str] = None,
    ) -> dict:
        """
        Generate key points and important concepts for quick revision.

        Returns:
            {
                "key_points": [str, ...],
                "concepts":   [{"term": str, "definition": str}, ...]
            }
        """
        if not client:
            return LLMService._fallback_key_points(topic, subject)

        doc_block  = _doc_context_block(document_context)
        topic_line = (
            f'on the topic: "{topic}"' if topic.strip()
            else "from the uploaded study material"
        )

        prompt = f"""\
{doc_block}
Extract the most important key points and core concepts {topic_line} ({subject}).

Respond with a single valid JSON object:
{{
    "key_points": [
        "Key point 1 — concise, exam-ready statement",
        "Key point 2 — concise, exam-ready statement"
    ],
    "concepts": [
        {{
            "term": "Technical term or concept name",
            "definition": "Clear, accurate definition (1-2 sentences)"
        }}
    ]
}}
Include 8-12 key_points and 6-10 concepts. Focus on what matters most for understanding and exams.
Do not output any introductory or concluding text. Do not wrap in markdown ```json codes.
"""

        @_with_retry
        def _call():
            return client.chat.completions.create(
                model=model_name,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are an expert study assistant who identifies the most "
                            "important points and concepts from study material."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=2500,
                temperature=0.5,
                **_use_json_format(),
            )

        try:
            response  = _call()
            raw_text  = response.choices[0].message.content or "{}"
            return _safe_json_parse(raw_text)
        except Exception as exc:
            logger.error("Key Points API call failed after retries: %s", exc)
            return LLMService._fallback_key_points(topic, subject)

    # ── Study Planner ─────────────────────────────────────────────────────────

    @staticmethod
    def generate_planner(subjects: str, date: str, hours: int, strategy: str) -> dict:
        """Generate a structured daily study plan up to an exam date."""
        if not client:
            return LLMService._fallback_planner(subjects, date, hours, strategy)

        prompt = f"""\
Generate a daily study calendar schedule leading up to an exam target date.
Subjects to balance: {subjects}
Exam Date: {date}
Revision hours target: {hours} hours per day.
Study Strategy: {strategy} (balanced, paced, or cram).

Assume today is Day 1. Output a schedule spanning a realistic review timeline (e.g. 5 to 14 days).
You MUST respond with a single valid JSON object containing a key "plan".
Format matching EXACTLY:
{{
    "plan": {{
        "subjects": ["Subject A", "Subject B"],
        "examDateStr": "Formatted Exam Date (e.g. December 15, 2026)",
        "daysRemaining": 10,
        "schedule": [
            {{
                "dayNum": 1,
                "dateStr": "Short date (e.g., Dec 1, Tue)",
                "subject": "Subject A",
                "topic": "Core topic name to revise",
                "hours": 3,
                "completed": false
            }}
        ]
    }}
}}
Do not output any introductory or concluding text. Do not wrap in markdown ```json codes.
"""

        @_with_retry
        def _call():
            return client.chat.completions.create(
                model=model_name,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a planner coordinator. You output strictly valid schedule JSON schema.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=3000,
                temperature=0.5,
                **_use_json_format(),
            )

        try:
            response  = _call()
            raw_text  = response.choices[0].message.content or "{}"
            return _safe_json_parse(raw_text)
        except Exception as exc:
            logger.error("Planner API call failed after retries: %s", exc)
            return LLMService._fallback_planner(subjects, date, hours, strategy)

    # ─────────────────────────────────────────────────────────────────────────
    # Fallback / mock generators (used when no LLM client is configured)
    # ─────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _fallback_tutor(query: str, subject: str, persona: str) -> str:
        q = query.lower()
        if "superposition" in q or "quantum" in q:
            return (
                "Quantum superposition allows particles to exist in multiple linear "
                "states simultaneously. Classically, a coin is heads or tails. In "
                "quantum mechanics, until observed, it behaves as both. What collapses "
                "this superposition?\n\n*(LLM offline — add an API key to .env)*"
            )
        return (
            f"Regarding your question '{query}' in {subject}: Let's trace the core "
            "variables. Approach: What is the main barrier to understanding this topic?"
            "\n\n*(LLM offline — add an API key to .env)*"
        )

    @staticmethod
    def _fallback_notes(topic: str, subject: str, style: str, length: str) -> str:
        return f"""
<h1>{topic or "Study Notes"} <small style="font-weight:normal;opacity:.6">(Offline Mode)</small></h1>
<p><em>Field: {subject} | Format: {style} | Length: {length}</em></p>
<div style="border-left: 3px solid #6c63ff; padding-left: 1rem; margin: 1rem 0; background: rgba(108,99,255,.05); border-radius: 0 6px 6px 0;">
    <p><strong>⚠ LLM Service Offline</strong> — Add a valid API key to <code>backend/.env</code> to enable AI generation.</p>
</div>
<h2>1. Foundational Core</h2>
<p>{topic or "This topic"} constitutes a key component within the {subject} syllabus. Review definition blocks and practice basic equations.</p>
<h2>2. Key Outlines</h2>
<ul>
    <li>Core assumptions and initial system constraints.</li>
    <li>Practical variables and equations mapped to exam boards.</li>
    <li>Connect these principles to real-world applications.</li>
</ul>
<h2>3. Exam Tips</h2>
<ul>
    <li>Always define terms before using them in answers.</li>
    <li>Show all workings — partial marks are awarded.</li>
    <li>Practise past-paper questions under timed conditions.</li>
</ul>
"""

    @staticmethod
    def _fallback_quiz(topic: str, count: int) -> dict:
        return {
            "questions": [
                {
                    "question": f"Which represents a key theoretical pillar of {topic or 'this topic'}?",
                    "options": [
                        "First core variable assumption",
                        "Secondary exceptions parameter",
                        "Standard decay factor",
                        "Zero constraints outcome",
                    ],
                    "correctIndex": 0,
                    "explanation": (
                        f"In introductory {topic or 'this'} analysis, the initial "
                        "variable assumptions form the basis of the equations. "
                        "(LLM offline)"
                    ),
                }
            ] * count
        }

    @staticmethod
    def _fallback_flashcards(topic: str, count: int) -> dict:
        return {
            "cards": [
                {
                    "front": f"Core term in {topic or 'this topic'}",
                    "back": (
                        f"Detailed definition of the term context in "
                        f"{topic or 'this topic'} studies. (LLM offline)"
                    ),
                }
            ] * count
        }

    @staticmethod
    def _fallback_key_points(topic: str, subject: str) -> dict:
        return {
            "key_points": [
                f"{topic or 'This topic'} is a fundamental concept in {subject}.",
                "Review core definitions and terminology.",
                "Understand the underlying principles before tackling problems.",
                "Practice applying concepts to real-world examples.",
                "⚠ LLM service offline — add an API key to backend/.env for AI output.",
            ],
            "concepts": [
                {
                    "term": topic or "Core Concept",
                    "definition": (
                        f"A core concept within the {subject} domain requiring thorough study."
                    ),
                },
                {
                    "term": "Key Principle",
                    "definition": "The foundational rule or law that governs this topic.",
                },
            ],
        }

    @staticmethod
    def _fallback_planner(subjects: str, date: str, hours: int, strategy: str) -> dict:
        subs = [s.strip() for s in subjects.split(",") if s.strip()]
        return {
            "plan": {
                "subjects": subs,
                "examDateStr": date,
                "daysRemaining": 7,
                "schedule": [
                    {
                        "dayNum": i,
                        "dateStr": f"Day {i}",
                        "subject": subs[i % len(subs)] if subs else "Revision",
                        "topic": "General exam review and equations practice (LLM offline)",
                        "hours": hours,
                        "completed": False,
                    }
                    for i in range(1, 8)
                ],
            }
        }
