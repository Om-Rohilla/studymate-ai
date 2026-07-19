import sqlite3
import os
import logging

DATABASE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "users.db")
logger = logging.getLogger("StudyMate_API.db_service")


class DBService:
    # ─────────────────────────────────────────────────────────────────────────
    # Connection
    # ─────────────────────────────────────────────────────────────────────────
    @staticmethod
    def get_connection() -> sqlite3.Connection:
        conn = sqlite3.connect(DATABASE_PATH)
        conn.row_factory = sqlite3.Row
        # Enable foreign-key enforcement
        conn.execute("PRAGMA foreign_keys = ON;")
        return conn

    # ─────────────────────────────────────────────────────────────────────────
    # Schema Initialisation
    # ─────────────────────────────────────────────────────────────────────────
    @classmethod
    def init_db(cls) -> None:
        logger.info(f"Initialising database at: {DATABASE_PATH}")
        with cls.get_connection() as conn:
            cursor = conn.cursor()

            # Users — email/password only; no oauth_provider column in new DBs.
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id            INTEGER  PRIMARY KEY AUTOINCREMENT,
                    email         TEXT     UNIQUE NOT NULL COLLATE NOCASE,
                    password_hash TEXT     NOT NULL,
                    full_name     TEXT     NOT NULL,
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Per-user progress sync (cloud backup of localStorage data)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_sync (
                    user_id       INTEGER  PRIMARY KEY,
                    chats         TEXT,
                    notes         TEXT,
                    quiz_highscore TEXT,
                    cards         TEXT,
                    planner_plan  TEXT,
                    tickets       TEXT,
                    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                )
            """)

            # Uploaded study documents (PDF, DOCX, PPTX, TXT)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    id             TEXT     PRIMARY KEY,
                    user_id        INTEGER  NOT NULL,
                    filename       TEXT     NOT NULL,
                    file_path      TEXT     NOT NULL,
                    file_type      TEXT     NOT NULL,
                    file_size      INTEGER  NOT NULL,
                    extracted_text TEXT,
                    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                )
            """)

            conn.commit()
        logger.info("Database initialised successfully.")


    # ─────────────────────────────────────────────────────────────────────────
    # User CRUD
    # ─────────────────────────────────────────────────────────────────────────
    @classmethod
    def get_user_by_email(cls, email: str) -> dict | None:
        with cls.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE email = ?",
                (email.lower().strip(),),
            ).fetchone()
            return dict(row) if row else None

    @classmethod
    def get_user_by_id(cls, user_id: int) -> dict | None:
        with cls.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
            return dict(row) if row else None

    @classmethod
    def create_user(cls, email: str, password_hash: str, full_name: str) -> int:
        """
        Insert a new user and an empty sync row.
        Returns the new user's primary-key id.
        oauth_provider is intentionally not accepted — email/password only.
        """
        email_clean = email.lower().strip()
        with cls.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)",
                (email_clean, password_hash, full_name),
            )
            user_id: int = cursor.lastrowid
            # Initialise an empty sync row
            cursor.execute(
                "INSERT INTO user_sync (user_id) VALUES (?)",
                (user_id,),
            )
            conn.commit()
        return user_id

    # ─────────────────────────────────────────────────────────────────────────
    # Progress Sync
    # ─────────────────────────────────────────────────────────────────────────
    @classmethod
    def get_user_sync(cls, user_id: int) -> dict | None:
        with cls.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM user_sync WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if row:
                d = dict(row)
                d.pop("user_id", None)
                d.pop("updated_at", None)
                return d
            return None

    @classmethod
    def update_user_sync(cls, user_id: int, sync_data: dict) -> bool:
        ALLOWED_FIELDS = {"chats", "notes", "quiz_highscore", "cards", "planner_plan", "tickets"}
        fields, values = [], []
        for key, val in sync_data.items():
            if key in ALLOWED_FIELDS:
                fields.append(f"{key} = ?")
                values.append(val)

        if not fields:
            return False

        values.append(user_id)
        query = (
            f"UPDATE user_sync SET {', '.join(fields)}, "
            f"updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"
        )
        with cls.get_connection() as conn:
            conn.execute(query, tuple(values))
            conn.commit()
        return True

    # ─────────────────────────────────────────────────────────────────────────
    # Document CRUD
    # ─────────────────────────────────────────────────────────────────────────
    @classmethod
    def create_document(
        cls,
        doc_id: str,
        user_id: int,
        filename: str,
        file_path: str,
        file_type: str,
        file_size: int,
    ) -> bool:
        """Insert a new document record. Returns True on success."""
        try:
            with cls.get_connection() as conn:
                conn.execute(
                    """INSERT INTO documents
                       (id, user_id, filename, file_path, file_type, file_size)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (doc_id, user_id, filename, file_path, file_type, file_size),
                )
                conn.commit()
            return True
        except Exception as exc:
            logger.error("create_document failed: %s", exc)
            return False

    @classmethod
    def get_document(cls, doc_id: str, user_id: int | None = None) -> dict | None:
        """Fetch a single document. If user_id provided, also assert ownership."""
        with cls.get_connection() as conn:
            if user_id is not None:
                row = conn.execute(
                    "SELECT * FROM documents WHERE id = ? AND user_id = ?",
                    (doc_id, user_id),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT * FROM documents WHERE id = ?",
                    (doc_id,),
                ).fetchone()
            return dict(row) if row else None

    @classmethod
    def list_documents(cls, user_id: int) -> list[dict]:
        """Return all documents for a user, newest first."""
        with cls.get_connection() as conn:
            rows = conn.execute(
                """SELECT id, user_id, filename, file_type, file_size,
                          (extracted_text IS NOT NULL) AS has_text, created_at
                   FROM documents WHERE user_id = ?
                   ORDER BY created_at DESC""",
                (user_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    @classmethod
    def update_document_text(cls, doc_id: str, text: str) -> bool:
        """Store the extracted text for a document."""
        try:
            with cls.get_connection() as conn:
                conn.execute(
                    "UPDATE documents SET extracted_text = ? WHERE id = ?",
                    (text, doc_id),
                )
                conn.commit()
            return True
        except Exception as exc:
            logger.error("update_document_text failed: %s", exc)
            return False

    @classmethod
    def delete_document(cls, doc_id: str, user_id: int) -> bool:
        """Delete a document owned by the user. Returns True if a row was deleted."""
        try:
            with cls.get_connection() as conn:
                cursor = conn.execute(
                    "DELETE FROM documents WHERE id = ? AND user_id = ?",
                    (doc_id, user_id),
                )
                conn.commit()
            return cursor.rowcount > 0
        except Exception as exc:
            logger.error("delete_document failed: %s", exc)
            return False

