"""
keypoints.py — Key points and concepts extraction endpoint.

Endpoint:
    POST /api/key-points   — Extract key points and important concepts
"""

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException

from models.schemas import KeyPointsRequest, KeyPointsResponse, ConceptItem
from services.llm_service import LLMService
from routes._helpers import resolve_document_context

router = APIRouter()
logger = logging.getLogger("StudyMate_API.keypoints")


@router.post(
    "/key-points",
    response_model=KeyPointsResponse,
    summary="Extract key points and important concepts from a topic or document",
)
async def generate_key_points(
    req: KeyPointsRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Generates:
      - 8-12 concise, exam-ready key points
      - 6-10 important concept definitions

    Works with both topic-based input and uploaded document context.
    When document_id is provided, a valid JWT Authorization header is required.
    """
    document_context = await resolve_document_context(req.document_id, authorization)

    if not req.topic.strip() and not document_context:
        raise HTTPException(
            status_code=400,
            detail="Provide either a topic or a valid document_id.",
        )

    data = LLMService.generate_key_points(
        topic=req.topic,
        subject=req.subject,
        document_context=document_context,
    )

    if "key_points" not in data or "concepts" not in data:
        raise HTTPException(
            status_code=500,
            detail="LLM failed to return a structured key points response.",
        )

    concepts = [
        ConceptItem(term=c.get("term", ""), definition=c.get("definition", ""))
        for c in data.get("concepts", [])
        if isinstance(c, dict)
    ]

    return KeyPointsResponse(
        status="success",
        key_points=data.get("key_points", []),
        concepts=concepts,
    )
