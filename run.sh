
#!/usr/bin/env bash
set -Eeuo pipefail

echo "=== ResearchFinderAI Setup ==="

# Install Python dependencies
python -m pip install -r backend/requirements.txt

# Install Ollama (local AI) on Linux/Colab if it is missing. The app downloads the model itself.
if ! command -v ollama >/dev/null 2>&1 && [[ "$(uname -s)" == "Linux" ]]; then
    echo "Installing Ollama..."
    (command -v zstd >/dev/null 2>&1 || apt-get install -y zstd >/dev/null 2>&1 || true)
    curl -fsSL https://ollama.com/install.sh | sh || echo "WARNING: Ollama install failed. Add a Groq key in Settings instead."
fi
if command -v ollama >/dev/null 2>&1 && ! curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    nohup ollama serve > ollama.log 2>&1 &
fi

# Install frontend dependencies
cd frontend
npm install
cd ..

# Detect backend entry point
if [[ -f backend/research_finder.py ]]; then
    MODULE="research_finder"
elif [[ -f backend/app.py ]]; then
    MODULE="app"
elif [[ -f backend/main.py ]]; then
    MODULE="main"
else
    echo "ERROR: Backend Python file not found."
    exit 1
fi

# Start backend
cd backend
nohup python -m uvicorn "${MODULE}:app" \
    --host 0.0.0.0 --port 8000 \
    > ../backend.log 2>&1 &
cd ..

# Start frontend
cd frontend
nohup npm run dev -- --host 0.0.0.0 --port 5173 \
    > ../frontend.log 2>&1 &
cd ..

sleep 5

echo "ResearchFinderAI startup attempted."
echo "Check backend.log and frontend.log if errors occur."
