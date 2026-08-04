@echo off
REM 启动灵栖 Lumii 开发模式（调用 PowerShell 脚本）
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1" %*
