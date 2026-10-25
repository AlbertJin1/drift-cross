@echo off
setlocal EnableExtensions
REM Drift (cross-platform Electron build) - Windows single-file portable EXE.
REM Requires Node.js 20+ (https://nodejs.org) on the BUILD MACHINE only.

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: node was not found on PATH.
    echo Install Node.js LTS from https://nodejs.org
    goto :fail_end
)

cd /d "%~dp0"

echo Closing any running Drift.exe...
taskkill /f /im Drift.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail_end

echo.
echo Compiling Tailwind CSS...
call npm run css:build
if errorlevel 1 goto :fail_end

echo.
echo Cleaning previous dist output...
if exist "dist" rmdir /s /q "dist"

echo.
echo Building portable Drift.exe...
call npx electron-builder --win portable
if errorlevel 1 goto :fail_end

echo.
echo ============================================================
echo Drift build complete.
echo Output: %~dp0dist\Drift.exe
echo Single-file portable EXE - Chromium is bundled, nothing else to install.
echo ============================================================
exit /b 0

:fail_end
echo.
echo Drift build failed. Review the output above.
echo TIP: if you see a "symbolic link" error, enable Windows Developer Mode or run this as Administrator.
pause
exit /b 1
