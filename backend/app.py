"""Research Finder API.

Run locally:
    pip install -r requirements.txt
    uvicorn app:app --reload --host 0.0.0.0 --port 8000

Endpoints:
    GET  /health
    GET  /logs
    GET  /events?run=<id>&after=<n>      structured progress events for one research run
    GET  /system/status?model=...        hardware + Ollama status
    POST /ollama/pull                    download a model (streams progress, NDJSON)
    POST /research                       {"idea", "settings", "run_id"}
    POST /paper                          {"rank": 1}
    GET  /paper/pdf?rank=1
    POST /paper/process                  {"rank": 1}
    POST /paper/upload                   multipart PDF upload
    POST /ask/stream                     deep agent (rag_search + web_search), streams NDJSON events
    POST /translate                      {"text", "target", "explain"}
"""
import asyncio
import json
import os
import re
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, TypedDict
from urllib.parse import quote

import fitz
import requests
import torch
import uvicorn
from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from groq import Groq
from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer, util

from agent import run_agent
from providers import (
    DEFAULT_OLLAMA_MODEL,
    GROQ_MODEL,
    Settings,
    get_llm,
    hardware_info,
    ollama_status,
    pull_model,
    recommend_model,
    start_ollama,
    strip_think,
)


# -------------------- Configuration --------------------
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
EMBEDDING_MODEL = "all-MiniLM-L6-v2"
YEAR_FROM = 2020
PAPERS_PER_TOPIC = 100
TITLE_TOP_K = 20
FINAL_TOP_K = 10
MAX_SEARCH_PAGES = 3
MIN_TOPICS = 3  # small local models sometimes return fewer than 10 topics

# In-memory prototype storage. Results are lost when the server restarts.
# NOTE: global state means one active session at a time (not multi-user safe).
result = None
selected_paper = None
chunks: list[Document] = []
vector_store = None
retriever = None
logs: list[dict] = []
log_lock = threading.Lock()

# Structured progress events (drawn as a stepper in the UI).
events: list[dict] = []
_event_seq = 0
current_run = ""


def emit(run_id: str, kind: str, **data) -> None:
    global _event_seq
    if not run_id:
        return
    with log_lock:
        _event_seq += 1
        events.append(
            {"id": _event_seq, "run": run_id, "kind": kind,
             "t": datetime.now(timezone.utc).isoformat(), **data}
        )
        if len(events) > 3000:
            del events[:-3000]


_log_seq = 0


def add_log(message: str, level: str = "INFO", run: str | None = None) -> None:
    """Store a log line (served by GET /logs) and mirror it to the active run's event stream."""
    global _log_seq
    with log_lock:
        _log_seq += 1
        logs.append(
            {
                "id": _log_seq,
                "time": datetime.now(timezone.utc).isoformat(),
                "level": level,
                "message": message,
            }
        )
        if len(logs) > 500:
            del logs[:-500]
    print(f"[{level}] {message}", flush=True)
    emit(run or current_run, "log", level=level, message=message)


semantic_model = None
embeddings = None
models_ready = threading.Event()
model_error: str | None = None
_load_lock = threading.Lock()
# Shown in the UI: state is one of waiting | loading | ready | error.
model_status: dict[str, dict] = {
    "ranking": {"label": "Ranking model", "name": EMBEDDING_MODEL, "state": "waiting", "seconds": 0.0},
    "embedding": {"label": "Embedding model", "name": "BAAI/bge-base-en-v1.5", "state": "waiting", "seconds": 0.0},
}


def _load_one(key: str, loader) -> None:
    """Load one model, log start / heartbeat / end, and record its state for /health."""
    info = model_status[key]
    info["state"], info["seconds"] = "loading", 0.0
    add_log(f"Loading {info['label'].lower()} ({info['name']}). The first start downloads it, so it can take a few minutes...")
    started = time.time()
    stop = threading.Event()

    def heartbeat() -> None:
        while not stop.wait(10):
            info["seconds"] = round(time.time() - started, 1)
            add_log(f"Still loading {info['label'].lower()}... {int(info['seconds'])}s")

    threading.Thread(target=heartbeat, daemon=True).start()
    try:
        loader()
    except Exception:
        info["state"] = "error"
        raise
    finally:
        stop.set()
        info["seconds"] = round(time.time() - started, 1)
    info["state"] = "ready"
    add_log(f"{info['label']} loaded in {info['seconds']}s.")


def load_models() -> None:
    """Load heavy models in the background so the server starts answering /health at once."""
    global semantic_model, embeddings, model_error
    if not _load_lock.acquire(blocking=False):
        return  # a load is already running
    try:
        model_error = None
        from langchain_huggingface import HuggingFaceEmbeddings

        def load_ranking() -> None:
            global semantic_model
            semantic_model = SentenceTransformer(EMBEDDING_MODEL, device=DEVICE)

        def load_embedding() -> None:
            global embeddings
            embeddings = HuggingFaceEmbeddings(
                model_name=model_status["embedding"]["name"],
                model_kwargs={"device": DEVICE},
                encode_kwargs={"normalize_embeddings": True},
            )

        if semantic_model is None:
            _load_one("ranking", load_ranking)
        if embeddings is None:
            _load_one("embedding", load_embedding)
        models_ready.set()
        add_log(f"All models loaded on {DEVICE.upper()}. Research Finder API is ready.")
    except Exception as exc:
        model_error = f"{type(exc).__name__}: {exc}"
        add_log(f"Model loading failed: {model_error}", "ERROR")
    finally:
        _load_lock.release()


