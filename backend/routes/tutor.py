"""
tutor.py — AI Tutor endpoints.

Endpoints:
    POST /api/tutor          — Standard (non-streaming) tutor response
    POST /api/ask-ai         — Alias for /api/tutor
    POST /api/tutor/stream   — Real-time streaming response via SSE

The streaming endpoint yields Server-Sent Events (SSE). Each event has:
    data: <text chunk>\n\n

A final event signals completion:
    data: [DONE]\n\n

All endpoints:
  • Accept an optional `document_id` to ground the tutor in the content
    of the uploaded study material.
  • Accept an optional `history` list ({"role", "content"} turns) for
    multi-turn conversation context — the frontend maintains history
    and sends it with each request (stateless approach).
"""

import json
import logging
from typing import AsyncIterator, List, Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse

from models.schemas import TutorRequest, TutorResponse, ChatMessage
from services.llm_service import LLMService
from routes._helpers import resolve_document_context

router = APIRouter()
logger = logging.getLogger("StudyMate_API.tutor")


# ─────────────────────────────────────────────────────────────────────────────
# Standard (non-streaming) endpoint
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/tutor",  response_model=TutorResponse, summary="Ask the AI Tutor (standard)")
@router.post("/ask-ai", response_model=TutorResponse, summary="Ask the AI Tutor (alias)")
async def ask_tutor(
    req: TutorRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Synchronous AI tutor call.

    Supports:
      • Optional `document_id` to ground the answer in uploaded content.
      • Optional `history` (list of {role, content}) for multi-turn conversation.
      • `persona` selection: beginner | exam_coach | professor | friendly_mentor
    """
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query text cannot be empty.")

    document_context = await resolve_document_context(req.document_id, authorization)

    # Convert Pydantic ChatMessage objects to plain dicts for the LLM service
    history = [m.model_dump() for m in (req.history or [])]

    response_text = LLMService.query_tutor(
        query=req.query,
        subject=req.subject,
        persona=req.persona,
        document_context=document_context,
        history=history,
    )
    return TutorResponse(status="success", response=response_text)


# ─────────────────────────────────────────────────────────────────────────────
# Streaming endpoint (SSE)
# ─────────────────────────────────────────────────────────────────────────────

@router.post(
    "/tutor/stream",
    summary="Ask the AI Tutor — real-time streaming (SSE)",
    response_class=StreamingResponse,
)
async def stream_tutor(
    req: TutorRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Streaming AI tutor call using Server-Sent Events.

    Each chunk is an SSE event:
        data: <JSON-encoded text fragment>\n\n

    A terminal event signals the end of the stream:
        data: [DONE]\n\n

    Supports:
      • Optional `document_id` for document-grounded answers.
      • Optional `history` for multi-turn context.
      • `persona` for teaching style adaptation.
    """
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query text cannot be empty.")

    document_context = await resolve_document_context(req.document_id, authorization)

    history = [m.model_dump() for m in (req.history or [])]

    async def event_generator() -> AsyncIterator[str]:
        try:
            async for chunk in LLMService.stream_tutor_response(
                query=req.query,
                subject=req.subject,
                persona=req.persona,
                document_context=document_context,
                history=history,
            ):
                # SSE format: "data: <payload>\n\n"
                yield f"data: {json.dumps(chunk)}\n\n"
        except Exception as exc:
            logger.error("SSE stream error: %s", exc)
            yield f"data: {json.dumps('[ERROR] Stream interrupted.')}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",   # Disable nginx buffering
            "Connection":        "keep-alive",
        },
    )
