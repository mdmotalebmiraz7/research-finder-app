import { useEffect, useRef, useState } from 'react';
import { Languages, Loader2, MessageSquare, ScrollText, Settings as SettingsIcon, Square, Upload, X } from 'lucide-react';
import './App.css';
import './panels.css';
import { API, engineLabel, loadSettings, postJSON, saveSettings, searchLabel, streamNDJSON } from './api';
import { AgentMessage, applyAgentEvent, newAgentMessage } from './AgentTrace';
import ResearchProgress from './ResearchProgress';
import { LogDrawer, ModelBanner, PdfProgress } from './Activity';
import SettingsModal from './Settings';
import Translator from './Translator';

const EXAMPLE = 'AI-based fault detection in electrical power systems';
const MAX_UPLOAD = 50 * 1024 * 1024;

function cleanUrl(value) {
  if (!value) return '';
  const m = value.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/);
  return m ? m[1] : value;
}

const isTyping = el => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export default function App() {
  const [page, setPage] = useState('Discover');
  const [idea, setIdea] = useState(EXAMPLE);
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState('Checking…');
  const [health, setHealth] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const [pdfEvents, setPdfEvents] = useState([]);
  const [system, setSystem] = useState(null);
  const [pull, setPull] = useState({ running: false, pct: 0, text: '', error: '' });
  const [error, setError] = useState('');

  // research run
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState([]);
  const [research, setResearch] = useState(null);
  const [papers, setPapers] = useState([]);
  const [saved, setSaved] = useState([]);

  // reader
  const [selected, setSelected] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [processed, setProcessed] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const [chat, setChat] = useState([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [panels, setPanels] = useState({ chat: true, tr: false });
  const [incoming, setIncoming] = useState(null);
  const [bubble, setBubble] = useState(null);
  const [quick, setQuick] = useState(null);

  const fileRef = useRef(null);
  const pullRef = useRef(false);
  const autoPulled = useRef(new Set());
  const abortRef = useRef(null);
  const messagesRef = useRef(null);

  const togglePanel = key => setPanels(p => ({ ...p, [key]: !p[key] }));
  const openPanel = key => setPanels(p => ({ ...p, [key]: true }));

  // ---------- backend status (keeps polling until the AI models are loaded) ----------
  const healthTimer = useRef(null);
  const checkHealth = async () => {
    try {
      const res = await fetch(`${API}/health`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setHealth(data);
      setStatus(data.status === 'ok' ? 'Connected' : data.status === 'error' ? 'Model error' : 'Loading models…');
      return data.status === 'ok';
    } catch (_) {
      setHealth(null);
      setStatus('Not connected');
      return false;
    }
  };
  useEffect(() => {
    let stop = false;
    const loop = async () => {
      const ready = await checkHealth();
      if (!stop && !ready) healthTimer.current = setTimeout(loop, 2000);
    };
    loop();
    return () => { stop = true; clearTimeout(healthTimer.current); };
  }, []);

  async function retryModels() {
    try { await fetch(`${API}/models/reload`, { method: 'POST' }); } catch (_) { /* shown by health */ }
    clearTimeout(healthTimer.current);
    const loop = async () => { if (!(await checkHealth())) healthTimer.current = setTimeout(loop, 2000); };
    loop();
  }

  const modelsReady = health?.status === 'ok';
  const backendUp = status !== 'Not connected' && status !== 'Checking…';

  async function refreshSystem(model) {
    try {
      const res = await fetch(`${API}/system/status?model=${encodeURIComponent(model)}`);
      if (!res.ok) return null;
      const data = await res.json();
      setSystem(data);
      return data;
    } catch (_) { return null; }
  }

  async function startPull(model) {
    if (pullRef.current || !model) return;
    pullRef.current = true;
    setPull({ running: true, pct: 0, text: `Preparing ${model}…`, error: '' });
    const layers = {};
    let failure = '';
    try {
      await streamNDJSON('/ollama/pull', { model }, ev => {
        if (ev.error) { failure = ev.error; return; }
        if (ev.digest && ev.total) layers[ev.digest] = { total: ev.total, completed: ev.completed || 0 };
        const all = Object.values(layers);
        const total = all.reduce((a, l) => a + l.total, 0);
        const done = all.reduce((a, l) => a + l.completed, 0);
        setPull(p => ({ ...p, text: ev.status || p.text, pct: total ? Math.round((done / total) * 100) : p.pct }));
      });
    } catch (err) { failure = err.message || 'Download failed.'; }
    pullRef.current = false;
    setPull(failure
      ? { running: false, pct: 0, text: '', error: failure }
      : { running: false, pct: 100, text: `${model} is ready.`, error: '' });
    refreshSystem(model);
  }

  // Local engine: check the model and download it automatically when it is missing.
  useEffect(() => {
    if (!backendUp || settings.groq_key.trim()) return;
    const model = settings.ollama_model;
    refreshSystem(model).then(st => {
      if (st && !st.ollama.model_ready && !autoPulled.current.has(model)) {
        autoPulled.current.add(model);
        startPull(model);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUp, settings.groq_key, settings.ollama_model]);

  function saveAllSettings(next) {
    setSettings(next);
    saveSettings(next);
    setShowSettings(false);
  }

  // ---------- research ----------
  async function searchPapers(e) {
    e?.preventDefault();
    setError('');
    if (!idea.trim()) return setError('Enter a research topic first.');
    const runId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}${Math.random()}`;
    setResearch(null); setPapers([]); setEvents([]); setLoading(true);

    let after = 0;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(`${API}/events?run=${runId}&after=${after}`, { cache: 'no-store' });
        const data = await res.json();
        if (data.events?.length) { after = data.next; setEvents(old => [...old, ...data.events]); }
      } catch (_) { /* polling is best effort */ }
      busy = false;
    };
    const timer = setInterval(poll, 700);
    try {
      const data = await postJSON('/research', { idea: idea.trim(), settings, run_id: runId });
      setResearch(data);
      setPapers(data.papers || []);
    } catch (err) {
      setError(err.message || 'Could not search papers.');
    } finally {
      clearInterval(timer);
      busy = false;
      await poll();
      setLoading(false);
    }
  }

  // ---------- reader ----------
  async function loadPdf(paper) {
    setPdfUrl(u => { if (u) URL.revokeObjectURL(u); return ''; });
    setPdfError(''); setPdfLoading(true);
    try {
      const res = await fetch(`${API}/paper/pdf?rank=${paper.Rank}`);
      if (!res.ok) {
        let d = {};
        try { d = await res.json(); } catch (_) { /* ignore */ }
        throw new Error(d.detail || `Download failed (HTTP ${res.status})`);
      }
      setPdfUrl(URL.createObjectURL(await res.blob()));
    } catch (err) { setPdfError(err.message || 'PDF download failed.'); }
    finally { setPdfLoading(false); }
  }

  function resetReader(paper) {
    setSelected(paper); setPage('Reader'); setError('');
    setChat([]); setProcessed(null); setQuestion(''); setPdfEvents([]);
  }

  // Poll the backend's event stream for one PDF-processing run (download → chunks → embeddings).
  function watchRun(runId) {
    let after = 0;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(`${API}/events?run=${runId}&after=${after}`, { cache: 'no-store' });
        const data = await res.json();
        if (data.events?.length) { after = data.next; setPdfEvents(old => [...old, ...data.events]); }
      } catch (_) { /* best effort */ }
      busy = false;
    };
    const timer = setInterval(poll, 600);
    return async () => { clearInterval(timer); busy = false; await poll(); };
  }

  const newRunId = () => (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}${Math.random()}`;

  async function openPaper(paper) {
    resetReader(paper);
    loadPdf(paper);
    setProcessing(true);
    const runId = newRunId();
    const stopWatching = watchRun(runId);
    try {
      await postJSON('/paper', { rank: paper.Rank });
      setProcessed(await postJSON('/paper/process', { rank: paper.Rank, run_id: runId }));
    } catch (err) { setError(err.message || 'Could not process PDF. You can still open the PDF link.'); }
    finally { await stopWatching(); setProcessing(false); }
  }

  async function uploadPdf(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return setError('Please choose a PDF file.');
    if (file.size > MAX_UPLOAD) return setError('The PDF is larger than 50 MB.');
    resetReader({ Rank: 0, title: file.name.replace(/\.pdf$/i, ''), uploaded: true });
    setPdfError(''); setPdfLoading(false);
    setPdfUrl(u => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(file); });
    setProcessing(true);
    const runId = newRunId();
    const stopWatching = watchRun(runId);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API}/paper/upload?run_id=${runId}`, { method: 'POST', body: form });
      let data = {};
      try { data = await res.json(); } catch (_) { /* ignore */ }
      if (!res.ok) throw new Error(data.detail || 'Upload failed.');
      setProcessed(data);
    } catch (err) { setError(err.message || 'Could not process the PDF.'); }
    finally { await stopWatching(); setProcessing(false); }
  }

  async function ask(e, override) {
    e?.preventDefault?.();
    const q = (override ?? question).trim();
    if (!q || asking) return;
    if (!processed) return setError('Wait until the PDF is ready.');
    setQuestion(''); setError('');
    const history = chat.filter(m => m.role === 'user' || m.status === 'done').map(m => ({ role: m.role, text: m.text }));
    setChat(old => [...old, { role: 'user', text: q }, newAgentMessage()]);
    setAsking(true);
    const update = fn => setChat(old => {
      const copy = [...old];
      copy[copy.length - 1] = fn(copy[copy.length - 1]);
      return copy;
    });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamNDJSON('/ask/stream', { question: q, settings, history }, ev => update(m => applyAgentEvent(m, ev)), controller.signal);
      update(m => (m.status === 'running' ? { ...m, status: 'error', error: 'The agent stopped without an answer.' } : m));
    } catch (err) {
      update(m => ({ ...m, status: 'error', error: err.name === 'AbortError' ? 'Stopped.' : (err.message || 'Could not answer.') }));
    } finally { setAsking(false); abortRef.current = null; }
  }

  function askAbout(text) {
    openPanel('chat');
    ask(null, `Explain "${text}" in the context of this paper.`);
  }

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  // Keyboard: C toggles the chat window, T the translator (Reader page only).
  useEffect(() => {
    const onKey = e => {
      if (page !== 'Reader' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'c') togglePanel('chat');
      if (k === 't') togglePanel('tr');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page]);

  // ---------- select text anywhere marked .translatable ----------
  useEffect(() => {
    const check = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() || '';
      if (!text || text.length > 500 || !sel.rangeCount) return setBubble(null);
      const node = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      if (!node?.closest?.('.translatable')) return setBubble(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const below = rect.top < 60;
      setBubble({ text, x: Math.min(Math.max(rect.left + rect.width / 2, 70), window.innerWidth - 70), y: below ? rect.bottom + 8 : rect.top - 8, below });
    };
    const onUp = () => setTimeout(check, 10);
    const onDown = e => {
      if (!e.target.closest?.('.sel-bubble, .quick-card')) { setBubble(null); setQuick(null); }
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    document.addEventListener('keyup', onUp);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('keyup', onUp);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  async function translateSelection() {
    const { text, x, y, below } = bubble;
    setBubble(null);
    if (page === 'Reader') {
      openPanel('tr');
      setIncoming({ text, n: Date.now() });
      return;
    }
    // Other pages have no translator window: show a small popup with the translation.
    setQuick({ text, x, y, below, loading: true });
    try {
      const data = await postJSON('/translate', { text, target: settings.target_lang, settings });
      setQuick(q => q && { ...q, loading: false, data });
    } catch (err) { setQuick(q => q && { ...q, loading: false, error: err.message }); }
  }

  function toggleSave(paper) {
    setSaved(old => (old.some(p => p.title === paper.title) ? old.filter(p => p.title !== paper.title) : [...old, paper]));
  }

  const chatStatus = processing ? 'Preparing…' : processed ? 'Ready' : 'Not processed';
  const openSettings = () => { setShowSettings(true); refreshSystem(settings.ollama_model); };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setPage('Discover')}>
          <span className="brand-icon">R</span>
          <span className="brand-copy">Research Finder<small>by Md Miraz Ali</small></span>
        </button>
        <nav>
          <button className={page === 'Discover' ? 'nav active' : 'nav'} onClick={() => setPage('Discover')}>Discover</button>
          <button className={page === 'Library' ? 'nav active' : 'nav'} onClick={() => setPage('Library')}>Saved papers <span className="count">{saved.length}</span></button>
        </nav>
        <button className="key-settings" onClick={() => setShowLogs(v => !v)}><ScrollText size={13} /> Logs</button>
        <button className="key-settings" onClick={openSettings}><SettingsIcon size={13} /> Settings</button>
        <div className="status"><i className={status === 'Connected' ? 'dot good' : status === 'Model error' || status === 'Not connected' ? 'dot bad' : 'dot'} /><span>{status}</span></div>
      </header>

      {(pull.running || pull.error) && (
        <div className={pull.error ? 'banner err' : 'banner'}>
          {pull.running
            ? <><Loader2 size={15} className="spin" /><span>Downloading local model <b>{settings.ollama_model}</b>: {pull.text}{pull.pct > 0 ? ` · ${pull.pct}%` : ''}</span><div className="bar"><i style={{ width: `${Math.max(pull.pct, 3)}%` }} /></div></>
            : <span>{pull.error}</span>}
          <button onClick={openSettings}>Settings</button>
          {pull.error && <button className="icon-btn" onClick={() => setPull(p => ({ ...p, error: '' }))} aria-label="Dismiss"><X size={14} /></button>}
        </div>
      )}

      {backendUp && !modelsReady && <ModelBanner health={health} onRetry={retryModels} />}
      {status === 'Not connected' && (
        <div className="banner err"><span>The backend is not reachable. Check that it is running on port 8000 (see backend.log).</span></div>
      )}

      {error && <div className="error"><span>{error}</span><button onClick={() => setError('')}>×</button></div>}

      <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden
        onChange={e => { uploadPdf(e.target.files?.[0]); e.target.value = ''; }} />

      {page === 'Discover' && (
        <main className="content">
          <div className="intro">
            <p className="eyebrow">RESEARCH WORKSPACE</p>
            <h1>Find relevant research papers.</h1>
            <p>Search papers, rank them, then read and chat with an AI agent that searches the paper and the web. Or upload your own PDF.</p>
          </div>
          <form className="search-panel" onSubmit={searchPapers}>
            <label htmlFor="topic">Research topic</label>
            <textarea id="topic" rows="2" value={idea} onChange={e => setIdea(e.target.value)} placeholder="Describe your research idea..." />
            <div className="form-bottom">
              <p className="key-hint">AI: <b>{engineLabel(settings)}</b> · Search: <b>{searchLabel(settings)}</b>
                <button type="button" onClick={openSettings}>Change in Settings</button></p>
              <div className="search-actions">
                <button type="button" className="ghost" onClick={() => fileRef.current?.click()}><Upload size={14} /> Upload PDF</button>
                <button className="primary" disabled={loading || !modelsReady} title={modelsReady ? '' : 'Waiting for the AI models to load'}>{loading ? 'Searching…' : modelsReady ? 'Search papers' : 'Loading models…'}</button>
              </div>
            </div>
          </form>

          {(loading || events.length > 0) && <ResearchProgress events={events} loading={loading} fallback={research} error="" />}

          <div className="results-heading">
            <div><h2>Ranked papers</h2><p>{papers.length ? `${papers.length} papers found` : 'Your search results will appear here.'}</p></div>
          </div>
          <div className="paper-list">
            {papers.map((paper, i) => (
              <article className="paper-card" key={`${paper.Rank}-${paper.title}`}>
                <div className="rank">{paper.Rank || i + 1}</div>
                <div className="paper-info">
                  <h3 className="translatable">{paper.title}</h3>
                  <div className="paper-meta">
                    <span>{paper.year || 'Year unavailable'}</span>
                    <span>Relevance {typeof paper.Semantic === 'number' ? paper.Semantic.toFixed(2) : '—'}</span>
                  </div>
                  <p className="translatable">{paper.abstract || 'No abstract available.'}</p>
                  <div className="paper-actions">
                    <button className="primary small" onClick={() => openPaper(paper)}>Open reader</button>
                    <a href={cleanUrl(paper.url || paper.link)} target="_blank" rel="noreferrer">Abstract ↗</a>
                    <button className="save" onClick={() => toggleSave(paper)}>{saved.some(p => p.title === paper.title) ? 'Saved ✓' : 'Save paper'}</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </main>
      )}

      {page === 'Reader' && (
        <main className="reader-page">
          <div className="reader-heading">
            <button className="back" onClick={() => setPage('Discover')}>← Back to papers</button>
            <div>
              <h1>{selected?.title || 'Paper reader'}</h1>
              <p>{processing ? 'Preparing the paper for the agent…' : processed ? `PDF ready · ${processed.total_pages} pages · ${processed.total_chunks} chunks` : 'PDF preview and research agent'}</p>
            </div>
            <div className="reader-actions">
              <button className="back" onClick={() => fileRef.current?.click()}><Upload size={12} /> Upload PDF</button>
              {selected?.pdf_url && <a className="external" href={cleanUrl(selected.pdf_url)} target="_blank" rel="noreferrer">Open PDF ↗</a>}
            </div>
          </div>

          <div className="reader-stage">
            <section className="pdf-panel">
              <div className="panel-title">PDF READER <small className="hint">Chat: C · Translate: T</small></div>
              {pdfLoading ? <div className="empty">Downloading the full PDF… this can take a few seconds.</div>
                : pdfUrl ? <iframe title="Research paper PDF" src={pdfUrl} />
                : pdfError ? (
                  <div className="empty">
                    <p>PDF could not be downloaded: {pdfError}</p>
                    <button className="primary small" onClick={() => loadPdf(selected)}>Retry</button>{' '}
                    <a className="external" href={cleanUrl(selected?.pdf_url)} target="_blank" rel="noreferrer">Open PDF ↗</a>
                  </div>
                ) : selected?.pdf_url ? <div className="empty">Preparing…</div>
                : <div className="empty">Select a paper from Discover or upload a PDF.</div>}
            </section>

            <aside className={panels.chat ? 'dock open' : 'dock'} aria-hidden={!panels.chat}>
              <div className="dock-inner">
                <div className="panel-title">
                  <span className="panel-name"><MessageSquare size={14} /> RESEARCH AGENT <span className={processed ? 'ready' : 'not-ready'}>{chatStatus}</span></span>
                  <button type="button" className="icon-btn" onClick={() => togglePanel('chat')} aria-label="Hide chat" title="Hide (C)"><X size={16} /></button>
                </div>
                <div className="chat-messages" ref={messagesRef}>
                  <PdfProgress events={pdfEvents} processing={processing} />
                  {!chat.length && (
                    <div className="chat-empty">
                      <div className="chat-symbol">✦</div>
                      <h3>Ask about this paper</h3>
                      <p>The agent searches the paper (and the web when needed) and shows every step.</p>
                      <div className="suggestions">
                        <button onClick={() => setQuestion('Summarize the main findings.')}>Summarize the main findings</button>
                        <button onClick={() => setQuestion('What method does this paper propose?')}>Explain the proposed method</button>
                        <button onClick={() => setQuestion('What are the limitations? Is there newer work that addresses them?')}>Limitations and newer work (uses web search)</button>
                      </div>
                    </div>
                  )}
                  {chat.map((m, i) => m.role === 'user'
                    ? <div className="message user" key={i}><span>You</span><p className="translatable">{m.text}</p></div>
                    : <AgentMessage m={m} key={i} />)}
                </div>
                <form className="chat-form" onSubmit={ask}>
                  <textarea rows="2" value={question} onChange={e => setQuestion(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(e); } }}
                    placeholder="Ask a question about this paper…" />
                  {asking
                    ? <button type="button" className="primary stop" onClick={() => abortRef.current?.abort()}><Square size={12} /> Stop</button>
                    : <button className="primary" disabled={!question.trim()}>Send ↑</button>}
                </form>
                <p className="privacy-note">{engineLabel(settings)} · search: {searchLabel(settings)}</p>
              </div>
            </aside>

            <aside className={panels.tr ? 'dock open' : 'dock'} aria-hidden={!panels.tr}>
              <div className="dock-inner">
                <Translator settings={settings} paperTitle={selected?.title} incoming={incoming} active={page === 'Reader' && panels.tr}
                  onAsk={askAbout} onClose={() => togglePanel('tr')} />
              </div>
            </aside>

            <nav className="dock-rail" aria-label="Side windows">
              <button className={panels.chat ? 'on' : ''} onClick={() => togglePanel('chat')} title="Chat (C)"><MessageSquare size={16} /><span>Chat</span></button>
              <button className={panels.tr ? 'on' : ''} onClick={() => togglePanel('tr')} title="Translator (T)"><Languages size={16} /><span>Translate</span></button>
            </nav>
          </div>
        </main>
      )}

      {page === 'Library' && (
        <main className="content">
          <div className="intro"><p className="eyebrow">YOUR LIBRARY</p><h1>Saved papers.</h1><p>Keep track of papers you want to read later.</p></div>
          {!saved.length
            ? <div className="empty-library">No saved papers yet. Find a paper and click “Save paper”.</div>
            : (
              <div className="paper-list">
                {saved.map((paper, i) => (
                  <article className="paper-card" key={paper.title}>
                    <div className="rank">{i + 1}</div>
                    <div className="paper-info">
                      <h3>{paper.title}</h3>
                      <div className="paper-meta"><span>{paper.year || 'Year unavailable'}</span></div>
                      <p>{paper.abstract || 'No abstract available.'}</p>
                      <div className="paper-actions">
                        <button className="primary small" onClick={() => openPaper(paper)}>Open reader</button>
                        <button className="save" onClick={() => toggleSave(paper)}>Remove</button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
        </main>
      )}

      <footer>
        <strong>Research Finder</strong> <span>·</span> AI-assisted literature discovery
        <div className="creator-credit">Created by <strong>Md Miraz Ali</strong> · Dhaka University · EEE Department</div>
      </footer>

      {bubble && (
        <button className={bubble.below ? 'sel-bubble below' : 'sel-bubble'} style={{ left: bubble.x, top: bubble.y }}
          onMouseDown={e => e.preventDefault()} onClick={translateSelection}>
          <Languages size={13} /> Translate
        </button>
      )}

      {quick && (
        <div className={quick.below ? 'quick-card below' : 'quick-card'} style={{ left: quick.x, top: quick.y }}>
          <button className="icon-btn" onClick={() => setQuick(null)} aria-label="Close"><X size={14} /></button>
          <small>{quick.text.length > 80 ? `${quick.text.slice(0, 80)}…` : quick.text}</small>
          {quick.loading && <p><Loader2 size={14} className="spin" /> Translating…</p>}
          {quick.data && <p className="tr-main small">{quick.data.translation}</p>}
          {quick.data?.dictionary?.meanings?.[0] && <p className="quick-def">{quick.data.dictionary.meanings[0].part}: {quick.data.dictionary.meanings[0].definitions[0]}</p>}
          {quick.error && <p className="tr-error">{quick.error}</p>}
        </div>
      )}

      <LogDrawer open={showLogs} onClose={() => setShowLogs(false)} />

      {showSettings && (
        <SettingsModal settings={settings} system={system} pull={pull}
          onSave={saveAllSettings} onClose={() => setShowSettings(false)} onPull={startPull} />
      )}
    </div>
  );
}
