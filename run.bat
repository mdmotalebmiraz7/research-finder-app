
@'
@echo off
setlocal
title ResearchFinderAI
cd /d "%~dp0"

echo ==========================================
echo          ResearchFinderAI
echo ==========================================
echo.

echo [1/5] Checking Python...

where python >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python"
) else (
    where py >nul 2>nul
    if errorlevel 1 (
        echo ERROR: Install Python first.
        echo https://www.python.org/downloads/
        pause
        exit /b 1
    )
    set "PYTHON_CMD=py -3"
)

if not exist "backend\requirements.txt" (
    echo ERROR: backend\requirements.txt not found.
    pause
    exit /b 1
)

echo.
echo [2/5] Preparing backend environment...

if not exist "backend\venv\Scripts\python.exe" (
    if exist "backend\venv" rmdir /s /q "backend\venv"
    echo Creating virtual environment...
    %PYTHON_CMD% -m venv "backend\venv"
    if errorlevel 1 (
        echo ERROR: Could not create Python environment.
        pause
        exit /b 1
    )
)

if not exist "backend\venv\Scripts\python.exe" (
    echo ERROR: Backend environment is still missing.
    pause
    exit /b 1
)

echo Installing backend dependencies...
"backend\venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt"
if errorlevel 1 (
    echo ERROR: Backend installation failed.
    pause
    exit /b 1
)

echo.
echo [3/5] Preparing frontend...

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Install Node.js LTS first.
    echo https://nodejs.org/en/download
    pause
    exit /b 1
)

if not exist "frontend\package.json" (
    echo ERROR: frontend\package.json not found.
    pause
    exit /b 1
)

cd /d "%~dp0frontend"
call npm install
if errorlevel 1 (
    echo ERROR: Frontend installation failed.
    cd /d "%~dp0"
    pause
    exit /b 1
)
cd /d "%~dp0"

echo.
echo [4/5] Finding backend entry point...

set "BACKEND_MODULE="
if exist "backend\research_finder.py" set "BACKEND_MODULE=research_finder"
if not defined BACKEND_MODULE if exist "backend\app.py" set "BACKEND_MODULE=app"
if not defined BACKEND_MODULE if exist "backend\main.py" set "BACKEND_MODULE=main"

if not defined BACKEND_MODULE (
    echo ERROR: Could not find research_finder.py, app.py, or main.py in backend.
    echo Check your backend Python filename.
    pause
    exit /b 1
)

echo Starting backend module: %BACKEND_MODULE%
start "ResearchFinderAI Backend" /D "%~dp0backend" cmd /k "venv\Scripts\python.exe -m uvicorn %BACKEND_MODULE%:app --host 127.0.0.1 --port 8000"

timeout /t 4 /nobreak >nul

echo.
echo [5/5] Starting frontend...

start "ResearchFinderAI Frontend" /D "%~dp0frontend" cmd /k "npm run dev -- --host 127.0.0.1"

timeout /t 5 /nobreak >nul
start "" "http://localhost:5173"

echo.
echo Startup initiated.
echo Keep both service windows open.
pause
'@ | Set-Content -Path ".\run.bat" -Encoding ASCII
