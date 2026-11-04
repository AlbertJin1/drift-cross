@echo off
setlocal EnableExtensions
REM Drift Browser - Windows Setup launcher build. Double-click this file or run it from a terminal.
REM All of the work happens in scripts\build-installer.cjs (Node), which logs to build-logs\build-latest.log.
REM This window ALWAYS stays open at the end so the result can be read. Set DRIFT_NO_PAUSE=1 to disable (CI).
cd /d "%~dp0.."
title Drift Browser - Setup launcher build

where node >nul 2>nul
if errorlevel 1 goto :no_node

node "scripts\build-installer.cjs" --setup %*
set "DRIFT_RC=%ERRORLEVEL%"
goto :finish

:no_node
echo.
echo ERROR: Node.js was not found on PATH.
echo Install the current LTS from https://nodejs.org/ and open a NEW terminal or run this file again.
set "DRIFT_RC=1"

:finish
echo.
if "%DRIFT_RC%"=="0" goto :ok
echo Build FAILED (exit code %DRIFT_RC%). Details: build-logs\build-latest.log
goto :pause_end
:ok
echo Build finished successfully.
:pause_end
if not defined DRIFT_NO_PAUSE pause
exit /b %DRIFT_RC%
