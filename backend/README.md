# StudyMate AI — Backend

A secure, production-ready FastAPI backend for the StudyMate AI study companion.

---

## Quick Start

```bash
# 1. Activate the virtual environment
cd backend
.\venv\Scripts\activate          # Windows PowerShell
# source venv/bin/activate       # macOS / Linux

# 2. Install dependencies (first time only)
pip install -r requirements.txt

# 3. Configure environment variables
copy .env.example .env
# → Edit .env and fill in at least OPENAI_API_KEY and JWT_SECRET

# 4. Start the development server
python main.py
# or:
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The interactive API docs are then available at **http://127.0.0.1:8000/docs**

---

## Environment Variables

Edit `backend/.env` before starting the server.

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ one of these | OpenAI GPT API key |
| `GROQ_API_KEY` | ✅ one of these | Groq API key (priority over OpenAI) |
| `GEMINI_API_KEY` | ✅ one of these | Google Gemini API key |
| `JWT_SECRET` | ✅ always | Secret for signing JWTs (generate with `python -c "import secrets; print(secrets.token_hex(48))"`) |
| `FIREBASE_PROJECT_ID` | Optional | Required only for Firebase Google SSO |
| `PORT` | Optional | Server port (default: 8000) |
| `HOST` | Optional | Server host (default: 127.0.0.1) |

**LLM priority:** Groq → OpenAI → Gemini. At least one must be configured for AI features to work.

---

## Architecture

```
backend/
├── main.py               # FastAPI app, middleware, router registration
├── requirements.txt      # Python dependencies
├── .env                  # Secret config (NOT committed to git)
├── .env.example          # Template for .env
├── users.db              # SQLite database (auto-created)
├── uploads/              # Uploaded study documents (per-user subdirs)
│
├── models/
│   └── schemas.py        # Pydantic request/response models
│
├── services/
│   ├── auth_service.py   # JWT creation/verification, bcrypt password hashing
│   ├── db_service.py     # SQLite CRUD (users, documents, sync)
│   ├── document_service.py  # Upload pipeline, text extraction, preprocessing
│   └── llm_service.py    # OpenAI/Groq/Gemini client, all AI generation methods
│
└── routes/
    ├── _helpers.py       # Shared: resolve_document_context()
    ├── auth.py           # Email/password auth + progress sync
    ├── firebase_auth.py  # Firebase Google SSO
    ├── documents.py      # Upload, list, detail, delete
    ├── tutor.py          # AI Tutor (standard + SSE streaming)
    ├── notes.py          # Notes generator (standard + SSE streaming)
    ├── quiz.py           # Quiz generator
    ├── flashcards.py     # Flashcard generator
    ├── keypoints.py      # Key points & concepts
    └── planner.py        # Study planner
```

---

## API Reference

All AI endpoints accept an optional `document_id` field. When supplied, the AI
grounds its response in the uploaded study document instead of (or in addition to)
any topic text. A valid `Authorization: Bearer <token>` header is required when
using `document_id`.

### Authentication

#### `POST /api/auth/register`
```json
{
  "email": "student@example.com",
  "password": "Secure123",
  "full_name": "Jane Smith"
}
```
**Response:** `{ "status": "success", "token": "<jwt>", "user": { ... } }`

#### `POST /api/auth/login` *(rate-limited: 5/15 min per IP)*
```json
{ "email": "student@example.com", "password": "Secure123" }
```

#### `GET /api/auth/me`
*Headers:* `Authorization: Bearer <token>`
Returns the authenticated user's profile (no password hash).

#### `POST /api/auth/sync` / `GET /api/auth/sync`
Cloud backup/restore of local study progress (chats, notes, quiz scores, etc.)

---

### Document Upload

#### `POST /api/documents/upload`
*Headers:* `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`

Upload a study material file. Returns a `document_id` to use with AI endpoints.

**Supported formats:** `.pdf`, `.docx`, `.doc`, `.pptx`, `.ppt`, `.txt`
**Max file size:** 20 MB

**Response:**
```json
{
  "status": "success",
  "document_id": "uuid-string",
  "filename": "chapter3.pdf",
  "file_type": ".pdf",
  "file_size": 142000,
  "message": "Document uploaded and processed successfully. Use document_id '...' in AI generation requests."
}
```

> **Duplicate detection:** Re-uploading the same file (same name + size) returns the
> existing `document_id` instead of creating a duplicate.

#### `GET /api/documents`
List all documents uploaded by the authenticated user.

#### `GET /api/documents/{document_id}`
Get document metadata + first 500 characters of extracted text.

#### `DELETE /api/documents/{document_id}`
Permanently delete a document (file + database record).

---

### AI Tutor

#### `POST /api/tutor` — Standard
```json
{
  "query": "Explain Newton's second law of motion",
  "subject": "Physics",
  "persona": "beginner",
  "document_id": "optional-uuid",
  "history": [
    { "role": "user", "content": "What is a force?" },
    { "role": "assistant", "content": "A force is a push or pull..." }
  ]
}
```

**Personas:** `beginner` | `exam_coach` | `professor` | `friendly_mentor`

**Response:** `{ "status": "success", "response": "<answer text>" }`

#### `POST /api/tutor/stream` — SSE Streaming
Same request body as `/api/tutor`. Returns a `text/event-stream` response.

Each chunk:
```
data: "partial text fragment"

