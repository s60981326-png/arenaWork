#!/usr/bin/env bash
# ZENITH — one-time setup for Linux/macOS/Git Bash.
set -e
cd "$(dirname "$0")"
node --version >/dev/null 2>&1 || {
  echo "Node.js is not installed or not on PATH."
  echo "Install Node 22.5+ from https://nodejs.org and try again."
  exit 1
}
node -e "const v=process.version.slice(1).split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<5)){console.error('Node.js >= 22.5 required (found '+process.version+')');process.exit(1)}"
echo "Installing dependencies..."
npm install
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "Created .env from .env.example."
  echo "IMPORTANT: edit .env — set ZENITH_LLM_API_KEY at minimum (plus"
  echo "ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID for the spoken voice)."
else
  echo ".env already exists — leaving it untouched."
fi
echo ""
echo "Setup complete. Run start.sh (or npm start) to launch ZENITH."
