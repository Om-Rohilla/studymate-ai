# ══════════════════════════════════════════════════════════════════════════════
# StudyMate AI — Dockerfile for AWS Elastic Beanstalk
#
# IMPORTANT: Run this BEFORE building Docker:
#   cd frontend && npm run build
#   cp -r frontend/dist/. backend/static/
#
# Then the Dockerfile just runs the Python backend which serves the pre-built frontend.
# ══════════════════════════════════════════════════════════════════════════════

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

# Copy the backend code + pre-built frontend (in backend/static/)
COPY backend/ ./backend/

# Ownership
RUN chown -R studymate:studymate /app

USER studymate

EXPOSE 8080

# Health check for EB/ALB
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080"]
