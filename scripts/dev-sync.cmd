@echo off
rem Local web site that keeps itself up to date: double-click, or run from the repo. Add -Live for real devnet data.
rem See dev-sync.ps1 next to this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev-sync.ps1" %*
pause
