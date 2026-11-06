@echo off
setlocal enabledelayedexpansion
title Unshelf - Setup

echo.
echo   ============================================
echo     UNSHELF - Setup
echo     Keep the idea. Lose the scroll.
echo   ============================================
echo.

cd /d "%~dp0"

:: 1. Check for Python
set "PYTHON_EXE="
where uv >nul 2>nul
if %errorlevel% equ 0 (
    echo [*] Found uv package manager.
)

for %%P in (
    "python"
    "py"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
) do (
    if not defined PYTHON_EXE (
        %%~P --version >nul 2>nul
        if !errorlevel! equ 0 (
            set "PYTHON_EXE=%%~P"
        )
    )
)

if not defined PYTHON_EXE (
    echo [ERROR] Python 3.10+ was not found. Please install Python from https://python.org
    pause
    exit /b 1
)

echo [*] Using Python: %PYTHON_EXE%

:: 2. Create virtual environment
if not exist ".venv\Scripts\python.exe" (
    echo [*] Creating virtual environment in .venv...
    where uv >nul 2>nul
    if %errorlevel% equ 0 (
        uv venv .venv
    ) else (
        "%PYTHON_EXE%" -m venv .venv
    )
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
) else (
    echo [*] Existing virtual environment found in .venv.
)

:: 3. Install dependencies
echo [*] Installing dependencies from requirements.txt...
where uv >nul 2>nul
if %errorlevel% equ 0 (
    uv pip install --python .venv\Scripts\python.exe -r requirements.txt
) else (
    .venv\Scripts\python.exe -m pip install -r requirements.txt
)

if %errorlevel% neq 0 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)

echo.
echo   ============================================
echo     Setup complete!
echo     Run start-unshelf.bat to launch the bridge.
echo   ============================================
echo.
pause

