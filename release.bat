@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM Drift - build the all-in-one Drift-Setup.exe and publish it through the Monitor API (installed copies update from it).
REM Usage: release.bat [auto|public|local] [-Force] [-NoZip]
REM        release.bat noupload
REM auto uses the LAN Monitor first, then falls back to the configured/public endpoint if the LAN is unavailable.
REM public uses the configured public Monitor URL; local bypasses zrok and posts to the Monitor host on the LAN.
REM This file and publish_to_monitor.ps1 are the same release workflow as FlickFetch / PDF Studio, adapted for Drift.

set "MONITOR=https://pdfstudio.shares.zrok.io/pdfstudio-monitor/releases.php?app=drift"
set "TARGET="
set "EXTRA_ARGS="
set "NOUPLOAD=0"
for %%A in (%*) do (
    if /i "%%~A"=="auto" set "TARGET=auto"
    if /i "%%~A"=="public" set "TARGET=public"
    if /i "%%~A"=="local" set "TARGET=local"
    if /i "%%~A"=="-Force" set "EXTRA_ARGS=!EXTRA_ARGS! -Force"
    if /i "%%~A"=="-NoZip" set "EXTRA_ARGS=!EXTRA_ARGS! -NoZip"
    if /i "%%~A"=="noupload" set "NOUPLOAD=1"
)
cd /d "%~dp0"

REM build_publish.bat normally waits for a key at the end; release.bat continues straight on to the upload.
set "DRIFT_NO_PAUSE=1"
call "%~dp0build_publish.bat"
set "BUILD_RC=%ERRORLEVEL%"
set "DRIFT_NO_PAUSE="
if not "%BUILD_RC%"=="0" exit /b 1

echo.
if not exist "%~dp0publish\Drift-Setup.exe" (
    echo ERROR: Build succeeded but publish\Drift-Setup.exe was not found.
    exit /b 1
)
set "DRIFT_RELEASE_EXE=%~dp0publish\Drift-Setup.exe"
set "DRIFT_RELEASE_PACKAGE=%~dp0package.json"
set "DRIFT_RELEASE_CHANGELOG=%~dp0CHANGELOG.md"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; try { $exe=Get-Item -LiteralPath $env:DRIFT_RELEASE_EXE; $info=$exe.VersionInfo; $pkg=Get-Content -Raw -LiteralPath $env:DRIFT_RELEASE_PACKAGE | ConvertFrom-Json; $verMatch=[regex]::Match([string]$info.FileVersion,'^\s*v?(\d+\.\d+\.\d+)(?:\.\d+)?\s*$'); if(-not $verMatch.Success){ throw ('Invalid EXE FileVersion: ' + $info.FileVersion) }; $ver=$verMatch.Groups[1].Value; $pv=[string]$pkg.version; Write-Host ('Product name        : ' + $info.ProductName); Write-Host ('Version inside EXE  : ' + $ver); Write-Host ('package.json version: ' + $pv); if($info.ProductName -ne 'Drift'){ throw ('ProductName must be Drift; found ' + $info.ProductName) }; if([string]::IsNullOrWhiteSpace($pv) -or $ver -ne $pv){ throw 'EXE version and package.json version differ. Do not publish this build.' }; $log=Get-Content -Raw -Encoding UTF8 -LiteralPath $env:DRIFT_RELEASE_CHANGELOG; if($log -notmatch ('(?m)^##[ \t]+\[?v?' + [regex]::Escape($ver) + '\]?(\s|$|-|:)')){ throw ('CHANGELOG.md has no release heading for ' + $ver + ' (use ## ' + $ver + ' or ## [' + $ver + '])') }; exit 0 } catch { Write-Host ('ERROR: Release validation failed: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
    set "DRIFT_RELEASE_EXE="
    set "DRIFT_RELEASE_PACKAGE="
    set "DRIFT_RELEASE_CHANGELOG="
    echo ERROR: The release was NOT uploaded because metadata validation failed.
    exit /b 1
)
set "DRIFT_RELEASE_EXE="
set "DRIFT_RELEASE_PACKAGE="
set "DRIFT_RELEASE_CHANGELOG="

echo.
if "%NOUPLOAD%"=="1" (
    echo Skipping the upload ^(noupload^). Built file: %~dp0publish\Drift-Setup.exe
    explorer /select,"%~dp0publish\Drift-Setup.exe"
    exit /b 0
)

if not defined TARGET (
    echo ============================================================
    echo Choose the Drift Monitor upload route:
    echo   1. Public zrok URL
    echo   2. Local Monitor - http://192.168.254.110:8080/pdfstudio-monitor
    echo   3. Automatic - local first, then public fallback ^(recommended^)
    echo ============================================================
    set /p "CHOICE=Choose 1, 2, or 3 [3]: "
    if "!CHOICE!"=="1" set "TARGET=public"
    if "!CHOICE!"=="2" set "TARGET=local"
    if "!CHOICE!"=="3" set "TARGET=auto"
    if not defined TARGET set "TARGET=auto"
)

echo.
echo ============================================================
echo Uploading to Drift Monitor using target: !TARGET!
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish_to_monitor.ps1" -Target "!TARGET!" !EXTRA_ARGS!
if errorlevel 1 (
    echo.
    echo The exe was built but NOT uploaded.
    echo Read the "UPLOAD FAILED" line above: the Monitor's own error message is printed there.
    echo Retry WITHOUT rebuilding:
    echo     powershell -ExecutionPolicy Bypass -File publish_to_monitor.ps1 -Target local
    echo Ensure serve.bat is running on 192.168.254.110:8080 and the Monitor API key is in monitor-key.txt.
    echo Or upload %~dp0publish\Drift-Setup.exe by hand at %MONITOR%
    explorer /select,"%~dp0publish\Drift-Setup.exe"
    pause
    exit /b 1
)

echo.
echo Release page: %MONITOR%
exit /b 0
