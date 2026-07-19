# StudyMate AI — Supabase Setup Instructions

This document provides setup instructions for deploying the **StudyMate AI** backend database, storage, and server configurations to **Supabase**.

---

## 1. Required Environment Variables

### Frontend (`frontend/.env`)
These variables are public and safely embedded by Vite at build time.
* **`VITE_SUPABASE_URL`**: Your Supabase Project API URL (e.g. `https://xyz.supabase.co`). Found in settings > API.
* **`VITE_SUPABASE_ANON_KEY`**: Your Supabase Anon Public API Key. Found in settings > API.

### Backend (`backend/.env`)
These variables are kept private on the server side and never sent to the browser.
* **`SUPABASE_URL`**: Same as `VITE_SUPABASE_URL`.
* **`SUPABASE_ANON_KEY`**: Same as `VITE_SUPABASE_ANON_KEY`.
* **`SUPABASE_JWT_SECRET`**: The secret token signature string used to verify incoming user JWT tokens. Found in settings > API > JWT Settings.
* **`SUPABASE_SERVICE_ROLE_KEY`**: The elevated-privilege secret service role key (bypasses RLS for secure server parsing/updating). Found in settings > API.
* **`OPENAI_API_KEY`** (or `GROQ_API_KEY` / `GEMINI_API_KEY`): Secret key for GenAI generation.

---

## 2. Supabase Storage Configuration

A private storage bucket named **`documents`** is required to store study materials.
* Create the bucket via the Supabase Dashboard > **Storage** > **New Bucket** (Select **Private**).
* Set name to `documents`.

### Storage Security Policies (RLS)
Add the following policies in Dashboard > Storage > Policies:

1. **Allow owners to insert files**:
   - Operations: `INSERT`
   - Allowed roles: `authenticated`
   - Condition: `(auth.uid() = (storage.foldername(name))[1]::uuid)`
2. **Allow owners to select files**:
   - Operations: `SELECT`
   - Allowed roles: `authenticated`
   - Condition: `(auth.uid() = (storage.foldername(name))[1]::uuid)`
3. **Allow owners to delete files**:
   - Operations: `DELETE`
   - Allowed roles: `authenticated`
   - Condition: `(auth.uid() = (storage.foldername(name))[1]::uuid)`

---

## 3. Google OAuth Redirect Setup
To enable Google Login on the frontend:
1. Go to Supabase Dashboard > **Authentication** > **Providers** > **Google**.
2. Enable the Google provider.
3. Configure the **Client ID** and **Client Secret** obtained from Google Cloud Console.
4. Set the **Redirect URL** under Auth Settings in the Supabase Dashboard to:
   - Development: `http://localhost:5173` (or the local Vite server URL).
   - Production: your live frontend URL.
