@echo off
setlocal
chcp 65001 >nul
title Cursor 恢复英文界面
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Node.js，无法运行恢复脚本。
  echo     安装 Node.js 后重试：https://nodejs.org/zh-cn
  pause
  exit /b 1
)

node "%~dp0scriptsestore.mjs" %*
echo.
pause
