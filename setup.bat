@echo off
rem No "chcp 65001" - see run.bat: the code page switch corrupts the rest of
rem the batch file. These files are UTF-8 and render correctly as they are.
title Naada Tarangini - Setup
cd /d "%~dp0"

echo.
echo   Setting up Naada Tarangini (YouTube Music desktop player)
echo   ------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [1/2] Node.js not found. Install the LTS build from https://nodejs.org
  echo         and run this file again.
  echo.
  pause
  exit /b 1
)

echo   [1/2] Checking dependencies...
if not exist "node_modules\electron\dist\electron.exe" (
  call npm install --no-audit --no-fund
  if exist "node_modules\electron\install.js" call node "node_modules\electron\install.js"
) else (
  echo         already installed.
)

echo.
echo   [2/2] Checking the YouTube stream helper (yt-dlp)...
if exist "vendor\yt-dlp.exe" (
  echo         already present.
) else (
  echo         downloading yt-dlp...
  if not exist "vendor" mkdir "vendor"
  where curl >nul 2>nul
  if not errorlevel 1 (
    curl.exe -L --fail -o "vendor\yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  )
  if not exist "vendor\yt-dlp.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'vendor\yt-dlp.exe' -UseBasicParsing } catch { exit 1 }"
  )
  if not exist "vendor\yt-dlp.exe" (
    echo.
    echo   Could not download yt-dlp. Without it nothing will play: every
    echo   track, including the seven default songs, is resolved to a direct
    echo   stream by yt-dlp, and there is no other source. The cards and the
    echo   artwork still load, so the app looks right but stays silent.
    echo   Download it manually from:
    echo   https://github.com/yt-dlp/yt-dlp/releases
    echo.
    pause
  )
)

echo.
echo   Done. Start the player with run.bat
echo.
pause