def require_models() -> None:
    if model_error:
        raise HTTPException(status_code=500, detail=f"Model loading failed: {model_error}")
    if not models_ready.is_set():
        raise HTTPException(status_code=503, detail="Models are still loading. Wait until the status turns green and try again.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    add_log("Server started. Loading models in the background...")
    threading.Thread(target=load_models, daemon=True).start()
    threading.Thread(target=start_ollama, daemon=True).start()  # no-op if Ollama is missing
    yield


app = FastAPI(title="Research Finder API", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict to your frontend origin in production.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------- Request and graph schemas --------------------

class ResearchRequest(BaseModel):
    idea: str = Field(min_length=3, max_length=2000)
    settings: Settings = Settings()
    run_id: str = ""


class RankRequest(BaseModel):
    rank: int = Field(ge=1, le=10)
    run_id: str = ""


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    settings: Settings = Settings()
    history: list[dict] = []


class PullRequest(BaseModel):
    model: str = Field(default=DEFAULT_OLLAMA_MODEL, pattern=r"^[\w.\-:/]{1,100}$")


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    target: str = Field(default="bn", max_length=10)
    explain: bool = False
    context: str = Field(default="", max_length=500)
    settings: Settings = Settings()


class State(TypedDict):
    idea: str
    summary: str
    titles: list[str]
    search_results: Annotated[list[list[dict]], list.__add__]
    papers: list[dict]
    final_results: list[dict]
    settings: dict
    run_id: str


class WorkerState(TypedDict):
    title: str
    idx: int
    summary: str
    run_id: str
    settings: dict


class ResearchPlan(BaseModel):
    summary: str
    titles: list[str]


# -------------------- Paper search and ranking --------------------

def reconstruct_abstract(data) -> str:
    if not data:
        return ""
    words = []
    for word, positions in data.items():
        for position in positions:
            words.append((position, word))
    words.sort()
    return " ".join(word for _, word in words)


class OpenAlexBlocked(Exception):
    """OpenAlex refused the request (401/403 = key/budget problem, 429 = rate limit)."""


def search_openalex(query: str, search_limit: int, year_from: int, api_key: str = "") -> list[dict]:
    add_log(f"Searching OpenAlex for: {query}")

    papers: list[dict] = []
    cursor = "*"
    pages = 0

    while len(papers) < search_limit and pages < MAX_SEARCH_PAGES:
        pages += 1
        params = {
            "search": query,
            # open-access only: the app needs a PDF link, so this saves pages (OpenAlex bills per call)
            "filter": f"from_publication_date:{year_from}-01-01,open_access.is_oa:true",
            "per-page": 200,
            "cursor": cursor,
        }
        if api_key:
            params["api_key"] = api_key

        try:
            response = requests.get("https://api.openalex.org/works", params=params, timeout=30)
        except requests.RequestException as exc:
            add_log(f"OpenAlex search failed for '{query}': {exc}", "ERROR")
            raise
        if response.status_code in (401, 403, 429):
            if papers:  # keep what page 1 already returned
                add_log(f"OpenAlex stopped at page {pages} (HTTP {response.status_code}); using {len(papers)} papers.", "WARNING")
                break
            raise OpenAlexBlocked(f"HTTP {response.status_code}")
        try:
            response.raise_for_status()
            data = response.json()
        except (requests.RequestException, ValueError) as exc:
            add_log(f"OpenAlex search failed for '{query}': {exc}", "ERROR")
            raise

        for item in data.get("results", []):
            title = item.get("title") or ""
            if not title:
                continue

            best_oa = item.get("best_oa_location") or {}
            primary = item.get("primary_location") or {}

            pdf_url = best_oa.get("pdf_url") or primary.get("pdf_url")
            if not pdf_url:  # skip papers without a PDF link
                continue

            doi = item.get("doi") or ""
            link = (
                doi
                or best_oa.get("landing_page_url")
                or primary.get("landing_page_url")
                or item.get("id", "")
            )

            papers.append(
                {
                    "title": title,
                    "abstract": reconstruct_abstract(item.get("abstract_inverted_index")),
                    "year": item.get("publication_year"),
                    "citations": item.get("cited_by_count", 0),
                    "doi": doi,
                    "url": link,
                    "link": link,
                    "openalex_url": item.get("id", ""),
                    "pdf_url": pdf_url,
                }
            )

            if len(papers) >= search_limit:
                break

        cursor = (data.get("meta") or {}).get("next_cursor")
        if not cursor:
            break

    add_log(f"Found {len(papers)} papers for topic: {query}")
    return papers


_ARXIV_NS = {"a": "http://www.w3.org/2005/Atom"}
_ARXIV_STOP = {"a", "an", "and", "or", "of", "for", "in", "on", "with", "to", "the", "using", "by", "from", "via", "vs", "is", "are"}
_arxiv_lock = threading.Lock()
_arxiv_last = 0.0


def parse_arxiv(xml_bytes: bytes, year_from: int) -> list[dict]:
    papers = []
    for entry in ET.fromstring(xml_bytes).findall("a:entry", _ARXIV_NS):
        abs_url = (entry.findtext("a:id", "", _ARXIV_NS) or "").strip()
        title = " ".join((entry.findtext("a:title", "", _ARXIV_NS) or "").split())
        year = int((entry.findtext("a:published", "0000", _ARXIV_NS) or "0000")[:4])
        if not abs_url or not title or year < year_from:
            continue
        papers.append(
            {
                "title": title,
                "abstract": " ".join((entry.findtext("a:summary", "", _ARXIV_NS) or "").split()),
                "year": year,
                "citations": 0,
                "doi": "",
                "url": abs_url,
                "link": abs_url,
                "openalex_url": "",
                "pdf_url": abs_url.replace("/abs/", "/pdf/"),
            }
        )
    return papers


def search_arxiv(query: str, limit: int, year_from: int) -> list[dict]:
    """Key-free fallback when OpenAlex refuses (arXiv asks for at most one request every 3 seconds)."""
    global _arxiv_last
    words = [w for w in re.findall(r"[A-Za-z0-9\-]+", query) if w.lower() not in _ARXIV_STOP][:5]
    if not words:
        return []
    with _arxiv_lock:
        wait = 3.1 - (time.time() - _arxiv_last)
        if wait > 0:
            time.sleep(wait)
        _arxiv_last = time.time()
    response = requests.get(
        "https://export.arxiv.org/api/query",
        params={
            "search_query": " AND ".join(f"all:{w}" for w in words),
            "start": 0,
            "max_results": min(limit, 100),
            "sortBy": "relevance",
        },
        headers={"User-Agent": BROWSER_UA},
        timeout=30,
    )
    response.raise_for_status()
    papers = parse_arxiv(response.content, year_from)
    add_log(f"Found {len(papers)} papers on arXiv for topic: {query}")
    return papers


def search_papers(
    query: str,
    search_limit: int = 100,
    year_from: int = 2020,
    api_key: str = "",
) -> list[dict]:
    if not query.strip():
        return []
    try:
        return search_openalex(query, search_limit, year_from, api_key.strip())
    except OpenAlexBlocked as exc:
        add_log(
            f"OpenAlex refused the request ({exc}). Its free daily budget may be used up; add a free "
            f"OpenAlex key in Settings. Using arXiv for '{query}'.",
            "WARNING",
        )
        return search_arxiv(query, min(search_limit, 50), year_from)


async def semantic_title_rank(
    papers: list[dict], query: str, top_k: int = TITLE_TOP_K
) -> list[dict]:
    """Rank paper titles against `query` (the research summary)."""
    if not papers:
        return []

    def rank() -> list[dict]:
        query_vector = semantic_model.encode(query, convert_to_tensor=True)
        titles = [paper.get("title", "") for paper in papers]
        title_vectors = semantic_model.encode(titles, convert_to_tensor=True)
        scores = util.cos_sim(query_vector, title_vectors)[0]
        indices = scores.argsort(descending=True)[:top_k]
        ranked = []
        for idx in indices:
            i = int(idx)
            item = papers[i].copy()
            item["Semantic"] = float(scores[i])
            ranked.append(item)
        return ranked

    return await asyncio.to_thread(rank)


async def semantic_abstract_rank(
    papers: list[dict], summary: str, top_k: int = FINAL_TOP_K
) -> list[dict]:
    if not papers:
        return []

    def rank() -> list[dict]:
        query_vector = semantic_model.encode(summary, convert_to_tensor=True)
        abstracts = [paper.get("abstract") or paper.get("title", "") for paper in papers]
        abstract_vectors = semantic_model.encode(abstracts, convert_to_tensor=True)
        scores = util.cos_sim(query_vector, abstract_vectors)[0]
        indices = scores.argsort(descending=True)[:top_k]

        ranked = []
        for rank_num, idx in enumerate(indices, start=1):
            i = int(idx)
            paper = papers[i]
            url = paper.get("url") or paper.get("link") or ""
            ranked.append(
                {
                    "Rank": rank_num,
                    "title": paper.get("title", ""),
                    "link": url,
                    "url": url,
                    "pdf_url": paper.get("pdf_url") or url.replace("/abs/", "/pdf/"),
                    "abstract": paper.get("abstract", ""),
                    "year": paper.get("year"),
                    "doi": paper.get("doi", ""),
                    "openalex_url": paper.get("openalex_url", ""),
                    "Semantic": float(scores[i]),
                }
            )
        return ranked

    return await asyncio.to_thread(rank)


# -------------------- LangGraph research workflow --------------------

PLAN_SYSTEM_PROMPT = (
    "You are a research assistant. "
    "Create a concise research summary (3-4 sentences) and exactly 10 distinct academic search topics. "
    'Return ONLY a JSON object of the form {"summary": "...", "titles": ["...", ...]} '
    "with exactly 10 strings in titles."
)

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "titles": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "titles"],
    "additionalProperties": False,
}


