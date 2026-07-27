# ══════════════════════════════════════════════════════════════════════════════
# StudyMate AI — Multi-stage Dockerfile for AWS Deployment
#
# Stage 1 (builder): Node.js — builds Vite frontend into static files
# Stage 2 (runtime): Python 3.12 slim — runs FastAPI + serves static frontend
#
# Result: Single container that serves the full-stack app on port 8080
# ══════════════════════════════════════════════════════════════════════════════

# ─── Stage 1: Build the Vite Frontend ─────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend

# Copy package files first (Docker cache optimization)
COPY frontend/package*.json ./

# Install all node modules
RUN npm ci --no-audit --no-fund

# Copy frontend source
COPY frontend/ ./

# Build static assets (output goes to /app/frontend/dist)
# VITE env vars must be passed at BUILD time
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build

# ─── Stage 2: Python FastAPI Runtime ──────────────────────────────────────────
FROM python:3.12-slim AS runtime

# Security: run as non-root user
RUN groupadd -r studymate && useradd -r -g studymate studymate

WORKDIR /app

# System deps for PyMuPDF (PDF text extraction)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmupdf-dev \
    libfreetype6 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps (cached if requirements.txt unchanged)
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Copy the backend application
COPY backend/ ./backend/

# Copy built frontend static files into backend's static folder
COPY --from=frontend-builder /app/frontend/dist ./backend/static/

# Set ownership
RUN chown -R studymate:studymate /app

# Switch to non-root
USER studymate

# Port (AWS App Runner default: 8080)
EXPOSE 8080

# Health check — App Runner polls this
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start FastAPI with uvicorn
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
