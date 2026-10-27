"""Freeze the FastAPI backend into desktop/stage/backend/backend.exe with PyInstaller."""
import os
import PyInstaller.__main__ as pyi

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STAGE = os.path.join(HERE, "stage")

metadata = ["tqdm", "regex", "requests", "packaging", "filelock", "numpy", "tokenizers", "huggingface_hub",
            "safetensors", "transformers", "torch", "sentence_transformers", "pyyaml", "fastapi", "pydantic",
            "langchain_core", "langchain_community", "langgraph"]
collect_all = ["sentence_transformers", "langchain_huggingface", "langchain_ollama", "langchain_groq",
               "langchain_community", "langchain_text_splitters", "langgraph", "ddgs", "pymupdf", "faiss",
               "deep_translator", "groq"]

args = [
    os.path.join(ROOT, "backend", "desktop_main.py"),
    "--name", "backend", "--onedir", "--console", "--noconfirm", "--clean",
    "--paths", os.path.join(ROOT, "backend"),
    "--distpath", os.path.join(STAGE),
    "--workpath", os.path.join(HERE, "pyi-work"),
    "--specpath", os.path.join(HERE, "pyi-work"),
    "--collect-submodules", "uvicorn",
    "--hidden-import", "agent", "--hidden-import", "providers",
]
for m in metadata:
    args += ["--copy-metadata", m]
for m in collect_all:
    args += ["--collect-all", m]
pyi.run(args)
