@echo off
chcp 65001 >nul
title Cursor 一键汉化
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Node.js，本脚本需要 Node.js 18 或以上版本。
  echo     正在尝试通过 winget 自动安装 Node.js LTS ...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo [!] 自动安装失败。请手动安装 Node.js 后重新运行本脚本：
    echo     https://nodejs.org/zh-cn （选 LTS 版本，一路下一步即可）
    echo.
    pause
    exit /b 1
  )
  echo.
  echo [+] Node.js 安装完成。请关闭本窗口，重新双击「一键汉化.bat」继续。
  pause
  exit /b 0
)

node "%~dp0scripts\install.mjs" %*
echo.
pause
