@echo off
setlocal
title Build Research Finder (Windows installer)
cd /d "%~dp0"

echo [1/6] Checking Python and Node...
where python >nul 2>nul || (echo ERROR: Install Python 3.10-3.12 from python.org and tick "Add to PATH". & pause & exit /b 1)
where node >nul 2>nul || (echo ERROR: Install Node.js LTS from nodejs.org. & pause & exit /b 1)

echo [2/6] Python build environment (CPU PyTorch keeps the app smaller)...
if not exist build-venv\Scripts\python.exe python -m venv build-venv || goto :fail
call build-venv\Scripts\activate.bat
python -m pip install --upgrade pip || goto :fail
pip install torch --index-url https://download.pytorch.org/whl/cpu || goto :fail
pip install -r backend\requirements.txt pyinstaller || goto :fail

echo [3/6] Building the UI...
pushd frontend
call npm install --no-audit --no-fund || (popd & goto :fail)
call npm run build || (popd & goto :fail)
popd

echo [4/6] Freezing the backend (this takes several minutes)...
if exist desktop\stage rmdir /s /q desktop\stage
python desktop\build_backend.py || goto :fail

echo [5/6] Staging files...
xcopy /e /i /y frontend\dist desktop\stage\ui >nul || goto :fail

echo [6/6] Building the installer...
pushd desktop
call npm install --no-audit --no-fund || (popd & goto :fail)
call npx electron-builder --win nsis || (popd & goto :fail)
popd

echo.
echo DONE. Installer: desktop\dist\
start "" desktop\dist
pause
exit /b 0

:fail
echo.
echo BUILD FAILED. Scroll up for the first error.
pause
exit /b 1
