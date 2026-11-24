@echo off
rem ZENITH — one-time setup. Installs dependencies and creates .env from the
rem template if one doesn't exist yet.
cd /d "%~dp0"
echo.
echo [1/3] Checking Node.js (>= 22.5 required)...
node --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js is not installed or not on PATH.
  echo Install it from https://nodejs.org — any 22.x LTS build works.
  echo Then double-click setup.bat again.
  pause
  exit /b 1
)
for /f "tokens=1,2 delims=." %%a in ('node --version') do set nodeMajor=%%a
for /f "tokens=1,2 delims=." %%a in ('node --version') do set nodeMinor=%%b
node -e "const v=process.version.slice(1).split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<5)){console.error('Node.js >= 22.5 is required, found '+process.version);process.exit(1)};console.log('Node '+process.version+' — OK')"
if errorlevel 1 (
  echo.
  echo ZENITH needs Node.js >= 22.5 (it uses the built-in node:sqlite module).
  echo Please install a newer Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)
echo.
echo [2/3] Installing dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. If you are offline, check your network or registry.
  pause
  exit /b 1
)
echo.
echo [3/3] Ensuring .env exists...
if not exist .env (
  copy .env.example .env >nul
  echo   Created .env from .env.example.
  echo.
  echo   IMPORTANT: edit .env now — set ZENITH_LLM_API_KEY at minimum,
  echo   and ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID for the spoken voice.
  echo   The file is never committed; your keys stay on this machine.
) else (
  echo   .env already exists — leaving it untouched.
)
echo.
echo Setup complete. Double-click start.bat to run ZENITH.
pause
