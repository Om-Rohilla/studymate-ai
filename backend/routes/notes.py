"""
notes.py — Notes / Summary generation endpoints.

Endpoints:
    POST /api/notes          — Generate study notes (blocking)
    POST /api/generate-notes — Alias
    POST /api/notes/stream   — Stream notes as Server-Sent Events

Supports:
    summary_type: "short" | "detailed" | "exam"
    document_id:  optional UUID of an uploaded document to use as context
"""

import json
import logging
from typing import AsyncIterator, Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse

from models.schemas import NotesRequest, NotesResponse
from services.llm_service import LLMService
from routes._helpers import resolve_document_context

router = APIRouter()
logger = logging.getLogger("StudyMate_API.notes")


# ─────────────────────────────────────────────────────────────────────────────
# Standard (blocking) endpoint
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/notes",          response_model=NotesResponse, summary="Generate study notes")
@router.post("/generate-notes", response_model=NotesResponse, summary="Generate study notes (alias)")
async def generate_notes(
    req: NotesRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Generates HTML-formatted study notes.

    summary_type options:
      - "short"    — 3-5 sentence summary of main ideas
      - "detailed" — full structured study notes (default)
      - "exam"     — exam-focused bullet points and key facts

    If document_id is provided, the notes are grounded in the uploaded document.
    A valid JWT is required in that case.
    """
    document_context = await resolve_document_context(req.document_id, authorization)

    if not req.topic.strip() and not document_context:
        raise HTTPException(status_code=400, detail="Provide a topic or a valid document_id.")

    notes_html = LLMService.generate_notes(
        topic=req.topic,
        subject=req.subject,
        style=req.style,
        length=req.length,
        summary_type=req.summary_type,
        document_context=document_context,
    )

    return NotesResponse(status="success", notes=notes_html)


# ─────────────────────────────────────────────────────────────────────────────
# Streaming endpoint (SSE)
# ─────────────────────────────────────────────────────────────────────────────

@router.post(
    "/notes/stream",
    summary="Generate study notes — real-time streaming (SSE)",
    response_class=StreamingResponse,
)
async def stream_notes(
    req: NotesRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Streaming notes generation using Server-Sent Events.

    The HTML content is streamed as raw text chunks via SSE:
        data: <JSON-encoded text fragment>\n\n

    A terminal event signals the end of the stream:
        data: [DONE]\n\n

    Useful for displaying notes incrementally in the UI as they are generated.
    """
    document_context = await resolve_document_context(req.document_id, authorization)

    if not req.topic.strip() and not document_context:
        raise HTTPException(status_code=400, detail="Provide a topic or a valid document_id.")

    async def event_generator() -> AsyncIterator[str]:
        try:
            async for chunk in LLMService.stream_notes_response(
                topic=req.topic,
                subject=req.subject,
                style=req.style,
                length=req.length,
                summary_type=req.summary_type,
                document_context=document_context,
            ):
                yield f"data: {json.dumps(chunk)}\n\n"
        except Exception as exc:
            logger.error("Notes SSE stream error: %s", exc)
            yield f"data: {json.dumps('[ERROR] Stream interrupted.')}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )
