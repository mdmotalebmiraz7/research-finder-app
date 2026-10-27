export const API = '/api';

export const DEFAULT_SETTINGS = {
  groq_key: '',        // empty = use local Ollama
  tavily_key: '',      // empty = use DuckDuckGo
  openalex_key: '',    // optional free key: a bigger daily paper-search budget
  ollama_model: 'qwen3:1.7b',
  target_lang: 'bn',
};

const SETTINGS_KEY = 'research-finder-settings';
const OLD_GROQ_KEY = 'research-finder-groq-key';

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved) return { ...DEFAULT_SETTINGS, ...saved };
    const oldKey = localStorage.getItem(OLD_GROQ_KEY); // keep users who already saved a Groq key
    if (oldKey) return { ...DEFAULT_SETTINGS, groq_key: oldKey };
  } catch (_) { /* storage unavailable */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
}

export function engineLabel(s) {
  return s.groq_key.trim() ? 'Groq (cloud)' : `Ollama · ${s.ollama_model}`;
}

export function searchLabel(s) {
  return s.tavily_key.trim() ? 'Tavily' : 'DuckDuckGo';
}

export async function postJSON(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) throw new Error(data.detail || `Request failed (HTTP ${res.status})`);
  return data;
}

// POST and read a newline-delimited JSON stream, calling onEvent for every line.
export async function streamNDJSON(path, body, onEvent, signal) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch (_) { /* ignore */ }
    throw new Error(data.detail || `Request failed (HTTP ${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) emit(line, onEvent);
    }
  }
  if (buffer.trim()) emit(buffer.trim(), onEvent);
}

function emit(line, onEvent) {
  let event;
  try { event = JSON.parse(line); } catch (_) { return; } // skip a broken line
  onEvent(event);
}
