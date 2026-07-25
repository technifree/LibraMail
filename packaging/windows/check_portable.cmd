@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0check_portable.ps1"
if errorlevel 1 pause
