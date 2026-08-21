# StudyMate AI — AWS Deployment Guide

# Complete step-by-step guide to deploy on AWS App Runner

## Architecture Overview

```
Browser → AWS App Runner (port 8080)
             │
             ├── FastAPI serves static Vite frontend (HTML/CSS/JS)
             ├── /api/* routes → AI proxy, auth, notes, quiz, etc.
             └── /health → App Runner health check
                   │
                   ├── Supabase (PostgreSQL + Auth + Edge Functions)
                   ├── Groq API (LLaMA 3.3) — primary AI
                   └── Gemini API — fallback + vision
```

---

## Option A: Deploy via Docker Image (Recommended for Assessment)

This is the production deployment route for this repository. The Dockerfile
builds the frontend and FastAPI service together; do not use the legacy EC2
script for production.

### Prerequisites

- AWS Account (free tier)
- Docker installed locally
- AWS CLI installed: `pip install awscli`

### Step 1: Configure AWS CLI

```bash
aws configure
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output (json)
```

### Step 2: Create ECR Repository

```bash
aws ecr create-repository --repository-name studymate-ai --region us-east-1
# Note the repositoryUri from the output
```

### Step 3: Build & Push Docker Image

```bash
# Get your AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/studymate-ai"

# Login to ECR
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Build the image (pass Supabase vars at build time for Vite)
docker build \
  --build-arg VITE_SUPABASE_URL="https://rfeirfwtlmlyebfqmnen.supabase.co" \
  --build-arg VITE_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZWlyZnd0bG1seWViZnFtbmVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzODkzOTQsImV4cCI6MjA5OTk2NTM5NH0.Nj_0WL4x6xksgyfoJ4nnMoI3WsB-fef-uywVRDJ-Cdg" \
  -t studymate-ai:latest \
  -t "${ECR_URI}:latest" \
  .

# Push to ECR
docker push "${ECR_URI}:latest"
```

### Step 4: Create App Runner Service (AWS Console)

1. Go to: **AWS Console → App Runner → Create Service**
2. **Source:** Container registry → Amazon ECR
3. **Image URI:** `<your-ecr-uri>:latest`
4. **Deployment:** Automatic (deploys on new image push)
5. **Service settings:**
   - Service name: `studymate-ai`
   - CPU: 1 vCPU
   - Memory: 2 GB
   - Port: `8080`
6. **Environment variables** (add each one):
   ```
   GROQ_API_KEY          = gsk_your_groq_key
   GEMINI_API_KEY        = your_gemini_key
   OPENAI_API_KEY        = sk-your_openai_key
   SUPABASE_SERVICE_ROLE_KEY = your_service_role_key
   JWT_SECRET            = your_random_secret
   ENV                   = production
   PORT                  = 8080
   ```
7. **Health check path:** `/health`
8. Click **Create & Deploy** → wait ~3 minutes
9. App Runner provides a public HTTPS URL: `https://xxxx.us-east-1.awsapprunner.com`

---

## Option B: Deploy via App Runner from GitHub (Easiest)

1. Go to **AWS App Runner → Create Service**
2. **Source:** Source code repository → GitHub
3. Connect your GitHub account → select `Studymate-AI` repo
4. **Branch:** `main`
5. **Configuration:** Use configuration file → `apprunner.yaml`
6. Add environment variables (same as Step 4 above)
7. Deploy!

---

## Option C: Local Docker Test (Before AWS)

```bash
# 1. Copy env template
cp .env.example .env
# Edit .env with your actual API keys

# 2. Build and run locally
docker compose up --build

# 3. Open in browser
open http://localhost:8080
```

---

## Post-Deployment Checklist

- [ ] App is accessible via HTTPS URL
- [ ] Login / signup works
- [ ] AI Tutor responds
- [ ] Notes generation works
- [ ] Quiz generation works
- [ ] Flashcards generate
- [ ] Planner generates
- [ ] Dashboard stats load
- [ ] AWS Budget Alert configured ($5 threshold)

### Set Budget Alert

```bash
aws budgets create-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget '{
    "BudgetName": "StudyMate-Alert",
    "BudgetLimit": {"Amount": "5", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST"
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80
    },
    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "your-email@example.com"}]
  }]'
```

---

## Estimated AWS Costs (Free Tier)

| Service         | Free Tier                        | Estimated Use          |
| --------------- | -------------------------------- | ---------------------- |
| App Runner      | 2M req + 100 compute hours/month | < $1/month             |
| ECR             | 500 MB storage                   | Free                   |
| Data Transfer   | 15 GB outbound                   | Free                   |
| **Total** |                                  | **$0–$5/month** |

---

## Environment Variables Reference

| Variable                      | Required      | Where to Get                                                          |
| ----------------------------- | ------------- | --------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`         | ✅ Build-time | Supabase Dashboard → Settings → API                                 |
| `VITE_SUPABASE_ANON_KEY`    | ✅ Build-time | Supabase Dashboard → Settings → API                                 |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Runtime    | Supabase Dashboard → Settings → API                                 |
| `GROQ_API_KEY`              | ✅ Runtime    | console.groq.com → API Keys                                          |
| `GEMINI_API_KEY`            | ✅ Runtime    | aistudio.google.com → Get API Key                                    |
| `OPENAI_API_KEY`            | Optional      | platform.openai.com → API Keys                                       |
| `JWT_SECRET`                | ✅ Runtime    | Generate:`python -c "import secrets; print(secrets.token_hex(32))"` |
| `ENV`                       | Optional      | Set to`production`                                                  |
| `PORT`                      | Optional      | Default:`8080`                                                      |
