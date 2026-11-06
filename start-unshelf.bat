@echo off
setlocal
title Unshelf Bridge

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [!] Virtual environment not found. Running install-unshelf.bat first...
    call "%~dp0install-unshelf.bat"
    if not exist ".venv\Scripts\python.exe" (
        echo [ERROR] Setup could not be completed.
        pause
        exit /b 1
    )
)

echo.
echo   Starting Unshelf Bridge on 127.0.0.1:8765...
echo   Keep this terminal open while using Unshelf in Chrome.
echo.

".venv\Scripts\python.exe" -u unshelf\bridge\unshelf_bridge.py

if %errorlevel% neq 0 (
    echo.
    echo [!] Unshelf Bridge stopped with an error (code %errorlevel%).
    pause
)

