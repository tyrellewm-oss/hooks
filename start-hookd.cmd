@echo off
rem Hookd: run the whole site on this PC. Double-click this file, or run it from a terminal in the repo folder.
rem Options: --demo (sample tokens)  --live  --preview  --check  --no-follow  --no-indexer  --no-browser
rem Settings: .env (made on first run). Details: scripts\start.mjs and README "Run it on your PC".
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then run this file again.
  pause
  exit /b 1
)
rem one line, so cmd has read all of it before node runs (a pull may rewrite this file while it runs)
node scripts\start.mjs %* || pause & exit /b
