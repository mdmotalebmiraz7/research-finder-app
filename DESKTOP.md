# Research Finder - Windows desktop app

The app is an Electron window around the same FastAPI backend and React UI. The backend is frozen
with PyInstaller, so users do not need Python or Node.

## Build the installer (must be done on Windows)

**Option A - your PC:** install Python 3.10-3.12 and Node.js LTS, then double-click `build-windows.bat`.
The installer appears in `desktop\dist\` (`Research Finder Setup 2.0.0.exe`).

**Option B - GitHub (no local setup):** push the project to GitHub, open Actions -> "Build Windows installer"
-> Run workflow. Download the `.exe` from the run's Artifacts.

## Try it without building an installer
```
cd frontend && npm install && npm run build
pip install -r backend\requirements.txt
cd ..\desktop && npm install && npm start
```

## Notes
- First start downloads the ranking and embedding models (about 500 MB) into `%APPDATA%\Research Finder\data\models`.
- Log file: `%APPDATA%\Research Finder\data\backend.log`.
- Local AI needs Ollama for Windows (https://ollama.com/download). Or put a Groq key in Settings and skip Ollama.
- The installer is large (roughly 1 GB) because it contains PyTorch (CPU build).
