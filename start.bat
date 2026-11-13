@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Первая установка зависимостей...
  call npm run setup || goto :err
)
if not exist client\dist (
  call npm run build || goto :err
)
start "" http://localhost:3700
node server\index.js
goto :eof
:err
echo Ошибка установки. Проверьте, что установлен Node.js 18+ (https://nodejs.org)
pause
