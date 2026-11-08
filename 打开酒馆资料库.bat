@echo off
chcp 65001 >nul
cd /d "%~dp0"
set FORCE_DIST=1
title 酒馆资料库

if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 缺少运行文件，请确认整个文件夹完整、未被单独挪动。
  pause
  exit /b
)

if not exist "dist\index.html" (
  echo 首次运行，正在准备界面文件，大约需要 10 秒...
  call pnpm build
)

start "" "node_modules\electron\dist\electron.exe" . --no-sandbox
exit
