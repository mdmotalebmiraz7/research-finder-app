"""Deep agent: a small tool-calling loop with two tools, `rag_search` and `web_search`.

`run_agent` is a generator that yields JSON-serialisable events:
    step, token, thought, tool_call, tool_result, answer, error
The API streams them to the browser, which draws them as a live trace.
"""
import time
from collections.abc import Iterator

import requests
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from providers import Settings, get_llm, strip_think

MAX_STEPS = 6
HISTORY_TURNS = 6

SYSTEM_PROMPT = """You are ResearchFinderAI, a research assistant that helps the user understand one academic paper.

You have two tools:
- rag_search(query): searches the text of the opened paper. Use it for anything about what the paper says: method, data, results, limitations, definitions it uses.
- web_search(query): searches the internet. Use it only for background knowledge, newer work, or facts that are not in the paper, or when the user asks for it.

Rules:
- Before answering a question about the paper, call rag_search. You may call tools several times with different, specific queries.
- Never invent what the paper says. If rag_search does not return it, say it is not found in the retrieved text.
- Keep paper facts and general/web knowledge separate. Cite paper facts like (page 4) and web facts with the site name.
- Answer in the same language as the user's question. Start with the direct answer, then explain clearly.
- When you have enough information, stop calling tools and write the final answer."""


class SearchArgs(BaseModel):
    query: str = Field(description="A specific search query.")


def _noop(query: str) -> str:  # schema carrier only; the loop runs the real functions
    return ""


TOOLS = [
    StructuredTool.from_function(
        func=_noop,
        name="rag_search",
        description="Search the opened paper and return the most relevant passages with page numbers.",
        args_schema=SearchArgs,
    ),
    StructuredTool.from_function(
        func=_noop,
        name="web_search",
        description="Search the internet and return result titles, links and snippets.",
        args_schema=SearchArgs,
    ),
]


# -------------------- Tools --------------------

def rag_search(retriever, query: str) -> tuple[str, list[dict]]:
    docs = retriever.invoke(query)
    hits, parts = [], []
    for doc in docs:
        body = doc.page_content.strip()
        if not body:
            continue
        page = doc.metadata.get("page")
        parts.append(f"[page {page}] {body}")
        hits.append({"page": page, "snippet": " ".join(body.split())[:600]})
    return ("\n\n".join(parts) or "No relevant passages found."), hits


def _duckduckgo(query: str, limit: int) -> list[dict]:
    try:
        from ddgs import DDGS
    except ImportError:  # older package name
        from duckduckgo_search import DDGS
    rows = DDGS().text(query, max_results=limit) or []
    return [
        {"title": r.get("title", ""), "url": r.get("href", ""), "snippet": (r.get("body") or "")[:400]}
        for r in rows
    ]