def _parse_plan(content: str) -> ResearchPlan:
    content = strip_think(content)
    match = re.search(r"\{.*\}", content, flags=re.DOTALL)  # tolerate code fences / extra text
    data = json.loads(match.group(0) if match else content)
    summary = str(data.get("summary", "")).strip()
    seen, titles = set(), []
    for t in data.get("titles", []):
        if isinstance(t, str) and t.strip() and t.strip().lower() not in seen:
            seen.add(t.strip().lower())
            titles.append(t.strip())
    if not summary:
        raise ValueError("The model returned an empty summary.")
    if len(titles) < MIN_TOPICS:
        raise ValueError(f"Expected research topics, got only {len(titles)}.")
    if len(titles) < 10:
        add_log(f"The model returned {len(titles)} topics instead of 10; continuing with those.", "WARNING")
    return ResearchPlan(summary=summary, titles=titles[:10])


def _plan_with_groq(idea: str, api_key: str, mode: str) -> str:
    client = Groq(api_key=api_key)
    if mode == "json_schema":
        response_format = {
            "type": "json_schema",
            "json_schema": {"name": "research_plan", "strict": True, "schema": PLAN_SCHEMA},
        }
    else:
        response_format = {"type": "json_object"}
    response = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {"role": "system", "content": PLAN_SYSTEM_PROMPT},
            {"role": "user", "content": f"Research idea:\n{idea}"},
        ],
        response_format=response_format,
        temperature=0.2,
        max_completion_tokens=2500,
    )
    content = response.choices[0].message.content
    if not content:
        raise ValueError("The model returned an empty response.")
    return content


