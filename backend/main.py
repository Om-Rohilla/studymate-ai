import logging
import time
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from dotenv import load_dotenv

# Load env variables first — auth_service reads JWT_SECRET at import time
load_dotenv()

# Initialise SQLite database (also creates documents table on first run)
from services.db_service import DBService
DBService.init_db()

# Ensure uploads directory exists
UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("StudyMate_API")

# ─────────────────────────────────────────────────────────────────────────────
# Rate Limiter (slowapi — attaches to the app state)
# ─────────────────────────────────────────────────────────────────────────────
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="StudyMate AI Companion Backend",
    description=(
        "Secure REST API for StudyMate AI. "
        "Handles email/password authentication, document upload & text extraction, "
        "AI tutoring with streaming, notes (short/detailed/exam), quizzes, "
        "flashcards, key points, and study planning."
    ),
    version="3.0.0",
)

# Attach the limiter to app state so slowapi can intercept 429s
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ─────────────────────────────────────────────────────────────────────────────
# CORS
# ─────────────────────────────────────────────────────────────────────────────
ENV = os.getenv("ENV", "development")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if ENV != "production" else [
        os.getenv("FRONTEND_URL", "*")
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
# Request / Response Logging Middleware
# ─────────────────────────────────────────────────────────────────────────────
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    logger.info("→ %s %s", request.method, request.url.path)
    try:
        response = await call_next(request)
        ms = (time.time() - start_time) * 1000
        logger.info(
            "← %s %s | %d | %.1fms",
            request.method, request.url.path, response.status_code, ms,
        )
        return response
    except Exception as exc:
        logger.error("✗ %s %s | Exception: %s", request.method, request.url.path, exc)
        raise


# ─────────────────────────────────────────────────────────────────────────────
# Routers — all mounted under /api prefix
# ─────────────────────────────────────────────────────────────────────────────
from routes import tutor, notes, quiz, flashcards, planner, auth, firebase_auth
from routes import documents, keypoints

app.include_router(auth.router,          prefix="/api", tags=["Authentication"])
app.include_router(firebase_auth.router, prefix="/api", tags=["Firebase Authentication"])
app.include_router(documents.router,     prefix="/api", tags=["Documents"])
app.include_router(tutor.router,         prefix="/api", tags=["AI Tutor"])
app.include_router(notes.router,         prefix="/api", tags=["Notes Generator"])
app.include_router(quiz.router,          prefix="/api", tags=["Quiz Generator"])
app.include_router(flashcards.router,    prefix="/api", tags=["Flashcards"])
app.include_router(keypoints.router,     prefix="/api", tags=["Key Points"])
app.include_router(planner.router,       prefix="/api", tags=["Study Planner"])


# ─────────────────────────────────────────────────────────────────────────────
# Health-check root
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/", tags=["Health"])
def read_root():
    """Serve the production frontend when it is bundled with the API."""
    index = Path(__file__).parent / "static" / "index.html"
    if index.exists():
        return FileResponse(index)
    return {
        "status": "online",
        "app": "StudyMate AI Backend",
        "version": "3.1.0",
        "features": [
            "JWT email/password auth",
            "Firebase Google auth",
            "Document upload & text extraction (PDF/DOCX/PPTX/TXT)",
            "Duplicate upload detection",
            "Text preprocessing & Unicode normalisation",
            "Document-grounded AI generation (gpt-4o)",
            "Multi-turn AI Tutor with SSE streaming",
            "Short / Detailed / Exam-focused notes + SSE streaming",
            "Multiple-choice quiz generation (with explanations)",
            "Flashcard generation (Q&A format)",
            "Key points & concepts extraction",
            "Study planner",
            "Retry logic with exponential backoff",
        ],
        "endpoints": [
            # Auth
            "POST /api/auth/register",
            "POST /api/auth/login     [rate-limited: 5/15min per IP]",
            "GET  /api/auth/me",
            "POST /api/auth/sync",
            "GET  /api/auth/sync",
            # Documents
            "POST   /api/documents/upload  [multipart, JWT required]",
            "GET    /api/documents          [JWT required]",
            "GET    /api/documents/{id}     [JWT required]",
            "DELETE /api/documents/{id}    [JWT required]",
            # AI Tutor
            "POST /api/tutor           [standard, supports history]",
            "POST /api/tutor/stream    [SSE streaming, supports history]",
            # Notes
            "POST /api/notes           [short | detailed | exam]",
            "POST /api/notes/stream    [SSE streaming]",
            # Generation
            "POST /api/quiz",
            "POST /api/flashcards",
            "POST /api/key-points",
            "POST /api/planner",
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Health Check (required by AWS App Runner / ALB)
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/health", tags=["Health"])
def health_check():
    return {"status": "healthy", "app": "StudyMate AI", "version": "3.1.0"}


# ─────────────────────────────────────────────────────────────────────────────
# Serve Vite Static Build (production only)
# API routes above take priority; this catches everything else
# ─────────────────────────────────────────────────────────────────────────────
STATIC_DIR = Path(__file__).parent / "static"

if STATIC_DIR.exists():
    # Mount assets (JS, CSS, images) at /assets
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets"), html=False), name="assets")

    # Serve each Vite multi-page entry point (for example /login.html) before
    # falling back to the landing page.  Previously every path returned
    # index.html, which made the login and feature URLs appear broken.
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        requested = (STATIC_DIR / full_path).resolve()
        try:
            requested.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return JSONResponse({"error": "Not found"}, status_code=404)

        if requested.is_file():
            return FileResponse(str(requested))

        index = STATIC_DIR / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return JSONResponse({"error": "Frontend not built. Run: npm run build"}, status_code=404)
else:
    logger.warning("Static frontend not found at %s. Running in API-only mode.", STATIC_DIR)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8080))
    host = os.getenv("HOST", "0.0.0.0")
    logger.info("Starting StudyMate AI on %s:%s", host, port)
    uvicorn.run("main:app", host=host, port=port, reload=(ENV != "production"))
