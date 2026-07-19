"""
auth.py — Secure email/password authentication routes.

Endpoints:
  POST /api/auth/register   — Create a new account
  POST /api/auth/login      — Authenticate and receive a JWT
  GET  /api/auth/me         — Return the authenticated user's profile
  POST /api/auth/sync       — Upload local study-progress to the server
  GET  /api/auth/sync       — Download study-progress from the server

Security measures implemented:
  • Email format validated via Pydantic's EmailStr (RFC 5322).
  • Password strength enforced: ≥8 chars, ≥1 uppercase, ≥1 digit.
  • Full name sanitised: stripped, non-empty.
  • Passwords hashed with bcrypt (cost 12) via AuthService.
  • JWTs signed with HS256 using a runtime-mandatory secret.
  • Rate limiting on /login: 5 requests / 15 minutes per IP (via slowapi).
  • Generic error messages on failed login to prevent user enumeration.
  • No OAuth routes — social login will be added in a future milestone.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, EmailStr, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address

from services.auth_service import AuthService
from services.db_service import DBService

router = APIRouter()
logger = logging.getLogger("StudyMate_API.auth")

# One shared Limiter instance (mounted to the app in main.py)
limiter = Limiter(key_func=get_remote_address)


# ─────────────────────────────────────────────────────────────────────────────
# Request / Response Schemas
# ─────────────────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    full_name: str

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters long.")
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter.")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one number.")
        return v

    @field_validator("full_name")
    @classmethod
    def validate_full_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Full name must not be empty.")
        if len(v) < 2:
            raise ValueError("Full name must be at least 2 characters.")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("password")
    @classmethod
    def password_not_empty(cls, v: str) -> str:
        if not v:
            raise ValueError("Password must not be empty.")
        return v


class SyncRequest(BaseModel):
    chats: Optional[str] = None
    notes: Optional[str] = None
    quiz_highscore: Optional[str] = None
    cards: Optional[str] = None
    planner_plan: Optional[str] = None
    tickets: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Auth Dependency — Extract and validate Bearer token
# ─────────────────────────────────────────────────────────────────────────────

async def get_current_user_id(authorization: Optional[str] = Header(None)) -> int:
    """FastAPI dependency that extracts and validates the JWT from the
    Authorization header, returning the authenticated user's integer ID."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header is required.")

    token = authorization.removeprefix("Bearer ").strip()
    user_id = AuthService.decode_access_token(token)

    if user_id is None:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired access token. Please log in again.",
        )
    return user_id


# ─────────────────────────────────────────────────────────────────────────────
# Helper — strip sensitive fields before sending user data to the client
# ─────────────────────────────────────────────────────────────────────────────

def _safe_user(user: dict) -> dict:
    """Return a copy of the user dict with all sensitive fields removed."""
    safe = dict(user)
    safe.pop("password_hash", None)
    safe.pop("oauth_provider", None)   # legacy column may still exist in DB
    return safe


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/auth/register", summary="Register a new user account")
async def register(req: RegisterRequest):
    """
    Create a new email/password account.
    - Validates email format and password strength via Pydantic.
    - Returns a JWT and the safe user profile on success.
    - Returns 409 if the email is already registered (distinct from login to
      avoid leaking info — registration uniqueness is publicly known intent).
    """
    existing = DBService.get_user_by_email(req.email)
    if existing:
        raise HTTPException(
            status_code=409,
            detail="An account with this email address already exists.",
        )

    try:
        pwd_hash = AuthService.hash_password(req.password)
        user_id = DBService.create_user(
            email=req.email,
            password_hash=pwd_hash,
            full_name=req.full_name,
        )
    except Exception as exc:
        logger.error("Registration failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to create account. Please try again.")

    token = AuthService.create_access_token(user_id)
    user = DBService.get_user_by_id(user_id)
    logger.info("New user registered: id=%s email=%s", user_id, req.email)

    return {
        "status": "success",
        "token": token,
        "user": _safe_user(user),
    }


@router.post("/auth/login", summary="Authenticate with email and password")
@limiter.limit("5/15minutes")   # Rate limit: 5 attempts per IP per 15 minutes
async def login(request: Request, req: LoginRequest):
    """
    Authenticate an existing user.
    - Rate-limited to 5 attempts per IP per 15 minutes.
    - Uses generic error messages to prevent user enumeration.
    - Password comparison is constant-time (bcrypt.checkpw).
    """
    _GENERIC_FAIL = "Invalid email address or password."

    user = DBService.get_user_by_email(req.email)

    # Guard: user not found — use the same generic message to prevent enumeration
    if not user:
        raise HTTPException(status_code=401, detail=_GENERIC_FAIL)

    # Guard: account has no password (legacy OAuth-only account)
    if not user.get("password_hash"):
        raise HTTPException(
            status_code=401,
            detail="This account has no password set. Please reset your password.",
        )

    if not AuthService.verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail=_GENERIC_FAIL)

    token = AuthService.create_access_token(user["id"])
    logger.info("User logged in: id=%s", user["id"])

    return {
        "status": "success",
        "token": token,
        "user": _safe_user(user),
    }


@router.get("/auth/me", summary="Get the authenticated user's profile")
async def get_me(user_id: int = Depends(get_current_user_id)):
    user = DBService.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User account not found.")
    return _safe_user(user)


@router.post("/auth/sync", summary="Upload study progress to the server")
async def sync_data(req: SyncRequest, user_id: int = Depends(get_current_user_id)):
    payload = req.model_dump(exclude_unset=True)
    if not payload:
        return {"status": "success", "message": "Nothing to sync."}

    success = DBService.update_user_sync(user_id, payload)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to sync progress data.")

    return {"status": "success", "message": "Progress saved to cloud."}


@router.get("/auth/sync", summary="Download study progress from the server")
async def get_sync_data(user_id: int = Depends(get_current_user_id)):
    sync_data = DBService.get_user_sync(user_id)
    if sync_data is None:
        raise HTTPException(status_code=404, detail="No sync data found for this user.")
    return {"status": "success", "sync_data": sync_data}
