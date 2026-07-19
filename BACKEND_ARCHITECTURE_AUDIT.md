# StudyMate AI — Backend Architecture Audit (to Supabase)

This document contains a comprehensive analysis of the existing **StudyMate AI** codebase and outlines the requirements for migrating the backend services to **Supabase**.

---

## A. Application Architecture

* **Frontend Framework**: Static HTML/CSS/JS served via Vite (multi-page).
* **Programming Languages**: JavaScript (frontend) and Python (backend).
* **Routing**: Page-based navigation using individual static HTML files (`index.html`, `login.html`, `notes.html`, `flashcards.html`, `quiz.html`, `tutor.html`, `planner.html`, `about.html`, `contact.html`).
* **Rendering Approach**: Client-side rendering (CSR) with raw DOM manipulation.
* **State Management**: Browser `localStorage` acts as the primary client-side state cache, containing syncable keys:
  - `sm_chats` (Tutor chat history)
  - `sm_notes` (Saved study notes)
  - `sm_quiz_highscore` (Quiz performance)
  - `sm_cards` (Flashcard deck definitions and mastery states)
  - `sm_planner_plan` (Active study plan schedule)
  - `sm_tickets` (Support or revision tickets)
* **Current Backend**: Python FastAPI backend with JWT-based sessions and local SQLite database (`users.db`).
* **Current Authentication**: Local email/password account creation using `bcrypt` and HS256 JWT, alongside a Firebase Authentication Custom Token verification flow.
* **Current Data-Access Pattern**: Frontend queries FastAPI via the `fetch` API. FastAPI interacts with SQLite via raw SQL queries in `services/db_service.py`. Files are uploaded to local storage (`backend/uploads/`) and parsed using local Python libraries.
* **Deployment Assumptions**: The backend currently expects a persistent filesystem for local database storage (`users.db`) and uploaded files.

---

## B. Complete Feature Inventory

| Feature | Page/Component | User Action | Input | Output | Current Data Source | Required Supabase Resource | Auth Requirement | Authz Requirement | Realtime Requirement | Storage Requirement | External API Requirement |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Auth** | `login.html` | Sign Up / Sign In | Email, Password, Full Name | Session JWT + User metadata | SQLite (`users` table) | Supabase Auth (Sign-in / Sign-up) | None (Public) | None | No | No | No |
| **Cloud Sync** | `auth-helper.js` | Auto/Manual sync | JSON payload of local progress | Sync confirmation | SQLite (`user_sync` table) | Supabase DB (`user_sync` table) | JWT Token | Owning user (`auth.uid() = user_id`) | No | No | No |
| **Restore Progress** | `login.html` | Auto-login | JWT Token | JSON payload of saved progress | SQLite (`user_sync` table) | Supabase DB (`user_sync` table) | JWT Token | Owning user (`auth.uid() = user_id`) | No | No | No |
| **AI Tutor Chat** | `tutor.html` | Send Message (Topic/Doc) | Message text, Subject, Persona, Doc ID, History | SSE Text stream | Local FastAPI (LLM Service) | FastAPI Proxy / Edge Function | JWT (if document-aware) | None (topic) / Owning user (document) | Yes (Streaming) | No | OpenAI/Gemini/Groq |
| **Notes Generator** | `notes.html` | Generate Notes | Topic/Doc ID, Subject, Style, Length, Summary Type | HTML formatted study notes | Local FastAPI (LLM Service) | FastAPI Proxy / Edge Function | JWT (if document-aware) | None (topic) / Owning user (document) | Yes (Streaming) | No | OpenAI/Gemini/Groq |
| **Quiz Generator** | `quiz.html` | Generate Quiz | Topic/Doc ID, Question count, Difficulty, Subject | JSON array of quiz questions | Local FastAPI (LLM Service) | FastAPI Proxy / Edge Function | JWT (if document-aware) | None (topic) / Owning user (document) | No | No | OpenAI/Gemini/Groq |
| **Flashcard Generator** | `flashcards.html` | Generate Cards | Topic/Doc ID, Count, Mode | JSON array of term/def cards | Local FastAPI (LLM Service) | FastAPI Proxy / Edge Function | JWT (if document-aware) | None (topic) / Owning user (document) | No | No | OpenAI/Gemini/Groq |
| **Key Points Extractor** | `notes.html` / `quiz.html` | Get Concepts / Key Points | Topic/Doc ID, Subject | JSON list of key points and concepts | Local FastAPI (LLM Service) | FastAPI Proxy / Edge Function | JWT (if document-aware) | None (topic) / Owning user (document) | No | No | OpenAI/Gemini/Groq |
| **Planner Generator** | `planner.html` | Generate Plan | Subjects, Date, Hours, Strategy | JSON daily schedule | Local FastAPI (LLM Service) | FastAPI Proxy / Edge Function | None | None | No | No | OpenAI/Gemini/Groq |
| **Document Upload** | Multi-page sidebar | Drag/Drop or Select file | File object (PDF, DOCX, PPTX, TXT) | `{document_id, filename, file_type, file_size}` | Local disk + SQLite metadata | Supabase Storage (`documents` bucket) + Supabase DB (`documents` table) | JWT Token | Owning user (`auth.uid() = user_id`) | No | Yes (`documents` bucket) | No |
| **Document Management** | Multi-page sidebar | List / Delete | Document ID | List of metadata / Success message | SQLite (`documents` table) | Supabase DB (`documents` table) + Supabase Storage | JWT Token | Owning user (`auth.uid() = user_id`) | No | Yes | No |

