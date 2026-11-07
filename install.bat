@echo off
chcp 65001 >nul
setlocal
echo ==========================================
echo  dsh-classroom-mobile 一键安装
echo  需要：Windows + 已安装 DSH + Node.js 20+
echo ==========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
echo 退出码：%errorlevel%
pause
