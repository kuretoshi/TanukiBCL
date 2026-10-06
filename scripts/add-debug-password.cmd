@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-debug-password.ps1" -Add
if errorlevel 1 (
    echo Password was not added.
)
pause
