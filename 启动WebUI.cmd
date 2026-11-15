@echo off
cd /d "%~dp0"
set "NODE_RUNNER=node"
if exist "%~dp0node.exe" set "NODE_RUNNER=%~dp0node.exe"
if not exist "%~dp0node.exe" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js 22 or newer is required. Install it, then run this file again.
    pause
    exit /b 1
  )
)
if not exist "node_modules\ws\package.json" (
  echo Installing local dependencies...
  call npm ci --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
"%NODE_RUNNER%" web\start.cjs
if errorlevel 1 pause
