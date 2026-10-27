import { useState } from 'react';
import { Check, Cpu, Download, Globe, Languages, Loader2, Search, X, Zap } from 'lucide-react';

export const LANGS = [
  ['bn', 'Bangla'], ['hi', 'Hindi'], ['ur', 'Urdu'], ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'],
  ['de', 'German'], ['zh-CN', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ru', 'Russian'], ['tr', 'Turkish'],
];
const MODELS = ['qwen3:1.7b', 'qwen3:4b', 'qwen3:8b', 'qwen3:14b', 'llama3.2:3b', 'gpt-oss:20b'];

function Chip({ ok, children }) {
  return <span className={ok ? 'set-chip ok' : 'set-chip'}>{ok ? <Check size={11} strokeWidth={3} /> : <X size={11} />}{children}</span>;
}

export default function Settings({ settings, system, pull, onSave, onClose, onPull }) {
  const [draft, setDraft] = useState(settings);
  const set = (key, value) => setDraft(d => ({ ...d, [key]: value }));
  const usingGroq = !!draft.groq_key.trim();
  const ollama = system?.ollama;
  const hw = system?.hardware;
  const modelOptions = [...new Set([...(ollama?.models || []), ...MODELS])];
  const ready = ollama?.model === draft.ollama_model && ollama?.model_ready;

  function submit(e) {
    e.preventDefault();
    onSave({
      groq_key: draft.groq_key.trim(),
      tavily_key: draft.tavily_key.trim(),
      openalex_key: draft.openalex_key.trim(),
      ollama_model: draft.ollama_model.trim() || 'qwen3:1.7b',
      target_lang: draft.target_lang,
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onSubmit={submit}>
        <header className="set-head">
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h2 id="settings-title">AI engine, search and translation</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <section className="set-sec">
          <h3><Zap size={15} /> Language model <span className={usingGroq ? 'set-badge groq' : 'set-badge'}>{usingGroq ? 'Using Groq (cloud)' : 'Using Ollama (local)'}</span></h3>
          <label htmlFor="groq-key">Groq API key <small>optional</small></label>
          <input id="groq-key" type="password" autoComplete="off" value={draft.groq_key} onChange={e => set('groq_key', e.target.value)} placeholder="gsk_…  (leave empty to use the local model)" />
          <p className="set-help">With a Groq key, everything runs on Groq and the local model is not used. Remove the key to go back to Ollama.</p>
        </section>

        <section className={usingGroq ? 'set-sec dim' : 'set-sec'}>
          <h3><Cpu size={15} /> Local model (Ollama){usingGroq && <small> · not used while a Groq key is set</small>}</h3>
          <div className="set-chips">
            <Chip ok={ollama?.installed}>Ollama installed</Chip>
            <Chip ok={ollama?.running}>Running</Chip>
            <Chip ok={ready}>Model downloaded</Chip>
          </div>
          <label htmlFor="ollama-model">Model</label>
          <div className="set-row">
            <input id="ollama-model" list="model-list" value={draft.ollama_model} onChange={e => set('ollama_model', e.target.value)} />
            <datalist id="model-list">{modelOptions.map(m => <option key={m} value={m} />)}</datalist>
            <button type="button" className="primary" disabled={pull.running || ready} onClick={() => onPull(draft.ollama_model.trim())}>
              {pull.running ? <><Loader2 size={14} className="spin" /> Downloading</> : ready ? <><Check size={14} /> Ready</> : <><Download size={14} /> Download</>}
            </button>
          </div>
          {hw && (
            <p className="set-help">
              Your PC: {hw.ram_gb} GB RAM{hw.gpu ? `, GPU ${hw.gpu} (${hw.vram_gb} GB)` : ', no GPU'}. Recommended: <b>{system.recommended}</b>
              {draft.ollama_model !== system.recommended && <> · <button type="button" className="link-btn" onClick={() => set('ollama_model', system.recommended)}>use it</button></>}
            </p>
          )}
          {(pull.running || pull.text || pull.error) && (
            <div className="pull-box">
              {pull.running && <div className="bar"><i style={{ width: `${Math.max(pull.pct, 3)}%` }} /></div>}
              <p className={pull.error ? 'err' : ''}>{pull.error || pull.text}{pull.running && pull.pct > 0 ? ` · ${pull.pct}%` : ''}</p>
            </div>
          )}
          {ollama && !ollama.installed && ollama.platform !== 'Linux' && (
            <p className="set-help warn">Ollama is not installed. <a href={ollama.download_url} target="_blank" rel="noreferrer">Download Ollama ↗</a>, install it, then press Download.</p>
          )}
        </section>

        <section className="set-sec">
          <h3><Globe size={15} /> Web search <span className="set-badge">{draft.tavily_key.trim() ? 'Using Tavily' : 'Using DuckDuckGo'}</span></h3>
          <label htmlFor="tavily-key">Tavily API key <small>optional</small></label>
          <input id="tavily-key" type="password" autoComplete="off" value={draft.tavily_key} onChange={e => set('tavily_key', e.target.value)} placeholder="tvly-…  (leave empty to use DuckDuckGo)" />
          <p className="set-help">DuckDuckGo needs no key. When you add a Tavily key, Tavily replaces DuckDuckGo.</p>
        </section>

        <section className="set-sec">
          <h3><Search size={15} /> Paper search (OpenAlex) <span className="set-badge">{draft.openalex_key.trim() ? 'Using your key' : 'No key'}</span></h3>
          <label htmlFor="openalex-key">OpenAlex API key <small>optional, free</small></label>
          <input id="openalex-key" type="password" autoComplete="off" value={draft.openalex_key} onChange={e => set('openalex_key', e.target.value)} placeholder="Paste your OpenAlex key" />
          <p className="set-help">OpenAlex limits searches per day. Without a key you get a small budget (about 3 research runs a day); a free key gives about 10x more. Get one from your <a href="https://openalex.org/settings/api" target="_blank" rel="noreferrer">OpenAlex account ↗</a>. When OpenAlex refuses, the app falls back to arXiv.</p>
        </section>

        <section className="set-sec">
          <h3><Languages size={15} /> Translation</h3>
          <label htmlFor="lang">Translate into</label>
          <select id="lang" value={draft.target_lang} onChange={e => set('target_lang', e.target.value)}>
            {LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </section>

        <footer className="set-foot">
          <p>Keys are stored in this browser only and sent to your own backend.</p>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Save settings</button>
        </footer>
      </form>
    </div>
  );
}
