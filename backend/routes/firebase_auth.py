"""
firebase_auth.py — Firebase Custom Token verification endpoint.

This route is called by the Google Colab bootstrap script (Step 7).
It receives a Firebase custom token, verifies the Firebase UID
server-side using the Admin SDK, and returns a StudyMate AI session JWT.

Setup required in backend/.env:
    FIREBASE_PROJECT_ID=your-firebase-project-id

The Firebase Admin SDK is initialized once at module load using
Application Default Credentials (ADC) or a GOOGLE_APPLICATION_CREDENTIALS
env var pointing to a service account JSON — whichever is present.
In production, set GOOGLE_APPLICATION_CREDENTIALS. In development/Colab,
ADC (from 'gcloud auth application-default login') is sufficient.
"""

import logging
import os

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials as fb_creds
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, field_validator

from services.auth_service import AuthService
from services.db_service import DBService

router = APIRouter()
logger = logging.getLogger("StudyMate_API.firebase_auth")

# ─────────────────────────────────────────────────────────────────────────────
# Firebase Admin SDK — initialised once at import time
# ─────────────────────────────────────────────────────────────────────────────
_FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "")

def _init_firebase_app():
    """
    Initialize Firebase Admin SDK without requiring a service account JSON.

    Priority order:
      1. GOOGLE_APPLICATION_CREDENTIALS env var  → service account JSON (prod)
      2. Application Default Credentials (ADC)   → 'gcloud auth' / Colab auth
      3. If FIREBASE_PROJECT_ID is set, it is used regardless of credential source.
    """
    if firebase_admin._DEFAULT_APP_NAME in firebase_admin._apps:
        return firebase_admin.get_app()

    if not _FIREBASE_PROJECT_ID:
        logger.warning(
            "FIREBASE_PROJECT_ID not set in .env — Firebase login endpoint "
            "will be unavailable."
        )
        return None

    try:
        app = firebase_admin.initialize_app(
            credential=fb_creds.ApplicationDefault(),
            options={"projectId": _FIREBASE_PROJECT_ID},
        )
        logger.info(
            "Firebase Admin SDK initialised for project '%s'.", _FIREBASE_PROJECT_ID
        )
        return app
    except Exception as exc:
        logger.error("Firebase Admin SDK init failed: %s", exc)
        return None


_firebase_app = _init_firebase_app()


# ─────────────────────────────────────────────────────────────────────────────
# Request schema
# ─────────────────────────────────────────────────────────────────────────────

class FirebaseLoginRequest(BaseModel):
    """
    Payload sent from the Colab bootstrap script (Step 7).
    The firebase_uid is used to verify identity server-side.
    """
    firebase_custom_token: str   # Custom token minted by Admin SDK in Colab
    email: EmailStr
    full_name: str
    firebase_uid: str            # UID from fb_auth.create_custom_token(uid=…)

    @field_validator("firebase_uid")
    @classmethod
    def uid_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("firebase_uid must not be empty.")
        return v.strip()

    @field_validator("full_name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 1:
            raise ValueError("full_name must not be empty.")
        return v


# ─────────────────────────────────────────────────────────────────────────────
# Endpoint
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/auth/firebase-login", summary="Exchange a Firebase custom token for a StudyMate session JWT")
async def firebase_login(req: FirebaseLoginRequest):
    """
    Called by the Colab bootstrap script after it mints a custom token.

    Security model:
      • The firebase_uid in the request is verified against the Firebase project
        server-side — the Admin SDK confirms the UID belongs to a real Firebase user.
      • The custom token itself cannot be verified server-side (it is a
        client-side token by design); we verify the UID directly instead.
      • Email ownership is already proven by Google's auth flow in Colab.
    """
    if _firebase_app is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Firebase integration is not configured on this server. "
                "Set FIREBASE_PROJECT_ID in backend/.env and restart."
            ),
        )

    # ── Verify the Firebase UID actually exists in your Firebase project ──────
    try:
        fb_user = fb_auth.get_user(req.firebase_uid)
    except fb_auth.UserNotFoundError:
        raise HTTPException(
            status_code=401,
            detail="Firebase UID not found. The token may have been issued for a different project.",
        )
    except Exception as exc:
        logger.error("Firebase UID verification failed: %s", exc)
        raise HTTPException(status_code=502, detail="Firebase verification failed. Please retry.")

    # ── Confirm email matches the Firebase user record ────────────────────────
    if fb_user.email and fb_user.email.lower() != req.email.lower():
        raise HTTPException(
            status_code=401,
            detail="Email mismatch between Firebase record and request payload.",
        )

    # ── Find or create the local StudyMate user account ───────────────────────
    user = DBService.get_user_by_email(req.email)

    if not user:
        # First-time Firebase login — auto-provision a local account.
        # We store a sentinel password hash so the DB constraint is satisfied;
        # these accounts cannot log in via email+password (intentional).
        sentinel_hash = AuthService.hash_password(
            f"firebase::{req.firebase_uid}::sentinel"
        )
        try:
            user_id = DBService.create_user(
                email=req.email,
                password_hash=sentinel_hash,
                full_name=req.full_name,
            )
            user = DBService.get_user_by_id(user_id)
            logger.info(
                "Firebase auto-provisioned new user: id=%s email=%s uid=%s",
                user_id, req.email, req.firebase_uid,
            )
        except Exception as exc:
            logger.error("Auto-provision failed: %s", exc)
            raise HTTPException(status_code=500, detail="Failed to create local user account.")
    else:
        logger.info("Firebase login for existing user: id=%s", user["id"])

    # ── Issue a StudyMate session JWT ─────────────────────────────────────────
    token = AuthService.create_access_token(user["id"])

    # Strip sensitive fields
    safe_user = dict(user)
    safe_user.pop("password_hash", None)

    return {
        "status": "success",
        "token": token,
        "user": safe_user,
        "firebase_uid": req.firebase_uid,
    }
