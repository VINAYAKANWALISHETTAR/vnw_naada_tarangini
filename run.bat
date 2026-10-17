@echo off
rem Deliberately no "chcp 65001" here. The Kannada below renders correctly
rem because these files are UTF-8, and switching the console code page while
rem cmd.exe is reading a batch file corrupts the remaining lines ("'e' is not
rem recognized..."). Measured on this machine: correct without it, broken with.
title Naada Tarangini - YouTube Music Player
cd /d "%~dp0"

rem Electron must not run as a plain Node process.
set ELECTRON_RUN_AS_NODE=

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this machine.
  echo   Install the LTS build from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   First launch - installing Naada Tarangini dependencies, please wait...
  echo.
  call npm install --no-audit --no-fund
  if exist "node_modules\electron\install.js" (
    node "node_modules\electron\install.js" >nul 2>nul
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo   Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist "vendor\yt-dlp.exe" (
  echo   Downloading the YouTube stream helper...
  if not exist "vendor" mkdir "vendor"
  where curl >nul 2>nul
  if not errorlevel 1 (
    curl.exe -L -s --fail -o "vendor\yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  )
  if not exist "vendor\yt-dlp.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'vendor\yt-dlp.exe' -UseBasicParsing } catch { exit 1 }" >nul 2>nul
  )
)

start "" "node_modules\electron\dist\electron.exe" .