def _plan_with_ollama(idea: str, settings: Settings) -> str:
    llm = get_llm(settings, temperature=0.2, json_schema=PLAN_SCHEMA)
    reply = llm.invoke(
        [SystemMessage(PLAN_SYSTEM_PROMPT), HumanMessage(f"Research idea:\n{idea}")]
    )
    content = reply.content if isinstance(reply.content, str) else ""
    if not content.strip():
        raise ValueError("The model returned an empty response.")
    return content


def generate_research_plan(idea: str, settings: Settings) -> ResearchPlan:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            if settings.engine() == "groq":
                mode = "json_schema" if attempt < 3 else "json_object"
                content = _plan_with_groq(idea, settings.groq_key.strip(), mode)
            else:
                content = _plan_with_ollama(idea, settings)
            return _parse_plan(content)
        except RuntimeError:
            raise  # Ollama not running / model missing: retrying will not help
        except Exception as exc:
            last_error = exc
            add_log(f"Research plan attempt {attempt} failed: {exc}", "WARNING")
    raise ValueError(f"Could not generate a research plan: {last_error}")


def generate(state: State) -> dict:
    run = state["run_id"]
    settings = Settings(**state["settings"])
    model = GROQ_MODEL if settings.engine() == "groq" else settings.ollama_model
    emit(run, "plan_start", engine=settings.engine(), model=model)
    add_log(f"Generating research summary and topics with {settings.engine()} ({model})...")
    plan = generate_research_plan(state["idea"], settings)
    emit(run, "summary", summary=plan.summary)
    emit(run, "topics", titles=plan.titles)
    add_log(f"Research plan ready: {len(plan.titles)} topics.")
    return {"summary": plan.summary, "titles": plan.titles}


def dispatch_search(state: State):
    return [
        Send(
            "process_title",
            {"title": title, "idx": i, "summary": state["summary"], "run_id": state["run_id"],
             "settings": state["settings"]},
        )
        for i, title in enumerate(state["titles"])
    ]


async def process_title(state: WorkerState) -> dict:
    title, idx, run = state["title"], state["idx"], state["run_id"]
    emit(run, "topic_start", idx=idx, title=title)
    try:
        papers = await asyncio.to_thread(
            search_papers, title, PAPERS_PER_TOPIC, YEAR_FROM, state["settings"].get("openalex_key", "")
        )
    except Exception as exc:
        # One failing topic must not kill the whole research run.
        add_log(f"Skipping topic '{title}': {exc}", "WARNING")
        emit(run, "topic_fail", idx=idx, title=title, error=str(exc)[:200])
        return {"search_results": [[]]}
    # Papers are matched against the research SUMMARY (not the topic text).
    ranked = await semantic_title_rank(papers, state["summary"], TITLE_TOP_K)
    emit(run, "topic_done", idx=idx, title=title, found=len(papers), kept=len(ranked))
    return {"search_results": [ranked]}


def collect_unique_papers(state: State) -> dict:
    unique: dict[str, dict] = {}
    for topic_results in state["search_results"]:
        for paper in topic_results:
            url = paper.get("url") or paper.get("link") or paper.get("openalex_url") or ""
            if url and url not in unique:
                unique[url] = paper.copy()
    papers = list(unique.values())
    if not papers:
        raise ValueError(
            "No papers were found. OpenAlex and arXiv both returned nothing: the free OpenAlex daily "
            "budget is probably used up. Add a free OpenAlex API key in Settings (openalex.org), "
            "or try again tomorrow. See the raw log for details."
        )
    add_log(f"Collected {len(papers)} unique papers from topic searches.")
    emit(state["run_id"], "collect", unique=len(papers))
    return {"papers": papers}


async def process_abstract(state: State) -> dict:
    run = state["run_id"]
    emit(run, "rank_start", candidates=len(state["papers"]))
    final_results = await semantic_abstract_rank(
        state["papers"], state["summary"], FINAL_TOP_K
    )
    add_log(f"Final ranking complete: {len(final_results)} papers.")
    emit(run, "rank_done", count=len(final_results))
    return {"final_results": final_results}


builder = StateGraph(State)
builder.add_node("generate", generate)
builder.add_node("process_title", process_title)
builder.add_node("collect_unique_papers", collect_unique_papers)
builder.add_node("process_abstract", process_abstract)
builder.add_edge(START, "generate")
builder.add_conditional_edges("generate", dispatch_search, ["process_title"])
builder.add_edge("process_title", "collect_unique_papers")
builder.add_edge("collect_unique_papers", "process_abstract")
builder.add_edge("process_abstract", END)
graph = builder.compile()


# -------------------- Robust PDF fetching (proxy + cache) --------------------

MAX_PDF_BYTES = 50 * 1024 * 1024
PDF_CACHE_LIMIT = 8
pdf_cache: dict[str, bytes] = {}
pdf_lock = threading.Lock()  # protects only the cache dict, never held during downloads
_pdf_key_locks: dict[str, threading.Lock] = {}
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
# Set UNPAYWALL_EMAIL in your environment. Unpaywall is skipped if it is empty.
UNPAYWALL_EMAIL = os.environ.get("UNPAYWALL_EMAIL", "")


def _clean_pdf_url(url: str) -> str:
    match = re.match(r"^\[[^\]]+\]\((https?://[^)]+)\)$", url or "")
    return match.group(1) if match else (url or "")


