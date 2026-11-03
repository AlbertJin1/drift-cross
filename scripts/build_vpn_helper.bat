@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "DRIFT_ROOT=%~dp0.."
for %%I in ("%DRIFT_ROOT%") do set "DRIFT_ROOT=%%~fI"
cd /d "%DRIFT_ROOT%" || goto :fail

where go >nul 2>nul
if errorlevel 1 (
  echo ERROR: Go was not found. Install Go 1.25.5 or newer and reopen this terminal.
  echo The Go toolchain may auto-upgrade to the pinned engine toolchain.
  goto :fail
)
where powershell >nul 2>nul
if errorlevel 1 (
  echo ERROR: Windows PowerShell is required to download and prepare the VPN engine source.
  goto :fail
)

echo.
echo [VPN helper] Building Drift's bundled VPN Gate-compatible OpenVPN/SOCKS5 bridge...
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\build_vpn_helper.ps1" -ProjectRoot "%DRIFT_ROOT%"
if errorlevel 1 goto :fail

if not exist "resources\vpn\openvpn2socks.exe" (
  echo ERROR: VPN helper build did not produce resources\vpn\openvpn2socks.exe.
  goto :fail
)

echo [VPN helper] Ready: resources\vpn\openvpn2socks.exe
exit /b 0

:fail
echo.
echo VPN helper build failed. Drift will not package a broken VPN-enabled installer.
exit /b 1
