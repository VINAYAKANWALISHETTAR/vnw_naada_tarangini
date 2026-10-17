@echo off
rem No "chcp 65001" - see run.bat: the code page switch corrupts the rest of
rem the batch file. These files are UTF-8 and render correctly as they are.
title Naada Tarangini (browser preview)
cd /d "%~dp0"

rem The preview is served over the same loopback origin the desktop app uses,
rem so the browser shows the current build instead of a cached copy.
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this machine.
  echo   Install the LTS build from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

node js\web-preview.js

rem Node exited (for example the server could not start): fall back to the
rem bare file, so the page is still reachable.
if errorlevel 1 (
  echo.
  echo   Falling back to opening index.html directly...
  start "" "index.html"
)