def _download_pdf(url: str) -> bytes:
    """Download a PDF with browser-like headers, retries and validation."""
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": BROWSER_UA,
            "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
    )
    last_error = "unknown error"
    for attempt in range(3):
        try:
            response = session.get(url, timeout=(10, 60), stream=True, allow_redirects=True)
            if response.status_code in (429, 500, 502, 503, 504):
                last_error = f"HTTP {response.status_code}"
                response.close()
                time.sleep(2 * (attempt + 1))
                continue
            if response.status_code in (401, 403):
                response.close()
                raise ValueError(
                    f"The publisher blocked automated access (HTTP {response.status_code}). "
                    "Use 'Open PDF' to view it in your browser."
                )
            response.raise_for_status()

            data = bytearray()
            for part in response.iter_content(chunk_size=65536):
                data.extend(part)
                if len(data) > MAX_PDF_BYTES:
                    response.close()
                    raise ValueError("PDF is larger than the 50 MB limit.")
            final_url = response.url
            response.close()

            if b"%PDF-" in data[:1024]:
                return bytes(data)

            # Got an HTML landing page: look for the real PDF link in its meta tags.
            html = bytes(data[:300000]).decode("utf-8", errors="ignore")
            meta = re.search(
                r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)',
                html,
                re.I,
            )
            if meta:
                new_url = requests.compat.urljoin(final_url, meta.group(1))
                if new_url != url:
                    url = new_url
                    last_error = "landing page, following citation_pdf_url"
                    continue
            raise ValueError("The link did not return a PDF (it returned a web page).")
        except requests.RequestException as exc:
            last_error = str(exc)
            time.sleep(1.5 * (attempt + 1))
    raise ValueError(f"Could not download the PDF: {last_error}")


def _norm_doi(doi: str) -> str:
    return re.sub(r"^https?://(dx\.)?doi\.org/", "", (doi or "").strip(), flags=re.I)


def _api_json(url: str, **params):
    try:
        r = requests.get(url, params=params or None, timeout=20, headers={"User-Agent": BROWSER_UA})
        if r.ok:
            return r.json()
    except Exception:
        pass
    return None


def fallback_pdf_urls(paper: dict) -> list[str]:
    """Other legal open-access copies of the same paper (arXiv, Unpaywall, Semantic Scholar, OpenAlex)."""
    urls: list[str] = []
    doi = _norm_doi(paper.get("doi", ""))
    blob = " ".join([paper.get("pdf_url", ""), paper.get("url", ""), paper.get("link", ""), doi])
    arx = re.search(r"arxiv\.org/(?:abs|pdf)/([\w.\-/]+?)(?:\.pdf|v\d+)?(?:$|\s)", blob, re.I) or re.search(
        r"10\.48550/arxiv\.([\w.\-]+)", blob, re.I
    )
    if arx:
        urls.append(f"https://arxiv.org/pdf/{arx.group(1)}")
    if doi:
        if UNPAYWALL_EMAIL:
            data = _api_json(f"https://api.unpaywall.org/v2/{doi}", email=UNPAYWALL_EMAIL)
            if data:
                locs = [data.get("best_oa_location")] + (data.get("oa_locations") or [])
                urls += [loc.get("url_for_pdf") for loc in locs if loc and loc.get("url_for_pdf")]
        data = _api_json(f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}", fields="openAccessPdf")
        if data and (data.get("openAccessPdf") or {}).get("url"):
            urls.append(data["openAccessPdf"]["url"])
        data = _api_json(f"https://api.openalex.org/works/https://doi.org/{doi}")
        if data:
            for loc in data.get("locations") or []:
                if loc.get("pdf_url"):
                    urls.append(loc["pdf_url"])
    seen, unique = set(), []
    for u in urls:
        if u and u not in seen:
            seen.add(u)
            unique.append(u)
    return unique


def get_pdf_bytes(paper: dict) -> bytes:
    """Return cached PDF bytes. Tries the main link, then alternative open-access copies."""
    primary = _clean_pdf_url(paper.get("pdf_url", ""))
    cache_key = primary or paper.get("openalex_url") or paper.get("title", "")

    with pdf_lock:
        cached = pdf_cache.get(cache_key)
        key_lock = _pdf_key_locks.setdefault(cache_key, threading.Lock())
    if cached is not None:
        return cached

    # The preview and the indexer ask for the same PDF at once: let one download it, the other reuses it.
    with key_lock:
        with pdf_lock:
            cached = pdf_cache.get(cache_key)
        if cached is not None:
            return cached
        return _fetch_pdf_uncached(paper, primary, cache_key)


def _fetch_pdf_uncached(paper: dict, primary: str, cache_key: str) -> bytes:
    errors: list[str] = []
    tried: set[str] = set()

    def attempt(u: str) -> bytes | None:
        if not u or u in tried:
            return None
        tried.add(u)
        try:
            return _download_pdf(u)
        except Exception as exc:
            host = re.sub(r"^https?://([^/]+).*", r"\1", u)
            errors.append(f"{host}: {exc}")
            add_log(f"PDF source failed ({host}): {exc}", "WARNING")
            return None

    data = attempt(primary)
    if data is None:
        for alt in fallback_pdf_urls(paper):
            data = attempt(alt)
            if data is not None:
                add_log(f"PDF fetched from alternative source: {alt}")
                break
    if data is None:
        raise ValueError("All PDF sources failed. " + " | ".join(errors[:4]))

    with pdf_lock:
        if len(pdf_cache) >= PDF_CACHE_LIMIT:
            pdf_cache.pop(next(iter(pdf_cache)))
        pdf_cache[cache_key] = data
    return data


def find_paper(rank: int) -> dict:
    if result is None:
        raise HTTPException(status_code=400, detail="Run a research search first.")
    paper = next((p for p in result["final_results"] if p.get("Rank") == rank), None)
    if paper is None:
        raise HTTPException(status_code=404, detail="Paper rank not found.")
    return paper


# -------------------- PDF processing (index for rag_search) --------------------

def extract_pdf_chunks(pdf_bytes: bytes) -> tuple[int, list[Document]]:
    pdf = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page_docs = []
        for i, page in enumerate(pdf):
            text = page.get_text()
            if text.strip():
                page_docs.append(Document(page_content=text, metadata={"page": i + 1}))
    finally:
        pdf.close()

    splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
    return len(page_docs), splitter.split_documents(page_docs)