---

## C. Current Data-Flow Map

### 1. Document Upload Flow
```
User Interface (tutor.html/notes.html dropzone)
  → Select file & trigger handleFileSelection()
  → Validate size & extension on client
  → POST multipart/form-data to FastAPI /api/documents/upload with Bearer JWT
  → FastAPI get_current_user_id() extracts & validates JWT
  → Save file to local directory `backend/uploads/<user_id>/<doc_id>_<filename>`
  → Insert metadata row in SQLite `documents` table
  → Run text extractor in a thread pool (PyMuPDF/python-docx/python-pptx/text read)
  → Update `extracted_text` column in SQLite
  → Return document_id to frontend
  → Frontend state updates: set activeDocumentId, update UI chips
```

### 2. Document-Grounded AI Generation Flow (e.g., Notes)
```
User Interface (notes.html generate form)
  → Trigger form submit
  → Get activeDocumentId, topic, style, length, summary_type
  → POST to FastAPI /api/notes with Bearer JWT
  → FastAPI check: if document_id present, require auth & fetch extracted_text from DB
  → FastAPI truncates text to ~8,000 tokens for context
  → Build system prompt and call OpenAI/Gemini/Groq API (stream or synchronous)
  → Return response as SSE chunks (data: JSON) or JSON response
  → Frontend notesViewport parses response and updates innerHTML
  → User clicks Save: notes object pushed to localStorage `sm_notes`
```

---

## D. Backend Requirements

### 1. Database Tables

* **`profiles`**: Stores user profiles synced from Supabase Auth metadata.
  - Columns: `id` (uuid, primary key), `email` (text), `full_name` (text), `created_at` (timestamp).
  - RLS: Select and update restricted to owner (`auth.uid() = id`).
* **`user_sync`**: Stores user-persistent localStorage data (cloud backups).
  - Columns: `user_id` (uuid, primary key), `chats` (text), `notes` (text), `quiz_highscore` (text), `cards` (text), `planner_plan` (text), `tickets` (text), `updated_at` (timestamp).
  - RLS: Select, insert, update restricted to owner (`auth.uid() = user_id`).
* **`documents`**: Stores uploaded document metadata and extracted text.
  - Columns: `id` (uuid, primary key), `user_id` (uuid, references profiles.id), `filename` (text), `file_path` (text), `file_type` (text), `file_size` (int), `extracted_text` (text), `created_at` (timestamp).
  - RLS: All operations restricted to owner (`auth.uid() = user_id`).

### 2. Storage Buckets

* **`documents`** (Private):
  - Path: `uploads/{user_id}/{document_id}_{filename}`.
  - Policies: Allow authenticated users to perform SELECT, INSERT, UPDATE, DELETE only within their own folder `uploads/{auth.uid()}/`.

### 3. Edge Functions / Server-Side APIs
* To keep OpenAI/Gemini/Groq keys secure, the AI text generation and file text extraction must run server-side.
* Since FastAPI is already built, robust, and handles text parsing libraries (like `fitz`, `python-docx`, `python-pptx`), we will run FastAPI as the server-side API layer. It will use the Supabase Python SDK to interact with Supabase DB and Storage.

---

## E. Security Risks Identified in the Current Setup

1. **Local File Storage**: Files saved locally are volatile and prone to data loss on container restarts.
2. **SQLite Database**: Relies on a local database with no multi-node scaling or row-level constraints.
3. **CORS Policy**: Currently configured to allow all origins (`allow_origins=["*"]`) which poses a security risk for production.
4. **JWT Verification**: The current backend does not integrate with any external auth identity manager (e.g. Supabase), making auth siloed.
5. **No Database RLS**: SQLite has no native Row-Level Security, leaving data safety dependent entirely on application logic.

---

## F. Proposed Migration Order

1. **Database Schema & Policies**: Execute database migrations (tables, triggers, RLS, storage policies) in Supabase.
2. **Environment Setup**: Add Supabase environment variables to `backend/.env` and create `frontend/.env` variables.
3. **Dependencies**: Add `supabase` and `pyjwt` to `backend/requirements.txt` and install them.
4. **Backend Database Client**: Port `backend/services/db_service.py` from SQLite to Supabase Python SDK.
5. **Backend Authentication**: Update `backend/services/auth_service.py` to verify Supabase JWT tokens.
6. **Backend Storage**: Port `backend/services/document_service.py` to upload, fetch, and delete files in the private Supabase Storage `documents` bucket.
7. **Frontend Auth & Sync**: Port `frontend/auth-helper.js` and `frontend/login.html` to communicate with Supabase Auth and save session tokens.
8. **Testing & Validation**: Verify file uploads, AI generation, and RLS integrity.
9. **Code Cleanup**: Remove `users.db`, local uploads, and old auth files.
