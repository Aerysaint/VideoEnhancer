@echo off
REM Video Enhancer - One-time setup script for Windows.
REM Run this from the Video_Enhancer folder.

echo ==========================================
echo  Video Enhancer - Setup
echo ==========================================
echo.

REM -- Check for Node.js --
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo.
  echo Please install Node.js first:
  echo   https://nodejs.org/
  echo.
  echo After installing, re-run this script.
  pause
  exit /b 1
)

node --version
call npm --version
echo.

REM -- Install esbuild --
echo [1/3] Installing dependencies (esbuild)...
call npm install
if errorlevel 1 ( echo [ERROR] npm install failed. ^& pause ^& exit /b 1 )
echo.

REM -- Generate icons --
echo [2/3] Generating icons...
node scripts\generate-icons.js
if errorlevel 1 ( echo [ERROR] Icon generation failed. ^& pause ^& exit /b 1 )
echo.

REM -- Bundle content script --
echo [3/3] Bundling content script with esbuild...
if not exist dist mkdir dist
call npm run build
if errorlevel 1 ( echo [ERROR] Build failed. ^& pause ^& exit /b 1 )
echo.

echo ==========================================
echo  Setup complete!
echo ==========================================
echo.
echo Next steps:
echo   1. Open Chrome: chrome://extensions
echo   2. Enable Developer mode (top-right toggle)
echo   3. Click Load unpacked
echo   4. Select this folder:  %CD%
echo   5. Open Netflix or Crunchyroll and play a video.
echo.
echo To rebuild after any code change, run:
echo   npm run build
echo.
pause
