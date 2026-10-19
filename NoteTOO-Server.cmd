@echo off
rem NoteTOO server: use NoteTOO from a browser on another computer (see README, "Use NoteTOO from your laptop").
rem Double-click to start it, or run it with options, e.g.  NoteTOO-Server.cmd --add-folder "D:\School"
setlocal
cd /d "%~dp0"
title NoteTOO server
where node >nul 2>nul || (
  echo NoteTOO needs Node.js 20 or later: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, only needed the first time...
  call npm install --no-audit --no-fund || goto :failed
)
call npm run --silent server -- %*
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo The NoteTOO server stopped because of an error (see above).
pause
exit /b 1
