"""
flashcards.py — Flashcard generation endpoint.

Endpoints:
    POST /api/flashcards            — Generate flashcards
    POST /api/generate-flashcards   — Alias

Supports optional document_id to generate flashcards directly
from the uploaded study material.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from models.schemas import FlashcardRequest, FlashcardResponse
from services.llm_service import LLMService
from routes._helpers import resolve_document_context

router = APIRouter()
logger = logging.getLogger("StudyMate_API.flashcards")


@router.post("/flashcards",          response_model=FlashcardResponse, summary="Generate flashcards")
@router.post("/generate-flashcards", response_model=FlashcardResponse, summary="Generate flashcards (alias)")
async def generate_flashcards(
    req: FlashcardRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Generates question-answer flashcard pairs.

    When document_id is provided, flashcards are based on the uploaded document.
    A valid JWT is required in that case.
    """
    document_context = await resolve_document_context(req.document_id, authorization)

    if not req.topic.strip() and not document_context:
        raise HTTPException(status_code=400, detail="Provide a topic or a valid document_id.")

    if req.count < 1 or req.count > 50:
        raise HTTPException(status_code=400, detail="Flashcard count must be between 1 and 50.")

    cards_data = LLMService.generate_flashcards(
        topic=req.topic,
        count=req.count,
        mode=req.mode,
        document_context=document_context,
    )

    if "cards" not in cards_data:
        raise HTTPException(status_code=500, detail="LLM failed to return structured flashcards.")

    return FlashcardResponse(status="success", cards=cards_data["cards"])
