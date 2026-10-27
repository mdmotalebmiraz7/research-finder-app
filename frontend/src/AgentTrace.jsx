import { useState } from 'react';
import { AlertTriangle, BookOpen, Brain, Check, ChevronDown, Globe, Loader2 } from 'lucide-react';

// ---------- state reducer for the streamed agent events ----------
export function newAgentMessage() {
  return { role: 'assistant', status: 'running', items: [], draft: '', text: '', sources: [], seconds: 0, error: '' };
}

export function applyAgentEvent(m, ev) {
  switch (ev.type) {
    case 'token':
      return { ...m, draft: m.draft + ev.text };
    case 'thought': // the streamed text was reasoning before a tool call, not the answer
      return { ...m, draft: '', items: ev.text ? [...m.items, { kind: 'thought', text: ev.text }] : m.items };
    case 'tool_call':
      return { ...m, items: [...m.items, { kind: 'tool', id: ev.id, name: ev.name, query: ev.query, state: 'running', hits: [] }] };
    case 'tool_result':
      return {
        ...m,
        items: m.items.map(it => (it.kind === 'tool' && it.id === ev.id
          ? { ...it, state: ev.error ? 'error' : 'done', hits: ev.hits || [], seconds: ev.seconds, note: ev.note, error: ev.error }
          : it)),
      };
    case 'answer':
      return { ...m, status: 'done', draft: '', text: ev.text, sources: ev.sources || [], seconds: ev.seconds };
    case 'error':
      return { ...m, status: 'error', draft: '', error: ev.message };
    default:
      return m;
  }
}

// ---------- tiny, safe markdown renderer (bold, code, lists, headings) ----------
function inline(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export function renderMd(text) {
  const out = [];
  let list = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{it}</li>);
    out.push(list.ordered ? <ol key={`l${out.length}`}>{items}</ol> : <ul key={`l${out.length}`}>{items}</ul>);
    list = null;
  };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)/);
    const head = line.match(/^#{1,4}\s+(.*)/);
    if (bullet || num) {
      const ordered = !!num;
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push(inline((bullet || num)[1]));
      return;
    }
    flush();
    if (head) out.push(<h4 key={i}>{inline(head[1])}</h4>);
    else if (line.trim()) out.push(<p key={i}>{inline(line)}</p>);
  });
  flush();
  return out;
}

const cleanDraft = text => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
const safeUrl = url => (/^https?:\/\//i.test(url || '') ? url : '#');
const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; } };

// ---------- trace items ----------
function ToolCard({ item }) {
  const [open, setOpen] = useState(false);
  const isRag = item.name === 'rag_search';
  const Icon = isRag ? BookOpen : Globe;
  const label = isRag ? 'Searching the paper' : 'Searching the web';
  const count = item.hits.length;
  return (
    <div className={`trace-tool ${item.state} ${isRag ? 'rag' : 'web'}`}>
      <button type="button" className="trace-tool-head" onClick={() => count && setOpen(o => !o)} disabled={!count}>
        <span className="trace-tool-icon"><Icon size={14} /></span>
        <span className="trace-tool-text">
          <b>{label}</b>
          <em>“{item.query}”</em>
        </span>
        <span className="trace-tool-status">
          {item.state === 'running' && <Loader2 size={14} className="spin" />}
          {item.state === 'done' && <><Check size={13} strokeWidth={3} /> {count} {isRag ? 'passages' : 'results'}{item.seconds != null ? ` · ${item.seconds}s` : ''}</>}
          {item.state === 'error' && <><AlertTriangle size={13} /> failed</>}
        </span>
        {count > 0 && <ChevronDown size={14} className={open ? 'chev open' : 'chev'} />}
      </button>
      {item.note && <div className="trace-note">{item.note}</div>}
      {item.error && <div className="trace-note error">{item.error}</div>}
      {open && (
        <ul className="trace-hits">
          {item.hits.map((h, i) => isRag
            ? <li key={i}><span className="chip">p.{h.page}</span><span>{h.snippet}</span></li>
            : <li key={i}><a href={safeUrl(h.url)} target="_blank" rel="noreferrer">{h.title || h.url}</a><small>{host(h.url)}</small><span>{h.snippet}</span></li>)}
        </ul>
      )}
    </div>
  );
}

function Sources({ sources }) {
  const pages = [...new Set(sources.filter(s => s.type === 'paper' && s.page != null).map(s => s.page))].sort((a, b) => a - b);
  const web = sources.filter(s => s.type === 'web');
  if (!pages.length && !web.length) return null;
  return (
    <div className="sources">
      <b>Sources</b>
      {pages.map(p => <span key={`p${p}`} className="chip">paper p.{p}</span>)}
      {web.map((s, i) => <a key={`w${i}`} className="chip web" href={safeUrl(s.url)} target="_blank" rel="noreferrer">{host(s.url)}</a>)}
    </div>
  );
}

export function AgentMessage({ m }) {
  const running = m.status === 'running';
  const tools = m.items.filter(i => i.kind === 'tool').length;
  const draft = cleanDraft(m.draft);
  return (
    <div className={`message assistant agent ${m.status === 'error' ? 'failed' : ''}`}>
      <span>Research agent{m.seconds ? ` · ${m.seconds}s` : ''}</span>

      {(m.items.length > 0 || running) && (
        <details className="trace" open={running}>
          <summary><Brain size={13} /> Agent trace · {tools} tool call{tools === 1 ? '' : 's'}</summary>
          <div className="trace-list">
            {m.items.map((it, i) => it.kind === 'thought'
              ? <div key={i} className="trace-thought"><Brain size={13} /><span>{it.text}</span></div>
              : <ToolCard key={it.id || i} item={it} />)}
            {running && !draft && <div className="trace-thinking"><Loader2 size={13} className="spin" /> Thinking…</div>}
          </div>
        </details>
      )}

      {running && draft && <div className="md translatable draft">{renderMd(draft)}<i className="caret" /></div>}
      {m.text && <div className="md translatable">{renderMd(m.text)}</div>}
      {m.error && <p className="trace-error">{m.error}</p>}
      <Sources sources={m.sources || []} />
    </div>
  );
}
