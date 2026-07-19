"""
quiz.py — Quiz generation endpoint.

Endpoints:
    POST /api/quiz           — Generate a multiple-choice quiz
    POST /api/generate-quiz  — Alias

Supports optional document_id to generate quiz questions
directly from the uploaded study material.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from models.schemas import QuizRequest, QuizResponse
from services.llm_service import LLMService
from routes._helpers import resolve_document_context

router = APIRouter()
logger = logging.getLogger("StudyMate_API.quiz")


@router.post("/quiz",          response_model=QuizResponse, summary="Generate a multiple-choice quiz")
@router.post("/generate-quiz", response_model=QuizResponse, summary="Generate a quiz (alias)")
async def generate_quiz(
    req: QuizRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Generates multiple-choice quiz questions with answers and explanations.

    When document_id is provided, questions are based on the uploaded document.
    A valid JWT is required in that case.
    """
    document_context = await resolve_document_context(req.document_id, authorization)

    if not req.topic.strip() and not document_context:
        raise HTTPException(status_code=400, detail="Provide a topic or a valid document_id.")

    if req.count < 1 or req.count > 20:
        raise HTTPException(status_code=400, detail="Question count must be between 1 and 20.")

    quiz_data = LLMService.generate_quiz(
        topic=req.topic,
        count=req.count,
        difficulty=req.difficulty,
        subject=req.subject,
        document_context=document_context,
    )

    if "questions" not in quiz_data:
        raise HTTPException(status_code=500, detail="LLM failed to return a structured quiz.")

    return QuizResponse(status="success", questions=quiz_data["questions"])
