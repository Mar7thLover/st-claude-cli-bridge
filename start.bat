@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title SillyTavern - Claude CLI Bridge

where node >nul 2>nul
if errorlevel 1 goto nonode

node src\server.js
echo.
echo Bridge stopped.
pause
exit /b 0

:nonode
echo [ERROR] Node.js not found in PATH. Please install Node.js 20+ first.
pause
exit /b 1
