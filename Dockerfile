# ══════════════════════════════════════════════════════════════════════════════
# StudyMate AI — production container for Amazon ECR / AWS App Runner
#
# The frontend is built inside the image so the deployed artifact always matches
# the committed source. Its public Supabase browser configuration lives in
# frontend/.env.production; server-side secrets are never baked into the image.
# ══════════════════════════════════════════════════════════════════════════════

FROM node:20-bookworm-slim AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit

COPY frontend/ ./

RUN npm run build

FROM python:3.12-slim

# Security: non-root user
RUN groupadd -r studymate && useradd -r -g studymate studymate

WORKDIR /app

# Install system deps for PyMuPDF
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Copy the backend code and the frontend built above.
COPY backend/ ./backend/
COPY --from=frontend-build /app/frontend/dist/ ./backend/static/

# Set working directory to INSIDE backend so 'from routes import x' works
WORKDIR /app/backend

# Ownership
RUN chown -R studymate:studymate /app

USER studymate

EXPOSE 8080

# Health check for EB/ALB
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run from /app/backend — so relative imports like 'from routes import tutor' work
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
