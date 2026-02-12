@echo off
setlocal enabledelayedexpansion

REM --- go to script directory (project root) ---
cd /d "%~dp0"

REM --- sanity: npm available? ---
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found in PATH. Install Node.js and reopen terminal.
  exit /b 1
)

REM --- Backend install (only if needed) ---
if not exist "backend\node_modules\" (
  echo [backend] npm install...
  pushd "backend"
  call npm install
  if errorlevel 1 (
    echo [ERROR] backend npm install failed
    popd
    exit /b 1
  )
  popd
) else (
  echo [backend] node_modules exists, skip install
)

REM --- Frontend install (only if needed) ---
if not exist "frontend\node_modules\" (
  echo [frontend] npm install...
  pushd "frontend"
  call npm install
  if errorlevel 1 (
    echo [ERROR] frontend npm install failed
    popd
    exit /b 1
  )
  popd
) else (
  echo [frontend] node_modules exists, skip install
)

REM --- Start both in separate terminals ---
echo Starting backend and frontend...
start "backend" cmd /k "cd /d %~dp0backend && npm run dev"
start "frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo Done.
exit /b 0
