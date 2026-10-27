"""Entry point of the bundled backend (PyInstaller) used by the Windows desktop app."""
import os
import sys

# A windowed/frozen process can have no stdout/stderr; send them to a log file instead of crashing.
_data = os.environ.get("RF_DATA_DIR") or os.path.join(os.path.expanduser("~"), ".research-finder")
os.makedirs(_data, exist_ok=True)
if sys.stdout is None or sys.stderr is None:
    _log = open(os.path.join(_data, "backend.log"), "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

os.environ.setdefault("HF_HOME", os.path.join(_data, "models"))  # downloaded AI models live here
os.environ.setdefault("PYTHONUTF8", "1")

import uvicorn  # noqa: E402

from app import app  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("RF_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_config=None)
