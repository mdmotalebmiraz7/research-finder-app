"""LLM provider selection and Ollama management.

* Default engine: local Ollama (qwen3:1.7b).
* If a Groq API key is present in the settings, Groq is used instead.
"""
import json
import os
import platform
import re
import shutil
import subprocess
import time
from collections.abc import Iterator

import psutil
import requests
from pydantic import BaseModel

DEFAULT_OLLAMA_MODEL = "qwen3:1.7b"
GROQ_MODEL = "openai/gpt-oss-20b"
OLLAMA_DOWNLOAD_URL = "https://ollama.com/download"


def _ollama_url() -> str:
    host = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434").strip()
    if not host.startswith("http"):
        host = "http://" + host
    return host.replace("0.0.0.0", "127.0.0.1").rstrip("/")


OLLAMA_URL = _ollama_url()


class Settings(BaseModel):
    """Sent by the browser with every AI request (kept in the browser's localStorage)."""

    groq_key: str = ""
    tavily_key: str = ""
    openalex_key: str = ""
    ollama_model: str = DEFAULT_OLLAMA_MODEL
    target_lang: str = "bn"

    def engine(self) -> str:
        return "groq" if self.groq_key.strip() else "ollama"

    def search_engine(self) -> str:
        return "tavily" if self.tavily_key.strip() else "duckduckgo"


def strip_think(text: str) -> str:
    """Remove <think>...</think> blocks that some local models print."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<think>.*$", "", text, flags=re.DOTALL | re.IGNORECASE)  # unclosed block
    return text.strip()


# -------------------- Hardware and model recommendation --------------------

def hardware_info() -> dict:
    ram_gb = round(psutil.virtual_memory().total / 1024**3, 1)
    gpu, vram_gb = None, 0.0
    try:
        import torch

        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            gpu, vram_gb = props.name, round(props.total_memory / 1024**3, 1)
    except Exception:
        pass
    return {"ram_gb": ram_gb, "gpu": gpu, "vram_gb": vram_gb, "cpu_cores": os.cpu_count()}


def recommend_model(hw: dict) -> str:
    """Biggest tool-calling model the machine can run comfortably."""
    memory = hw["vram_gb"] if hw.get("gpu") else hw["ram_gb"] / 2
    if memory >= 14:
        return "qwen3:14b"
    if memory >= 7:
        return "qwen3:8b"
    if memory >= 4:
        return "qwen3:4b"
    return "qwen3:1.7b"


# -------------------- Ollama management --------------------

def ollama_installed() -> bool:
    return shutil.which("ollama") is not None


def ollama_running() -> bool:
    try:
        return requests.get(f"{OLLAMA_URL}/api/tags", timeout=2).ok
    except requests.RequestException:
        return False


def start_ollama(wait: float = 20.0) -> bool:
    """Start `ollama serve` in the background if it is installed but not running."""
    if ollama_running():
        return True
    if not ollama_installed():
        return False
    try:
        subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return False
    deadline = time.time() + wait
    while time.time() < deadline:
        if ollama_running():
            return True
        time.sleep(0.5)
    return False


def installed_models() -> list[str]:
    try:
        data = requests.get(f"{OLLAMA_URL}/api/tags", timeout=3).json()
        return [m.get("name", "") for m in data.get("models", [])]
    except Exception:
        return []


def model_installed(model: str) -> bool:
    names = installed_models()
    return model in names or (":" not in model and f"{model}:latest" in names)


def ollama_status(model: str) -> dict:
    running = ollama_running()
    return {
        "installed": ollama_installed(),
        "running": running,
        "models": installed_models() if running else [],
        "model": model,
        "model_ready": running and model_installed(model),
        "platform": platform.system(),
        "download_url": OLLAMA_DOWNLOAD_URL,
    }


def _install_ollama_linux() -> Iterator[dict]:
    yield {"status": "Installing Ollama (this can take a few minutes)..."}
    try:
        proc = subprocess.run(
            "curl -fsSL https://ollama.com/install.sh | sh",
            shell=True,
            capture_output=True,
            text=True,
            timeout=900,
        )
    except Exception as exc:
        yield {"error": f"Ollama install failed: {exc}"}
        return
    if proc.returncode != 0 or not ollama_installed():
        tail = (proc.stderr or proc.stdout or "")[-300:]
        yield {"error": f"Ollama install failed. {tail}".strip()}


def pull_model(model: str) -> Iterator[dict]:
    """Download a model, yielding Ollama's progress events (install/start Ollama first if needed)."""
    if not ollama_running():
        if not ollama_installed():
            if platform.system() == "Linux":
                for event in _install_ollama_linux():
                    yield event
                    if "error" in event:
                        return
            else:
                yield {
                    "error": f"Ollama is not installed. Download it from {OLLAMA_DOWNLOAD_URL}, "
                    "install it, then press Download again."
                }
                return
        yield {"status": "Starting Ollama..."}
        if not start_ollama():
            yield {"error": "Could not start Ollama. Start it manually with: ollama serve"}
            return

    try:
        with requests.post(
            f"{OLLAMA_URL}/api/pull",
            json={"model": model, "name": model, "stream": True},
            stream=True,
            timeout=(10, None),
        ) as response:
            if not response.ok:
                yield {"error": f"Ollama refused the download: {response.text[:300]}"}
                return
            for line in response.iter_lines():
                if not line:
                    continue
                data = json.loads(line)
                if "error" in data:
                    yield {"error": data["error"]}
                    return
                yield data
    except requests.RequestException as exc:
        yield {"error": f"Download interrupted: {exc}"}
        return
    yield {"status": "success", "done": True}


# -------------------- LLM factory --------------------

def get_llm(settings: Settings, *, temperature: float = 0.0, json_schema: dict | None = None):
    """Groq if a key is set, otherwise a local Ollama model."""
    if settings.engine() == "groq":
        from langchain_groq import ChatGroq

        return ChatGroq(model=GROQ_MODEL, api_key=settings.groq_key.strip(), temperature=temperature)

    from langchain_ollama import ChatOllama

    model = settings.ollama_model.strip() or DEFAULT_OLLAMA_MODEL
    if not start_ollama():
        raise RuntimeError(
            "Ollama is not running. Open Settings to install or start it, or add a Groq key to use the cloud."
        )
    if not model_installed(model):
        raise RuntimeError(f"The model '{model}' is not downloaded yet. Open Settings and press Download.")

    kwargs: dict = {"model": model, "base_url": OLLAMA_URL, "temperature": temperature, "num_ctx": 8192}
    if json_schema:
        kwargs["format"] = json_schema
    try:
        return ChatOllama(**kwargs, reasoning=False)  # no <think> output
    except Exception:
        return ChatOllama(**kwargs)
