@echo off
setlocal
REM Builds the custom Drift installer -> dist-setup\Drift-Setup.exe  (run from anywhere)
cd /d "%~dp0.."
call scripts\build_vpn_helper.bat || goto :fail
call npm ci --no-audit --no-fund || goto :fail
call npm run css:build || goto :fail
call npx electron-builder --config electron-builder.setup.json --win portable --x64 --publish never || goto :fail
echo.
echo Done: dist-setup\Drift-Setup.exe
exit /b 0
:fail
echo BUILD FAILED
exit /b 1
