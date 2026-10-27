import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Circle, Loader2, RefreshCw, ScrollText, X } from 'lucide-react';
import { API } from './api';

const fmtTime = iso => { try { return new Date(iso).toLocaleTimeString(); } catch (_) { return ''; } };

function StateIcon({ state }) {
  if (state === 'done' || state === 'ready') return <span className="rp-icon done"><Check size={13} strokeWidth={3} /></span>;
  if (state === 'running' || state === 'loading') return <span className="rp-icon running"><Loader2 size={14} className="spin" /></span>;
  if (state === 'fail' || state === 'error') return <span className="rp-icon fail"><AlertTriangle size={13} /></span>;
  return <span className="rp-icon"><Circle size={10} /></span>;
}

function LogLines({ lines, empty }) {
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines.length]);
  if (!lines.length) return <p className="log-empty">{empty}</p>;
  return (
    <div className="log-lines" ref={box}>
      {lines.map((l, i) => (
        <div key={l.id ?? i} className={`rp-log ${String(l.level).toLowerCase()}`}>
          <span>{fmtTime(l.time || l.t)}</span>
          <b>{l.level}</b>
          <span>{l.message}</span>
        </div>
      ))}
    </div>
  );
}

// Polls GET /logs while `active` is true and returns the newest lines.
export function useBackendLogs(active, intervalMs = 1500) {
  const [lines, setLines] = useState([]);
  const after = useRef(0);
  useEffect(() => {
    if (!active) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${API}/logs?after=${after.current}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!stop && data.logs?.length) {
          after.current = data.next;
          setLines(old => [...old, ...data.logs].slice(-300));
        }
      } catch (_) { /* best effort */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { stop = true; clearInterval(id); };
  }, [active, intervalMs]);
  return lines;
}

// ---------- banner shown while the ranking/embedding models load ----------
export function ModelBanner({ health, onRetry }) {
  const loading = health?.status === 'loading';
  const failed = health?.status === 'error';
  const lines = useBackendLogs(loading || failed, 1200);
  if (!health || health.status === 'ok') return null;
  const models = Object.values(health.models || {});
  return (
    <section className={failed ? 'model-banner err' : 'model-banner'} aria-live="polite">
      <header>
        {failed ? <AlertTriangle size={16} /> : <Loader2 size={16} className="spin" />}
        <strong>{failed ? 'AI models could not be loaded' : 'Loading AI models…'}</strong>
        <span className="mb-sub">{failed ? health.model_error : 'The first start downloads them, so it can take a few minutes. Search unlocks when both are ready.'}</span>
        {failed && <button type="button" className="ghost small" onClick={onRetry}><RefreshCw size={12} /> Retry</button>}
      </header>
      <ul className="model-steps">
        {models.map(m => (
          <li key={m.name} className={m.state}>
            <StateIcon state={m.state} />
            <span className="ms-name">{m.label} <small>{m.name}</small></span>
            <span className="ms-state">
              {m.state === 'waiting' && 'waiting'}
              {m.state === 'loading' && `loading… ${Math.round(m.seconds || 0)}s`}
              {m.state === 'ready' && `ready · ${m.seconds}s`}
              {m.state === 'error' && 'failed'}
            </span>
          </li>
        ))}
      </ul>
      <LogLines lines={lines.slice(-6)} empty="Waiting for backend log…" />
    </section>
  );
}

// ---------- PDF steps: download → chunk → embed → ready ----------
function buildPdfModel(events) {
  const m = { download: null, extract: null, embed: null, done: null, failed: '', logs: [] };
  for (const e of events) {
    if (e.kind === 'pdf_download') m.download = e;
    else if (e.kind === 'pdf_extract') m.extract = e;
    else if (e.kind === 'pdf_embed') m.embed = e;
    else if (e.kind === 'pdf_done') m.done = e;
    else if (e.kind === 'pdf_failed') m.failed = e.error;
    else if (e.kind === 'log') m.logs.push(e);
  }
  return m;
}

export function PdfProgress({ events, processing }) {
  if (!processing && !events.length) return null;
  const m = buildPdfModel(events);
  const st = (e, fallbackRunning) => (e ? e.state : (processing && fallbackRunning ? 'running' : 'pending'));
  const downloadState = st(m.download, true);
  const extractState = m.failed && !m.extract ? 'fail' : st(m.extract, downloadState === 'done');
  const embedState = m.failed && m.extract?.state === 'done' && !m.done ? 'fail' : st(m.embed, extractState === 'done');
  const allDone = !!m.done;
  return (
    <section className="pdf-progress" aria-live="polite">
      <header>
        {allDone ? <span className="live-indicator ok" /> : m.failed ? <span className="live-indicator failed" /> : <span className="live-indicator running" />}
        <strong>{allDone ? 'Paper is ready for questions' : m.failed ? 'Processing failed' : 'Preparing the paper'}</strong>
      </header>
      <ol className="pp-steps">
        <li className={downloadState}><StateIcon state={downloadState} /><span>Get the PDF</span>
          <small>{m.download?.state === 'done' ? `${m.download.size_mb} MB` : ''}</small></li>
        <li className={extractState}><StateIcon state={extractState} /><span>Read text and split into chunks</span>
          <small>{m.extract?.state === 'done' ? `${m.extract.pages} pages → ${m.extract.chunks} chunks` : ''}</small></li>
        <li className={embedState}><StateIcon state={embedState} /><span>Embed chunks (retrieval index)</span>
          <small>{m.embed?.state === 'done' ? `${m.embed.seconds}s` : ''}</small></li>
      </ol>
      {m.failed && <p className="rp-error">{m.failed}</p>}
      {m.logs.length > 0 && (
        <details className="rp-raw" open={!allDone}>
          <summary>Log ({m.logs.length})</summary>
          <LogLines lines={m.logs.map(l => ({ ...l, time: l.t }))} empty="" />
        </details>
      )}
    </section>
  );
}

// ---------- floating backend log drawer ----------
export function LogDrawer({ open, onClose }) {
  const lines = useBackendLogs(open, 1500);
  const [onlyProblems, setOnlyProblems] = useState(false);
  if (!open) return null;
  const shown = onlyProblems ? lines.filter(l => l.level !== 'INFO') : lines;
  return (
    <aside className="log-drawer" role="dialog" aria-label="Backend log">
      <header>
        <span><ScrollText size={14} /> Backend log</span>
        <label className="ld-filter"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} /> warnings / errors only</label>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close log"><X size={16} /></button>
      </header>
      <LogLines lines={shown} empty="No log lines yet." />
    </aside>
  );
}
