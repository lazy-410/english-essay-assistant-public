@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Kaoyan English Essay Assistant

set "NODE_BIN="

rem 1) Prefer the bundled portable runtime so no installation is needed.
if exist "%~dp0runtime\node.exe" set "NODE_BIN=%~dp0runtime\node.exe"

rem 2) Fall back to a system-wide Node.js installation.
if not defined NODE_BIN (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_BIN=node"
)

if not defined NODE_BIN (
  echo.
  echo   [ERROR] No Node.js runtime available.
  echo.
  echo   Option 1 [recommended]: use the bundled edition whose name
  echo            ends with -mianzhuang.zip. It ships a runtime folder
  echo            and needs no installation.
  echo.
  echo   Option 2: install Node.js 18 or newer from https://nodejs.org
  echo             and then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "config.json" (
  copy /y "config.example.json" "config.json" >nul
  echo   config.json created. Set your DeepSeek API Key on the Settings page.
)

"%NODE_BIN%" server.mjs
if errorlevel 1 (
  echo.
  echo   [ERROR] Server exited unexpectedly. See the message above.
)
pause
