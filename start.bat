@echo off
rem ZENITH — start the local app and open it in the browser.
cd /d "%~dp0"
if not exist node_modules (
  echo First run — installing dependencies...
  call npm install
)
echo.
echo Starting ZENITH on http://localhost:4567
echo Press Ctrl+C in this window to stop.
echo.
start "" http://localhost:4567
node backend/server.js
pause
