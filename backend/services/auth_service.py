import os
import sys
import jwt
import bcrypt
import datetime
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Secure Secret Key Loading
# The application refuses to start if JWT_SECRET is missing or uses the known
# insecure default value.
# ─────────────────────────────────────────────────────────────────────────────
_INSECURE_DEFAULTS = {
    "studymate_super_secret_key_123456",
    "your-secret-key",
    "secret",
    "changeme",
    "",
}

SECRET_KEY = os.getenv("JWT_SECRET", "")

if SECRET_KEY in _INSECURE_DEFAULTS:
    print(
        "\n\033[91m[FATAL] JWT_SECRET is missing or uses an insecure default value.\n"
        "Generate a secure key and add it to backend/.env:\n\n"
        "  python -c \"import secrets; print(secrets.token_hex(48))\"\n\n"
        "Then set:  JWT_SECRET=<your-generated-key>\033[0m\n",
        file=sys.stderr,
    )
    sys.exit(1)

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7


class AuthService:
    # ─────────────────────────────────────────────────────────────────────────
    # Password Hashing (bcrypt, cost factor 12)
    # ─────────────────────────────────────────────────────────────────────────
    @staticmethod
    def hash_password(password: str) -> str:
        """Hash a plaintext password using bcrypt (cost=12)."""
        if not password:
            raise ValueError("Password must not be empty.")
        pwd_bytes = password.encode("utf-8")
        salt = bcrypt.gensalt(rounds=12)
        hashed = bcrypt.hashpw(pwd_bytes, salt)
        return hashed.decode("utf-8")

    @staticmethod
    def verify_password(password: str, hashed_password: str) -> bool:
        """Constant-time compare a plaintext password against its stored hash."""
        if not password or not hashed_password:
            return False
        try:
            return bcrypt.checkpw(
                password.encode("utf-8"),
                hashed_password.encode("utf-8"),
            )
        except Exception:
            return False

    # ─────────────────────────────────────────────────────────────────────────
    # JWT Token Management
    # ─────────────────────────────────────────────────────────────────────────
    @staticmethod
    def create_access_token(
        user_id: int,
        expires_delta: Optional[datetime.timedelta] = None,
    ) -> str:
        """Issue a signed JWT access token for the given user ID."""
        now = datetime.datetime.now(datetime.timezone.utc)
        expire = now + (
            expires_delta
            if expires_delta
            else datetime.timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
        )
        payload = {
            "sub": str(user_id),
            "iat": now,
            "exp": expire,
        }
        return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

    @staticmethod
    def decode_access_token(token: str) -> Optional[int]:
        """
        Decode and validate a JWT.  Returns the user_id (int) on success,
        or None if the token is invalid, expired, or tampered with.
        Only HS256 is accepted — algorithm confusion attacks are blocked.
        """
        try:
            if token.startswith("Bearer "):
                token = token[7:]
            payload = jwt.decode(
                token,
                SECRET_KEY,
                algorithms=[ALGORITHM],  # whitelist — rejects RS256/none etc.
            )
            user_id_str = payload.get("sub")
            if user_id_str is None:
                return None
            return int(user_id_str)
        except jwt.ExpiredSignatureError:
            return None
        except jwt.InvalidTokenError:
            return None
        except (ValueError, TypeError):
            return None
