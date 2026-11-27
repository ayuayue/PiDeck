@echo off
cd /d C:\Users\15066212pp\src\PiDeck\jump-rw2
call npm run build > C:\tmp\build5.log 2>&1
if errorlevel 1 exit /b 1
call npx electron-builder --win nsis --config scripts/electron-builder.config.js > C:\tmp\eb5.log 2>&1
if errorlevel 1 exit /b 1
echo done > C:\tmp\pack5.status
