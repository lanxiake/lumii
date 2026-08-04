@echo off
REM 停止灵栖 Lumii 开发模式
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-dev.ps1" %*
