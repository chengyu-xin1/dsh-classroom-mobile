@echo off
"%SystemRoot%\System32\chcp.com" 65001 >nul
setlocal
echo ==========================================
echo  dsh-classroom-mobile installer
echo  Requires: Windows + DSH desktop + Node.js 20+
echo ==========================================
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
echo Exit code: %errorlevel%
pause