data: [DONE]
```

**Multi-turn conversations:** Pass the conversation `history` array with each
request. The frontend maintains history; the backend is stateless.

---

### Notes Generator

#### `POST /api/notes` — Standard
```json
{
  "topic": "Photosynthesis",
  "subject": "Biology",
  "style": "structured",
  "length": "medium",
  "summary_type": "detailed",
  "document_id": "optional-uuid"
}
```

**summary_type options:**
| Value | Description |
|---|---|
| `"short"` | 3–5 sentence concise summary |
| `"detailed"` | Full structured study notes (default) |
| `"exam"` | Exam-focused bullet points, key facts, practice tips |

**Response:** `{ "status": "success", "notes": "<html content>" }`

#### `POST /api/notes/stream` — SSE Streaming
Same body. Streams HTML content incrementally via SSE.

---

### Quiz Generator

#### `POST /api/quiz`
```json
{
  "topic": "World War II",
  "subject": "History",
  "count": 5,
  "difficulty": "medium",
  "document_id": "optional-uuid"
}
```

**Response:**
```json
{
  "status": "success",
  "questions": [
    {
      "question": "Which year did WWII end?",
      "options": ["1943", "1944", "1945", "1946"],
      "correctIndex": 2,
      "explanation": "WWII ended in 1945 with the surrender of Germany in May and Japan in September."
    }
  ]
}
```

---

### Flashcards

#### `POST /api/flashcards`
```json
{
  "topic": "Python Programming",
  "count": 10,
  "mode": "term-definition",
  "document_id": "optional-uuid"
}
```

**Response:**
```json
{
  "status": "success",
  "cards": [
    { "front": "What is a list comprehension?", "back": "A compact way to create lists..." }
  ]
}
```

---

### Key Points & Concepts

#### `POST /api/key-points`
```json
{
  "topic": "Machine Learning",
  "subject": "Computer Science",
  "document_id": "optional-uuid"
}
```

**Response:**
```json
{
  "status": "success",
  "key_points": ["Supervised learning requires labelled data.", "..."],
  "concepts": [
    { "term": "Overfitting", "definition": "When a model performs well on training data but poorly on new data." }
  ]
}
```

---

### Study Planner

#### `POST /api/planner`
```json
{
  "subjects": "Mathematics, Physics, Chemistry",
  "date": "2026-12-15",
  "hours": 4,
  "strategy": "balanced"
}
```

**strategy options:** `balanced` | `paced` | `cram`

---

## Security

- **JWT authentication** — HS256, 7-day expiry, mandatory strong secret
- **bcrypt password hashing** — cost factor 12
- **Rate limiting** — `/api/auth/login` capped at 5 requests / 15 min per IP
- **API keys via environment variables** — never hard-coded
- **Document ownership** — users can only access their own documents
- **File validation** — extension whitelist + 20 MB size cap
- **Input validation** — Pydantic models validate all request fields

---

## Document Processing Pipeline

```
Upload → Validate (ext + size) → Duplicate check → Save to disk
  → Extract text (PyMuPDF / python-docx / python-pptx / built-in)
  → Preprocess (Unicode NFC, strip control chars, collapse whitespace)
  → Store in SQLite
  → Return document_id

AI request with document_id →  Fetch text from DB
  → Keyword-relevance chunking (for large documents)
  → Inject into LLM prompt as "UPLOADED STUDY MATERIAL"
  → Stream / return AI response
```

---

## LLM Configuration

| Provider | Model | Notes |
|---|---|---|
| Groq | `llama-3.3-70b-versatile` | Fastest, free tier available |
| OpenAI | `gpt-4o` | Best quality |
| Gemini | `gemini-1.5-flash` | Google's offering |

All AI calls use:
- **Retry logic** — up to 3 attempts with exponential backoff (via `tenacity`)
- **Context window** — up to 32,000 characters of document text (~10,500 tokens)
- **Fallback mode** — deterministic mock responses when no API key is set

---

## Running in Production

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```

Recommended: put behind nginx with SSL termination.
