#!/bin/bash
# StudyMate AI — EC2 Auto-Setup Script
# Paste this entire script into EC2 "User data" when launching

exec > /var/log/studymate-setup.log 2>&1
set -e

apt-get update -y
apt-get install -y git curl nginx python3-pip python3-venv python3-dev build-essential libglib2.0-0

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

git clone https://github.com/shireendevgunn/Studymate-AI.git /opt/studymate
cd /opt/studymate

cat > /opt/studymate/frontend/.env << 'EOF'
VITE_SUPABASE_URL=https://rfeirfwtlmlyebfqmnen.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZWlyZnd0bG1seWViZnFtbmVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzODkzOTQsImV4cCI6MjA5OTk2NTM5NH0.Nj_0WL4x6xksgyfoJ4nnMoI3WsB-fef-uywVRDJ-Cdg
EOF

cd /opt/studymate/frontend
npm ci --no-audit
npm run build
mkdir -p /opt/studymate/backend/static
cp -r /opt/studymate/frontend/dist/. /opt/studymate/backend/static/

cd /opt/studymate/backend
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
deactivate

cat > /opt/studymate/backend/.env.prod << 'EOF'
GEMINI_API_KEY=AQ.Ab8RN6IXGkc-psiILR9x_CG19K0FEq2cUArir4wer_XgrTj3ZA
JWT_SECRET=PtMj3+YbFoIeiWXI8DgYjB55Z0SscjpBJkaz3K5ntyKcyWrQz77bvDy4l2qAglxZhMJyWfq/On+eO0MxjmIFJw==
ENV=production
PORT=8080
EOF

cat > /etc/systemd/system/studymate.service << 'EOF'
[Unit]
Description=StudyMate AI
After=network.target
[Service]
User=root
WorkingDirectory=/opt/studymate/backend
EnvironmentFile=/opt/studymate/backend/.env.prod
ExecStart=/opt/studymate/backend/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8080
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/nginx/sites-available/studymate << 'EOF'
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 20M;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/studymate /etc/nginx/sites-enabled/studymate

systemctl daemon-reload
systemctl enable studymate
systemctl start studymate
systemctl restart nginx
echo "StudyMate AI is LIVE on port 80!"
