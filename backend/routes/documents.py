"""
documents.py — Document upload and management endpoints.

All endpoints require a valid JWT in the Authorization header.

Endpoints:
    POST   /api/documents/upload             Upload a study document
    GET    /api/documents                    List the user's documents
    GET    /api/documents/{document_id}      Get metadata + text preview
    DELETE /api/documents/{document_id}      Delete a document
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from routes.auth import get_current_user_id
from services.document_service import DocumentService, ALLOWED_EXTENSIONS
from models.schemas import (
    DocumentUploadResponse,
    DocumentListItem,
    DocumentDetailResponse,
)

router = APIRouter()
logger = logging.getLogger("StudyMate_API.documents")


# ─────────────────────────────────────────────────────────────────────────────
# Upload
# ─────────────────────────────────────────────────────────────────────────────

@router.post(
    "/documents/upload",
    response_model=DocumentUploadResponse,
    summary="Upload a study document (PDF, DOCX, PPTX, TXT)",
)
async def upload_document(
    file: UploadFile = File(...),
    user_id: int = Depends(get_current_user_id),
):
    """
    Accepts a multipart file upload.
    Extracts text in the background and stores metadata in the database.
    Returns the document_id to use with other AI endpoints.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file name provided.")

    # Read content
    content = await file.read()

    try:
        result = await DocumentService.save_upload(
            file_content=content,
            filename=file.filename,
            user_id=user_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Upload failed for user %s: %s", user_id, exc)
        raise HTTPException(status_code=500, detail="Failed to process the uploaded file.")

    logger.info(
        "User %s uploaded '%s' → document_id=%s",
        user_id, file.filename, result["document_id"]
    )

    return DocumentUploadResponse(
        status="success",
        document_id=result["document_id"],
        filename=result["filename"],
        file_type=result["file_type"],
        file_size=result["file_size"],
        message=(
            f"Document uploaded and processed successfully. "
            f"Use document_id '{result['document_id']}' in AI generation requests."
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# List
# ─────────────────────────────────────────────────────────────────────────────

@router.get(
    "/documents",
    summary="List all documents uploaded by the authenticated user",
)
async def list_documents(user_id: int = Depends(get_current_user_id)):
    """Returns a list of document metadata records for the current user."""
    docs = DocumentService.list_documents(user_id)
    items = [
        DocumentListItem(
            document_id=d["id"],
            filename=d["filename"],
            file_type=d["file_type"],
            file_size=d["file_size"],
            created_at=str(d["created_at"]),
            has_text=bool(d.get("has_text")),
        )
        for d in docs
    ]
    return {"status": "success", "documents": [i.model_dump() for i in items]}


# ─────────────────────────────────────────────────────────────────────────────
# Get Detail
# ─────────────────────────────────────────────────────────────────────────────

@router.get(
    "/documents/{document_id}",
    response_model=DocumentDetailResponse,
    summary="Get document metadata and extracted text preview",
)
async def get_document(
    document_id: str,
    user_id: int = Depends(get_current_user_id),
):
    """Returns metadata and the first ~500 characters of extracted text."""
    doc = DocumentService.get_document_meta(document_id, user_id)
    if not doc:
        raise HTTPException(
            status_code=404,
            detail="Document not found or you do not have access to it.",
        )

    text = doc.get("extracted_text") or ""
    preview = text[:500] + ("..." if len(text) > 500 else "")
    word_count = len(text.split()) if text else 0

    return DocumentDetailResponse(
        status="success",
        document_id=doc["id"],
        filename=doc["filename"],
        file_type=doc["file_type"],
        file_size=doc["file_size"],
        created_at=str(doc["created_at"]),
        text_preview=preview,
        word_count=word_count,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Delete
# ─────────────────────────────────────────────────────────────────────────────

@router.delete(
    "/documents/{document_id}",
    summary="Delete a document (removes file and database record)",
)
async def delete_document(
    document_id: str,
    user_id: int = Depends(get_current_user_id),
):
    """Permanently deletes a document. Only the owning user can delete."""
    deleted = DocumentService.delete_document(document_id, user_id)
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail="Document not found or you do not have access to it.",
        )
    logger.info("User %s deleted document_id=%s", user_id, document_id)
    return {"status": "success", "message": "Document deleted successfully."}
