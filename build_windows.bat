@echo off
setlocal EnableExtensions

set "ARGS=%*"
set "ARGS=%ARGS:--with-data=-WithData%"
set "ARGS=%ARGS:--fresh-npm=-FreshNpm%"
set "ARGS=%ARGS:--embed-resources=-EmbedResources%"
set "ARGS=%ARGS:--offline=-Offline%"
set "ARGS=%ARGS:--keep-work=-KeepWork%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_windows.ps1" %ARGS%
exit /b %ERRORLEVEL%
