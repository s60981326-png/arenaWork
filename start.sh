#!/usr/bin/env bash
# ZENITH — start the local app (Linux/macOS/Git Bash).
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "First run — installing dependencies..."
  npm install
fi
node --version | grep -qE 'v(2[2-9]|[3-9][0-9])\.' || {
  echo "ZENITH needs Node.js >= 22.5 (found: $(node --version 2>/dev/null || echo none))"
  echo "Install from https://nodejs.org and try again."
  exit 1
}
echo "Starting ZENITH on http://localhost:4567"
( sleep 1 && (command -v xdg-open >/dev/null && xdg-open http://localhost:4567) || (command -v open >/dev/null && open http://localhost:4567) || true ) >/dev/null 2>&1 &
node backend/server.js