def _tavily(query: str, key: str, limit: int) -> list[dict]:
    response = requests.post(
        "https://api.tavily.com/search",
        headers={"Authorization": f"Bearer {key}"},
        json={"query": query, "max_results": limit},
        timeout=25,
    )
    response.raise_for_status()
    return [
        {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": (r.get("content") or "")[:400]}
        for r in response.json().get("results", [])
    ]


def web_search(settings: Settings, query: str, limit: int = 5) -> tuple[str, list[dict], str]:
    """Tavily when a key is set (DuckDuckGo is then not used), otherwise DuckDuckGo."""
    if settings.search_engine() == "tavily":
        try:
            hits, note = _tavily(query, settings.tavily_key.strip(), limit), "Tavily"
        except Exception as exc:  # bad key / network: fall back so the agent still gets results
            hits, note = _duckduckgo(query, limit), f"Tavily failed ({exc}); used DuckDuckGo instead"
    else:
        hits, note = _duckduckgo(query, limit), "DuckDuckGo"
    text = "\n\n".join(f"[{i}] {h['title']}\n{h['url']}\n{h['snippet']}" for i, h in enumerate(hits, 1))
    return (text or "No results found."), hits, note


# -------------------- Agent loop --------------------

def _stream_step(runner, messages) -> Iterator[dict]:
    """Stream one model call. Yields token events, returns (merged message, tool calls, text)."""
    merged, per_chunk_calls, text = None, [], ""
    for chunk in runner.stream(messages):
        merged = chunk if merged is None else merged + chunk
        per_chunk_calls.extend(getattr(chunk, "tool_calls", None) or [])
        piece = chunk.content if isinstance(chunk.content, str) else ""
        if piece:
            text += piece
            yield {"type": "token", "text": piece}
    calls = list(getattr(merged, "tool_calls", None) or []) or per_chunk_calls
    unique, seen = [], set()
    for call in calls:
        key = call.get("id") or f"{call.get('name')}:{call.get('args')}"
        if key not in seen:
            seen.add(key)
            unique.append(call)
    return merged, unique, text


def _history_messages(history: list[dict]) -> list:
    messages = []
    for item in history[-HISTORY_TURNS:]:
        text = str(item.get("text", "")).strip()
        if not text or item.get("failed"):
            continue
        messages.append(HumanMessage(text) if item.get("role") == "user" else AIMessage(text))
    return messages


def _fallback(llm, question, history, retriever, started) -> Iterator[dict]:
    """Used when the model cannot call tools: search the paper once, then answer."""
    yield {"type": "tool_call", "id": "fallback", "name": "rag_search", "query": question}
    t0 = time.time()
    text, hits = rag_search(retriever, question)
    yield {"type": "tool_result", "id": "fallback", "name": "rag_search", "hits": hits,
           "seconds": round(time.time() - t0, 1), "note": "This model cannot call tools, so the paper was searched directly."}
    messages = [SystemMessage(SYSTEM_PROMPT), *_history_messages(history),
                HumanMessage(f"Passages from the paper:\n{text}\n\nQuestion: {question}")]
    _, _, answer = yield from _stream_step(llm, messages)
    sources = [{"type": "paper", "page": h["page"]} for h in hits]
    yield {"type": "answer", "text": strip_think(answer) or "I could not produce an answer.",
           "sources": sources, "seconds": round(time.time() - started, 1)}


def run_agent(question: str, history: list[dict], settings: Settings, retriever, paper_title: str = "") -> Iterator[dict]:
    started = time.time()
    try:
        llm = get_llm(settings, temperature=0.0)
    except Exception as exc:
        yield {"type": "error", "message": str(exc)}
        return

    try:
        bound = llm.bind_tools(TOOLS)
    except Exception:
        bound = None

    system = SYSTEM_PROMPT + (f"\n\nThe opened paper is titled: {paper_title}" if paper_title else "")
    messages = [SystemMessage(system), *_history_messages(history), HumanMessage(question)]
    sources: list[dict] = []
    done_queries: set[tuple[str, str]] = set()

    try:
        for step in range(1, MAX_STEPS + 1):
            yield {"type": "step", "step": step}
            last_step = step == MAX_STEPS
            if last_step:
                messages.append(HumanMessage("Write the final answer now, using only what you have found."))
            runner = llm if (last_step or bound is None) else bound

            try:
                merged, calls, text = yield from _stream_step(runner, messages)
            except Exception as exc:
                if step == 1 and bound is not None and "tool" in str(exc).lower():
                    yield from _fallback(llm, question, history, retriever, started)
                    return
                raise

            if not calls or last_step:
                answer = strip_think(text)
                if not answer and merged is not None:
                    content = merged.content
                    answer = strip_think(content if isinstance(content, str) else "")
                seen, unique_sources = set(), []
                for s in sources:
                    key = (s["type"], s.get("page") or s.get("url"))
                    if key not in seen:
                        seen.add(key)
                        unique_sources.append(s)
                yield {"type": "answer", "text": answer or "I could not produce an answer.",
                       "sources": unique_sources, "seconds": round(time.time() - started, 1)}
                return

            # The model wants tools: whatever text it streamed was thinking, not the answer.
            yield {"type": "thought", "text": strip_think(text)}
            messages.append(AIMessage(content=text, tool_calls=calls))

            for call in calls:
                name = call.get("name", "")
                query = str((call.get("args") or {}).get("query", "")).strip()
                call_id = call.get("id") or f"call_{step}_{name}"
                yield {"type": "tool_call", "id": call_id, "name": name, "query": query}
                t0 = time.time()
                note, hits = "", []
                try:
                    if (name, query.lower()) in done_queries:
                        result_text = "You already searched this. Use the results you have, or try a different query."
                    elif name == "rag_search":
                        result_text, hits = rag_search(retriever, query)
                    elif name == "web_search":
                        result_text, hits, note = web_search(settings, query)
                    else:
                        raise ValueError(f"Unknown tool '{name}'")
                    done_queries.add((name, query.lower()))
                    for h in hits:
                        if name == "rag_search":
                            sources.append({"type": "paper", "page": h["page"]})
                        else:
                            sources.append({"type": "web", "url": h["url"], "title": h["title"]})
                    yield {"type": "tool_result", "id": call_id, "name": name, "hits": hits,
                           "seconds": round(time.time() - t0, 1), "note": note}
                except Exception as exc:
                    result_text = f"Tool error: {exc}"
                    yield {"type": "tool_result", "id": call_id, "name": name, "hits": [],
                           "seconds": round(time.time() - t0, 1), "error": str(exc)}
                messages.append(ToolMessage(content=result_text[:6000], tool_call_id=call_id))
    except Exception as exc:
        yield {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
