@echo off
cd /d C:\Users\15066212pp\src\PiDeck\jump-rw2
node --test --test-timeout=600000 tests/ > C:\tmp\full5.log 2>&1
echo done > C:\tmp\full5.status
