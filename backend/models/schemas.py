"""
schemas.py — Pydantic request / response models for StudyMate AI.

All models use strict types so FastAPI validates inputs automatically.
"""

from pydantic import BaseModel, field_validator
from typing import List, Optional


# ─────────────────────────────────────────────────────────────────────────────
# Shared building blocks
# ─────────────────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    """A single turn in a multi-turn conversation (OpenAI chat format)."""
    role: str       # "user" | "assistant" | "system"
    content: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        allowed = {"user", "assistant", "system"}
        if v not in allowed:
            raise ValueError(f"role must be one of {allowed}")
        return v


# ─────────────────────────────────────────────────────────────────────────────
# AI Tutor Models
# ─────────────────────────────────────────────────────────────────────────────

class TutorRequest(BaseModel):
    query: str
    subject: str        = "General"
    persona: str        = "friendly_mentor"
    document_id: Optional[str] = None

    # Multi-turn conversation history — frontend sends previous turns
    # so the backend can maintain context without server-side session storage.
    history: Optional[List[ChatMessage]] = []


class TutorResponse(BaseModel):
    status: str
    response: str


# ─────────────────────────────────────────────────────────────────────────────
# Notes Generator Models
# ─────────────────────────────────────────────────────────────────────────────

class NotesRequest(BaseModel):
    topic: str          = ""
    subject: str        = "General"
    style: str          = "structured"
    length: str         = "medium"
    summary_type: str   = "detailed"   # "short" | "detailed" | "exam"
    document_id: Optional[str] = None


class NotesResponse(BaseModel):
    status: str
    notes: str


# ─────────────────────────────────────────────────────────────────────────────
# Quiz Generator Models
# ─────────────────────────────────────────────────────────────────────────────

class QuizQuestion(BaseModel):
    question: str
    options: List[str]
    correctIndex: int
    explanation: str


class QuizRequest(BaseModel):
    topic: str          = ""
    count: int          = 5
    difficulty: str     = "medium"
    subject: str        = "General"
    document_id: Optional[str] = None


class QuizResponse(BaseModel):
    status: str
    questions: List[QuizQuestion]


# ─────────────────────────────────────────────────────────────────────────────
# Flashcards Models
# ─────────────────────────────────────────────────────────────────────────────

class FlashcardItem(BaseModel):
    front: str
    back: str


class FlashcardRequest(BaseModel):
    topic: str          = ""
    count: int          = 10
    mode: str           = "term-definition"
    document_id: Optional[str] = None


class FlashcardResponse(BaseModel):
    status: str
    cards: List[FlashcardItem]


# ─────────────────────────────────────────────────────────────────────────────
# Study Planner Models
# ─────────────────────────────────────────────────────────────────────────────

class PlannerDayBlock(BaseModel):
    dayNum: int
    dateStr: str
    subject: str
    topic: str
    hours: int
    completed: bool = False


class PlannerPlanDetails(BaseModel):
    subjects: List[str]
    examDateStr: str
    daysRemaining: int
    schedule: List[PlannerDayBlock]


class PlannerRequest(BaseModel):
    subjects: str
    date: str
    hours: int          = 4
    strategy: str       = "balanced"


class PlannerResponse(BaseModel):
    status: str
    plan: PlannerPlanDetails


# ─────────────────────────────────────────────────────────────────────────────
# Document Upload Models
# ─────────────────────────────────────────────────────────────────────────────

class DocumentUploadResponse(BaseModel):
    status: str
    document_id: str
    filename: str
    file_type: str
    file_size: int
    message: str


class DocumentListItem(BaseModel):
    document_id: str
    filename: str
    file_type: str
    file_size: int
    created_at: str
    has_text: bool


class DocumentDetailResponse(BaseModel):
    status: str
    document_id: str
    filename: str
    file_type: str
    file_size: int
    created_at: str
    text_preview: str       # first ~500 chars of extracted text
    word_count: int


# ─────────────────────────────────────────────────────────────────────────────
# Key Points & Concepts Models
# ─────────────────────────────────────────────────────────────────────────────

class ConceptItem(BaseModel):
    term: str
    definition: str


class KeyPointsRequest(BaseModel):
    topic: str          = ""
    subject: str        = "General"
    document_id: Optional[str] = None


class KeyPointsResponse(BaseModel):
    status: str
    key_points: List[str]
    concepts: List[ConceptItem]
