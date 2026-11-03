@echo off
setlocal EnableExtensions DisableDelayedExpansion

REM Drift Browser - reproducible Windows x64 installer build.
REM Run from any directory. Node.js 20+ and npm are required on the BUILD machine.
REM Final deliverables: dist\Drift-Setup.exe and publish\*.

set "DRIFT_ROOT=%~dp0.."
for %%I in ("%DRIFT_ROOT%") do set "DRIFT_ROOT=%%~fI"
cd /d "%DRIFT_ROOT%"
if errorlevel 1 goto :fail

set "CSC_IDENTITY_AUTO_DISCOVERY=false"
set "DRIFT_PUBLISH_DIR=%DRIFT_ROOT%\publish"
set "DRIFT_STAGE_DIR=%DRIFT_ROOT%\publish-staging"
set "DRIFT_BACKUP_DIR=%DRIFT_ROOT%\publish-previous"

echo.
echo ==================================================
echo Drift Browser ^| Windows x64 installer publisher
echo --------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found on PATH.
    echo Install Node.js 20 or newer from https://nodejs.org/ and reopen this terminal.
    goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found on PATH.
    goto :fail
)

node -e "const major=Number(process.versions.node.split('.')[0]); if(major<20){console.error('Node.js 20 or newer is required. Found '+process.version);process.exit(1)}"
if errorlevel 1 goto :fail

for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set "DRIFT_VERSION=%%V"
if not defined DRIFT_VERSION (
    echo ERROR: Could not read the Drift version from package.json.
    goto :fail
)

echo.
echo [1/6] Validating Drift sources and installer resources...
call npm run check
if errorlevel 1 goto :fail

echo.
echo [2/6] Installing exact locked dependencies...
call npm ci --no-audit --no-fund
if errorlevel 1 (
    echo ERROR: npm ci failed. Check the network and package-lock.json.
    goto :fail
)

echo.
echo [3/6] Compiling the local Tailwind stylesheet...
call npm run css:build
if errorlevel 1 goto :fail

echo.
echo [4/6] Preparing a clean NSIS build directory...
if exist "dist" rmdir /s /q "dist"
if exist "dist" (
    echo ERROR: Could not clear dist\. Close any process using files in that directory.
    goto :fail
)

echo.
echo [5/6] Building the Drift Windows x64 installer (current-user default)...
call npx electron-builder --win nsis --x64 --publish never
if errorlevel 1 goto :fail

if not exist "dist\Drift-Setup.exe" (
    echo ERROR: electron-builder finished without creating dist\Drift-Setup.exe.
    echo Check the electron-builder output above.
    goto :fail
)

for %%F in ("dist\Drift-Setup.exe") do set "DRIFT_INSTALLER_SIZE=%%~zF"
if not defined DRIFT_INSTALLER_SIZE goto :fail
if %DRIFT_INSTALLER_SIZE% LSS 1048576 (
    echo ERROR: The installer is unexpectedly small ^(%DRIFT_INSTALLER_SIZE% bytes^).
    goto :fail
)

echo.
echo [6/6] Packaging the publish folder and generating release checksums...
REM Build the entire release in a staging folder and generate its hash before
REM replacing the previous publish folder. A failed build leaves the last
REM known-good release untouched.
if exist "%DRIFT_STAGE_DIR%" rmdir /s /q "%DRIFT_STAGE_DIR%"
mkdir "%DRIFT_STAGE_DIR%"
if errorlevel 1 goto :fail
copy /y "dist\Drift-Setup.exe" "%DRIFT_STAGE_DIR%\Drift-Setup.exe" >nul
if errorlevel 1 goto :fail
copy /y "README.md" "%DRIFT_STAGE_DIR%\PROJECT-README.md" >nul
if errorlevel 1 goto :fail
copy /y "LICENSE" "%DRIFT_STAGE_DIR%\LICENSE.txt" >nul
if errorlevel 1 goto :fail

call node "scripts\write_release_manifest.cjs" "%DRIFT_STAGE_DIR%"
if errorlevel 1 goto :fail

if exist "%DRIFT_BACKUP_DIR%" rmdir /s /q "%DRIFT_BACKUP_DIR%"
if exist "%DRIFT_BACKUP_DIR%" (
    echo ERROR: Could not clear the previous publish backup folder.
    echo Close any process using files under publish-previous\ and retry.
    goto :fail
)
if exist "%DRIFT_PUBLISH_DIR%" (
    move "%DRIFT_PUBLISH_DIR%" "%DRIFT_BACKUP_DIR%" >nul
    if errorlevel 1 goto :fail
)
move "%DRIFT_STAGE_DIR%" "%DRIFT_PUBLISH_DIR%" >nul
if errorlevel 1 (
    if exist "%DRIFT_BACKUP_DIR%" move "%DRIFT_BACKUP_DIR%" "%DRIFT_PUBLISH_DIR%" >nul
    goto :fail
)
if exist "%DRIFT_BACKUP_DIR%" rmdir /s /q "%DRIFT_BACKUP_DIR%" >nul 2>&1

echo.
echo ==============================================================
echo DRIFT BROWSER BUILD COMPLETED
echo ==============================================================
echo Version:       %DRIFT_VERSION%
echo Architecture:  Windows x64
echo Installer:     %DRIFT_ROOT%\dist\Drift-Setup.exe
echo Publish folder:%DRIFT_PUBLISH_DIR%
echo Install scope: Current user by default ^(all-users option for admins^)
echo App files:     %%LOCALAPPDATA%%\Programs\Drift
echo Browser data:  %%APPDATA%%\Drift ^(kept on uninstall^)
echo Package:       Installer + release manifest + SHA-256 + notes
echo ==============================================================
call :maybe_pause
exit /b 0

:fail
echo.
echo ==============================================================
echo DRIFT BROWSER BUILD FAILED
echo ==============================================================
echo Review the first error reported above. The previous published
echo installer is left untouched unless the new build completed.
call :maybe_pause
exit /b 1

:maybe_pause
if "%DRIFT_NO_PAUSE%"=="1" exit /b 0
if "%DRIFT_FORCE_PAUSE%"=="1" goto :do_pause
echo %cmdcmdline% | find /i "%~nx0" >nul 2>nul
if errorlevel 1 exit /b 0
:do_pause
pause
exit /b 0