async def index_pdf(paper: dict, pdf_bytes: bytes, run: str = "") -> dict:
    """Chunk the PDF, build the vector store and make it the active paper for the agent."""
    global selected_paper, chunks, vector_store, retriever, current_run
    if run:
        current_run = run
    size_mb = len(pdf_bytes) / 1024 / 1024

    emit(run, "pdf_extract", state="running", size_mb=round(size_mb, 1))
    add_log(f"Reading the PDF ({size_mb:.1f} MB) and splitting it into chunks...", run=run)
    t0 = time.time()
    total_pages, new_chunks = await asyncio.to_thread(extract_pdf_chunks, pdf_bytes)
    if not new_chunks:
        emit(run, "pdf_extract", state="fail")
        raise ValueError("No selectable text found in the PDF. It may be a scanned document.")
    emit(run, "pdf_extract", state="done", pages=total_pages, chunks=len(new_chunks), seconds=round(time.time() - t0, 1))
    add_log(
        f"Chunking done: {total_pages} text pages -> {len(new_chunks)} chunks "
        f"(1000 characters each, 200 overlap) in {time.time() - t0:.1f}s.",
        run=run,
    )

    emit(run, "pdf_embed", state="running", chunks=len(new_chunks))
    add_log(f"Embedding {len(new_chunks)} chunks into the vector index on {DEVICE.upper()}...", run=run)
    t1 = time.time()
    try:
        new_vector_store = await asyncio.to_thread(FAISS.from_documents, new_chunks, embeddings)
    except Exception:
        emit(run, "pdf_embed", state="fail")
        raise
    seconds = round(time.time() - t1, 1)
    emit(run, "pdf_embed", state="done", chunks=len(new_chunks), seconds=seconds)
    add_log(f"Vector index built in {seconds}s. Retrieval is ready.", run=run)

    chunks = new_chunks
    vector_store = new_vector_store
    retriever = vector_store.as_retriever(
        search_type="mmr",
        search_kwargs={"k": 8, "fetch_k": 24},
    )
    selected_paper = paper
    add_log(f"PDF processed: {total_pages} pages, {len(chunks)} chunks.", run=run)
    emit(run, "pdf_done", pages=total_pages, chunks=len(chunks))
    return {
        "title": paper.get("title", ""),
        "total_pages": total_pages,
        "total_chunks": len(chunks),
        "message": "Paper processed successfully.",
    }


# -------------------- Translation --------------------

_translate_cache: dict[tuple, dict] = {}
_text_cache: dict[tuple, str] = {}
_tr_lock = threading.Lock()
_tr_last = 0.0
TRANSLATE_GAP = 0.4  # seconds between requests; Google blocks fast bursts from one IP


def _throttle() -> None:
    global _tr_last
    with _tr_lock:
        wait = TRANSLATE_GAP - (time.time() - _tr_last)
        if wait > 0:
            time.sleep(wait)
        _tr_last = time.time()


def _tr_google_gtx(text: str, target: str) -> str:
    r = requests.get(
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": "auto", "tl": target, "dt": "t", "q": text},
        headers={"User-Agent": BROWSER_UA},
        timeout=12,
    )
    if r.status_code == 429:
        raise RuntimeError("Google rate limit (HTTP 429)")
    r.raise_for_status()
    out = "".join(part[0] for part in r.json()[0] if part and part[0])
    if not out:
        raise RuntimeError("Google returned an empty translation")
    return out


def _tr_google_page(text: str, target: str) -> str:
    from deep_translator import GoogleTranslator

    return GoogleTranslator(source="auto", target=target).translate(text)


def _tr_mymemory(text: str, target: str) -> str:
    if len(text) > 480:
        raise RuntimeError("text too long for MyMemory")
    r = requests.get(
        "https://api.mymemory.translated.net/get",
        params={"q": text, "langpair": f"en|{target}"},
        timeout=12,
    )
    r.raise_for_status()
    out = (r.json().get("responseData") or {}).get("translatedText", "")
    if not out or "MYMEMORY WARNING" in out.upper():
        raise RuntimeError("MyMemory limit reached")
    return out


def translate_text(text: str, target: str) -> str:
    """Translate with throttling, a cache and three providers (Google, Google page, MyMemory)."""
    key = (text, target)
    if key in _text_cache:
        return _text_cache[key]
    errors: list[str] = []
    for provider in (_tr_google_gtx, _tr_google_page, _tr_mymemory):
        for attempt in range(2):
            try:
                _throttle()
                out = provider(text, target)
                _text_cache[key] = out
                if len(_text_cache) > 2000:
                    _text_cache.pop(next(iter(_text_cache)))
                return out
            except Exception as exc:
                errors.append(f"{provider.__name__[4:]}: {str(exc)[:80]}")
                if "429" in str(exc) or "too many" in str(exc).lower():
                    time.sleep(1.5)  # short backoff, then retry once
                else:
                    break
    raise ValueError(
        "All translation services are busy or blocked right now. Wait about a minute and try again. "
        f"({' | '.join(errors[-3:])})"
    )


def translate_many(texts: list[str], target: str) -> list[str]:
    """One request for several short texts (joined by newlines) to stay under rate limits."""
    texts = [t for t in texts if t]
    if not texts:
        return []
    parts = translate_text("\n".join(texts), target).split("\n")
    return parts if len(parts) == len(texts) else []


