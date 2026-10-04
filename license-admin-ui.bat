@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title License Admin UI

rem Prefer the bundled Node.js runtime. Keep this file ASCII-only for cmd.exe.
set "NODE_BIN=%~dp0runtime\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

if /i "%NODE_BIN%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [ERROR] Node.js was not found.
    echo Install Node.js 18 or newer, then run this file again.
    echo.
    pause
    exit /b 1
  )
)

"%NODE_BIN%" "%~dp0scripts\license-admin-ui.mjs"
set "STATUS=%ERRORLEVEL%"
if not "%STATUS%"=="0" (
  echo.
  echo [ERROR] License Admin UI exited with code %STATUS%.
  echo.
  pause
)
exit /b %STATUS%
