@echo off
setlocal EnableExtensions
REM Drift Windows per-user installer.
REM Installs the application under the current user's AppData\Local\Programs\Drift.
REM Browser profile data is stored separately under %APPDATA%\Drift.
REM Requires Node.js 20+ on the BUILD MACHINE only.

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: node was not found on PATH.
    echo Install Node.js LTS from https://nodejs.org
    goto :fail_end
)

cd /d "%~dp0.."

echo.
echo Installing locked project dependencies...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :fail_end

echo.
echo Compiling Tailwind CSS...
call npm run css:build
if errorlevel 1 goto :fail_end

echo.
echo Cleaning previous dist output...
if exist "dist" rmdir /s /q "dist"

echo.
echo Building Drift per-user Windows installer...
call npx electron-builder --win nsis
if errorlevel 1 goto :fail_end

echo.
echo ============================================================
echo Drift build complete.
echo Installer: %CD%\dist\Drift-Setup.exe
echo.
echo Installation is per-user and does not require Administrator access.
echo App files: %LOCALAPPDATA%\Programs\Drift
echo Profile:   %APPDATA%\Drift
echo ============================================================
exit /b 0

:fail_end
echo.
echo Drift build failed. Review the output above.
echo TIP: if you see a symbolic-link error, enable Windows Developer Mode or run the build from an elevated terminal.
pause
exit /b 1