def lookup_dictionary(word: str, target: str) -> dict | None:
    """English definitions (free dictionary API) with each definition translated."""
    try:
        r = requests.get(f"https://api.dictionaryapi.dev/api/v2/entries/en/{quote(word.lower())}", timeout=8)
        if not r.ok:
            return None
        entry = r.json()[0]
        phonetic = entry.get("phonetic") or next(
            (p.get("text") for p in entry.get("phonetics", []) if p.get("text")), ""
        )
        meanings = [
            {"part": m.get("partOfSpeech", ""), "definitions": [d.get("definition", "") for d in m.get("definitions", [])[:2]]}
            for m in entry.get("meanings", [])[:2]
        ]
        flat = [d for m in meanings for d in m["definitions"] if d]
        try:
            translated = translate_many(flat, target)  # best effort: skipped if translation is busy
        except Exception:
            translated = []
        it = iter(translated)
        for m in meanings:
            m["translations"] = [next(it, "") for _ in m["definitions"]]
        return {"phonetic": phonetic, "meanings": meanings}
    except Exception:
        return None


def explain_in_context(text: str, context: str, settings: Settings) -> str:
    llm = get_llm(settings, temperature=0.2)
    where = f' in the research paper "{context}"' if context else ""
    reply = llm.invoke(
        [
            SystemMessage("You explain technical words and sentences to students in 1-2 short, simple English sentences."),
            HumanMessage(f'Explain what this means{where}:\n"{text}"'),
        ]
    )
    return strip_think(reply.content if isinstance(reply.content, str) else "")


def do_translate(req: TranslateRequest) -> dict:
    text = " ".join(req.text.split())
    key = (text.lower(), req.target, req.explain)
    if key in _translate_cache:
        return _translate_cache[key]

    translation = translate_text(text, req.target)  # raises ValueError with a clear message
    out: dict = {"text": text, "translation": translation, "target": req.target, "kind": "phrase"}

    if re.fullmatch(r"[A-Za-z][A-Za-z'\-]*", text):
        out["kind"] = "word"
        out["dictionary"] = lookup_dictionary(text, req.target)

    if req.explain:
        try:
            english = explain_in_context(text, req.context, req.settings)
            out["explanation"] = english
            out["explanation_translated"] = translate_text(english, req.target) if english else ""
        except Exception as exc:
            out["explanation_error"] = str(exc)

    if not req.explain or "explanation" in out:
        _translate_cache[key] = out
        if len(_translate_cache) > 500:
            _translate_cache.pop(next(iter(_translate_cache)))
    return out


# -------------------- API endpoints --------------------

def ndjson(items):
    for item in items:
        yield json.dumps(item, ensure_ascii=False) + "\n"


STREAM_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


@app.get("/health")
async def health_check():
    return {
        "status": "error" if model_error else ("ok" if models_ready.is_set() else "loading"),
        "models_ready": models_ready.is_set(),
        "model_error": model_error,
        "models": model_status,
        "device": DEVICE,
        "paper_indexed": retriever is not None,
        "message": "Research Finder API is running.",
    }


@app.post("/models/reload")
def reload_models():
    """Retry model loading after an error."""
    if models_ready.is_set():
        return {"status": "ok"}
    for info in model_status.values():
        if info["state"] == "error":
            info["state"] = "waiting"
    threading.Thread(target=load_models, daemon=True).start()
    return {"status": "loading"}


@app.get("/logs")
async def get_logs(after: int = 0):
    with log_lock:
        rows = [row for row in logs if row["id"] > after]
    return {"logs": rows, "next": rows[-1]["id"] if rows else after}


@app.get("/events")
async def get_events(run: str, after: int = 0):
    with log_lock:
        rows = [e for e in events if e["run"] == run and e["id"] > after]
    return {"events": rows, "next": rows[-1]["id"] if rows else after}


@app.get("/system/status")
def system_status(model: str = DEFAULT_OLLAMA_MODEL):
    hw = hardware_info()
    return {
        "hardware": hw,
        "recommended": recommend_model(hw),
        "default_model": DEFAULT_OLLAMA_MODEL,
        "ollama": ollama_status(model),
    }


@app.post("/ollama/pull")
def ollama_pull(request: PullRequest):
    add_log(f"Downloading Ollama model {request.model}...")
    return StreamingResponse(
        ndjson(pull_model(request.model)), media_type="application/x-ndjson", headers=STREAM_HEADERS
    )


@app.post("/research")
async def run_research(request: ResearchRequest):
    global result, selected_paper, chunks, vector_store, retriever, current_run
    require_models()
    run_id = request.run_id or uuid.uuid4().hex
    current_run = run_id
    add_log(f"Research started: {request.idea}")
    try:
        new_result = await graph.ainvoke(
            {
                "idea": request.idea,
                "settings": request.settings.model_dump(),
                "run_id": run_id,
                "summary": "",
                "titles": [],
                "search_results": [],
                "papers": [],
                "final_results": [],
            }
        )
        result = new_result
        selected_paper = None
        chunks = []
        vector_store = None
        retriever = None
        add_log("Research completed successfully.")
        emit(run_id, "done")
        return {
            "summary": result["summary"],
            "titles": result["titles"],
            "papers": result["final_results"],
        }
    except Exception as exc:
        add_log(f"Research failed: {exc}", "ERROR")
        emit(run_id, "failed", error=str(exc)[:300])
        raise HTTPException(status_code=500, detail=f"Research failed: {exc}") from exc


@app.post("/paper")
async def get_paper(request: RankRequest):
    paper = find_paper(request.rank)
    return {
        "Rank": paper["Rank"],
        "title": paper.get("title", ""),
        "Paper_URL": paper.get("link", ""),
        "PDF_URL": paper.get("pdf_url", ""),
    }


