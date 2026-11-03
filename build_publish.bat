@echo off
setlocal EnableExtensions
REM Root-level entry point for Drift Browser's Windows installer publisher.
REM The build logic lives in scripts\build_publish.bat. It runs in its own cmd
REM process so that even a fatal batch error can never close this window before
REM the result has been shown.
set "DRIFT_ROOT=%~dp0"
set "DRIFT_CHILD=%DRIFT_ROOT%scripts\build_publish.bat"
set "DRIFT_DOUBLE_CLICKED=0"
echo %cmdcmdline% | find /i "%~nx0" >nul 2>nul
if not errorlevel 1 set "DRIFT_DOUBLE_CLICKED=1"

if not exist "%DRIFT_CHILD%" (
    echo ERROR: scripts\build_publish.bat was not found next to this file.
    echo Run this file from the extracted Drift project folder.
    goto :done_fail
)

set "DRIFT_NO_PAUSE=1"
cmd /d /c ""%DRIFT_CHILD%" %*"
set "DRIFT_RC=%ERRORLEVEL%"
if not "%DRIFT_RC%"=="0" goto :done_fail

if "%DRIFT_DOUBLE_CLICKED%"=="1" pause
exit /b 0

:done_fail
if not defined DRIFT_RC set "DRIFT_RC=1"
echo.
echo Build script exited with code %DRIFT_RC%.
if "%DRIFT_DOUBLE_CLICKED%"=="1" pause
exit /b %DRIFT_RC%
