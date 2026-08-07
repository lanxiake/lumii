@echo off
REM One-click Lumii Windows packaging (calls PowerShell wrapper)
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-win.ps1" %*
