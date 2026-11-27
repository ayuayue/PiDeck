@echo off
cd /d C:\Users\15066212pp\src\PiDeck\jump-rw2
if exist C:\tmp\pack9.status del C:\tmp\pack9.status
git rev-parse HEAD > C:\tmp\pack9.head.txt
git log -1 --format=%%cI >> C:\tmp\pack9.head.txt
call npm run build > C:\tmp\build9.log 2>&1
if errorlevel 1 (echo FAIL_BUILD > C:\tmp\pack9.status & exit /b 1)
call npx electron-builder --win nsis --config scripts/electron-builder.config.js > C:\tmp\eb9.log 2>&1
if errorlevel 1 (echo FAIL_EB > C:\tmp\pack9.status & exit /b 1)
echo OK > C:\tmp\pack9.status
