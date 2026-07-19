# StudyMate AI — Supabase Database Schema

This document details the Supabase database schema designed for **StudyMate AI**.

## Schema Diagram (Logical)

```
 [auth.users] (Supabase Built-in)
      │
      │ (1:1 cascade)
      ▼
 [public.profiles]
      │
      ├───(1:1 cascade)───► [public.user_sync]
      │
      └───(1:1m cascade)──► [public.documents]
```

---

## Tables

### 1. `profiles`
Holds additional user metadata linked directly to Supabase Auth.
* **id**: `uuid` (Primary Key, references `auth.users.id` on delete cascade)
* **email**: `text` (Not Null, Unique)
* **full_name**: `text` (Not Null)
* **created_at**: `timestamp with time zone` (Default: `timezone('utc'::text, now())`)

### 2. `user_sync`
Stores serialized user progress cached from localStorage.
* **user_id**: `uuid` (Primary Key, references `public.profiles.id` on delete cascade)
* **chats**: `text` (Nullable)
* **notes**: `text` (Nullable)
* **quiz_highscore**: `text` (Nullable)
* **cards**: `text` (Nullable)
* **planner_plan**: `text` (Nullable)
* **tickets**: `text` (Nullable)
* **updated_at**: `timestamp with time zone` (Default: `timezone('utc'::text, now())`)

### 3. `documents`
Stores metadata and parsed content of study materials.
* **id**: `uuid` (Primary Key, Default: `gen_random_uuid()`)
* **user_id**: `uuid` (Not Null, references `public.profiles.id` on delete cascade)
* **filename**: `text` (Not Null)
* **file_path**: `text` (Not Null)
* **file_type**: `text` (Not Null)
* **file_size**: `integer` (Not Null)
* **extracted_text**: `text` (Nullable)
* **created_at**: `timestamp with time zone` (Default: `timezone('utc'::text, now())`)

---

## Row-Level Security (RLS) Policies

### `profiles` Table
- Enable RLS: `ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;`
- SELECT Policy: `create policy "Allow owners to read their profile" on public.profiles for select using (auth.uid() = id);`
- UPDATE Policy: `create policy "Allow owners to update their profile" on public.profiles for update using (auth.uid() = id);`

### `user_sync` Table
- Enable RLS: `ALTER TABLE public.user_sync ENABLE ROW LEVEL SECURITY;`
- ALL Policy: `create policy "Allow owners to manage sync data" on public.user_sync for all using (auth.uid() = user_id);`

### `documents` Table
- Enable RLS: `ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;`
- ALL Policy: `create policy "Allow owners to manage documents" on public.documents for all using (auth.uid() = user_id);`

---

## Database Triggers & Functions

### Sync Profile Trigger
To automatically create a profile and sync record when a new user signs up:
```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', 'StudyMate User')
  );
  
  INSERT INTO public.user_sync (user_id)
  VALUES (new.id);

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```
