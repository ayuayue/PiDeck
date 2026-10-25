@echo off
rem Fix PiDeck Windows shortcuts (Start Menu / Desktop / Taskbar pins) and refresh icon cache.
rem Thin wrapper around fix-windows-shortcuts.ps1. See that file for the full logic.
rem
rem Usage (PowerShell-style switches, forwarded verbatim to the ps1):
rem   rebuild-icon-cache.bat                         - DRY-RUN: report only, nothing changed
rem   rebuild-icon-cache.bat -Do                     - APPLY: fix broken shortcuts + refresh icon cache
rem   rebuild-icon-cache.bat -Do -ExePath "D:\path\PiDeck.exe" - portable install
rem   rebuild-icon-cache.bat -Do -NoRebuildIconCache - fix shortcuts but skip Explorer restart
rem
rem Run from an elevated prompt if you have PiDeck shortcuts in %PUBLIC% (all-users) locations.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-windows-shortcuts.ps1" %*
