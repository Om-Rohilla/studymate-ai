"""
_helpers.py — Shared route-level utilities for StudyMate AI.

Provides:
    resolve_document_context(document_id, authorization)
        Async helper used by notes, quiz, flashcards, keypoints, and tutor
        routes to resolve an optional document_id into the extracted text
        context string.  Raises HTTPException on auth/access failures.
"""

import logging
from typing import Optional

from fastapi import HTTPException

from services.auth_service import AuthService
from services.document_service import DocumentService

logger = logging.getLogger("StudyMate_API.helpers")


async def resolve_document_context(
    document_id: Optional[str],
    authorization: Optional[str],
) -> Optional[str]:
    """
    Given an optional document_id and a raw Authorization header value,
    decode the JWT, assert the document belongs to the user, and return
    the extracted text (truncated to the LLM context window).

    Returns:
        str  — extracted text when document_id is provided and valid
        None — when document_id is None / empty (no-document mode)

    Raises:
        HTTPException 401 — missing/invalid/expired token
        HTTPException 404 — document not found, no text, or wrong user
    """
    if not document_id:
        return None

    if not authorization:
        raise HTTPException(
            status_code=401,
            detail="Authorization header is required when using a document_id.",
        )

    token = authorization.removeprefix("Bearer ").strip()
    user_id = AuthService.decode_access_token(token)
    if user_id is None:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired access token. Please log in again.",
        )

    context = DocumentService.get_document_context(document_id, user_id)
    if context is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "Document not found, has no extracted text, "
                "or you do not have access to it."
            ),
        )

    logger.debug(
        "Resolved document context for doc_id=%s user_id=%s (%d chars)",
        document_id, user_id, len(context),
    )
    return context