@app.get("/paper/pdf")
async def paper_pdf(rank: int):
    """Serve the paper PDF from our own origin so the iframe is never blocked."""
    paper = find_paper(rank)
    if not paper.get("pdf_url", ""):
        raise HTTPException(status_code=400, detail="PDF URL is not available.")
    try:
        pdf_bytes = await asyncio.to_thread(get_pdf_bytes, paper)
    except Exception as exc:
        add_log(f"PDF proxy failed for rank {rank}: {exc}", "ERROR")
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="paper.pdf"', "Cache-Control": "private, max-age=3600"},
    )


@app.post("/paper/process")
async def process_selected_paper(request: RankRequest):
    require_models()
    paper = find_paper(request.rank)
    run = request.run_id

    if not paper.get("pdf_url", ""):
        raise HTTPException(status_code=400, detail="PDF URL is not available.")

    add_log(f"Downloading PDF for rank {request.rank}: {paper.get('title', '')}", run=run)
    emit(run, "pdf_download", state="running")
    try:
        t0 = time.time()
        pdf_bytes = await asyncio.to_thread(get_pdf_bytes, paper)
        emit(run, "pdf_download", state="done", size_mb=round(len(pdf_bytes) / 1024 / 1024, 1), seconds=round(time.time() - t0, 1))
        add_log(f"PDF downloaded ({len(pdf_bytes) / 1024 / 1024:.1f} MB) in {time.time() - t0:.1f}s.", run=run)
        return await index_pdf(paper, pdf_bytes, run)
    except Exception as exc:
        add_log(f"PDF processing failed: {exc}", "ERROR", run=run)
        emit(run, "pdf_failed", error=str(exc)[:300])
        raise HTTPException(status_code=500, detail=f"Failed to download or process the PDF: {exc}") from exc


@app.post("/paper/upload")
async def upload_paper(file: UploadFile = File(...), run_id: str = ""):
    """Use your own PDF instead of a search result."""
    require_models()
    pdf_bytes = await file.read(MAX_PDF_BYTES + 1)
    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF is larger than the 50 MB limit.")
    if b"%PDF-" not in pdf_bytes[:1024]:
        raise HTTPException(status_code=400, detail="That file is not a PDF.")
    title = re.sub(r"\.pdf$", "", file.filename or "Uploaded PDF", flags=re.I) or "Uploaded PDF"
    paper = {"Rank": 0, "title": title, "pdf_url": "", "uploaded": True}
    add_log(f"Processing uploaded PDF: {title}", run=run_id)
    emit(run_id, "pdf_download", state="done", size_mb=round(len(pdf_bytes) / 1024 / 1024, 1), seconds=0)
    try:
        return await index_pdf(paper, pdf_bytes, run_id)
    except Exception as exc:
        add_log(f"PDF processing failed: {exc}", "ERROR", run=run_id)
        emit(run_id, "pdf_failed", error=str(exc)[:300])
        raise HTTPException(status_code=500, detail=f"Failed to process the PDF: {exc}") from exc


@app.post("/ask/stream")
def ask_stream(request: AskRequest):
    """Deep agent. Streams one JSON event per line (see agent.py)."""
    if not chunks or retriever is None:
        raise HTTPException(status_code=400, detail="Process a paper PDF before asking questions.")
    active_retriever = retriever
    title = (selected_paper or {}).get("title", "")
    add_log(f"Agent question: {request.question}")

    def logged_events():
        names = {}
        for event in run_agent(request.question, request.history, request.settings, active_retriever, title):
            kind = event.get("type")
            if kind == "tool_call":
                names[event.get("id")] = event.get("name")
                where = "paper (retrieval)" if event.get("name") == "rag_search" else "web"
                add_log(f"Agent searches the {where}: \"{event.get('query', '')}\"")
            elif kind == "tool_result":
                hits = event.get("hits") or []
                if event.get("error"):
                    add_log(f"Agent tool {event.get('name')} failed: {event['error']}", "ERROR")
                elif event.get("name") == "rag_search":
                    pages = sorted({h.get("page") for h in hits if h.get("page") is not None})
                    add_log(f"Retrieved {len(hits)} passages from pages {pages} in {event.get('seconds')}s.")
                else:
                    add_log(f"Web search returned {len(hits)} results in {event.get('seconds')}s.")
            elif kind == "answer":
                add_log(f"Agent answered in {event.get('seconds')}s.")
            elif kind == "error":
                add_log(f"Agent error: {event.get('message')}", "ERROR")
            yield event

    return StreamingResponse(
        ndjson(logged_events()),
        media_type="application/x-ndjson",
        headers=STREAM_HEADERS,
    )


@app.post("/translate")
async def translate(request: TranslateRequest):
    try:
        return await asyncio.to_thread(do_translate, request)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# -------------------- Optional: serve the built UI (desktop app / single-port mode) --------------------
# Set RF_STATIC_DIR to the folder produced by `npm run build`. The UI then lives on the same port as the
# API, and the browser's "/api/..." calls are mapped to the normal routes.
_STATIC_DIR = os.environ.get("RF_STATIC_DIR", "")
if _STATIC_DIR and os.path.isdir(_STATIC_DIR):
    from fastapi.staticfiles import StaticFiles

    class _StripApiPrefix:
        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            if scope["type"] in ("http", "websocket") and scope["path"].startswith("/api/"):
                scope = dict(scope)
                scope["path"] = scope["path"][4:]
                scope["raw_path"] = scope["path"].encode()
            await self.inner(scope, receive, send)

    app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="ui")
    app.add_middleware(_StripApiPrefix)


# -------------------- Entry point --------------------

if __name__ == "__main__":
    try:
        asyncio.get_running_loop()
        in_notebook = True  # Colab / Jupyter already run an event loop.
    except RuntimeError:
        in_notebook = False

    if in_notebook:
        server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info"))
        threading.Thread(target=lambda: asyncio.run(server.serve()), daemon=True).start()
        print("FastAPI server is starting on port 8000...")
    else:
        uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
