import { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, Copy, Languages, Loader2, MessageSquareText, Sparkles, Volume2, X } from 'lucide-react';
import { postJSON } from './api';
import { LANGS } from './Settings';

const HISTORY_KEY = 'research-finder-translations';
const AUTO_KEY = 'research-finder-auto-clipboard';

function readStored(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (_) { return fallback; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
}

export default function Translator({ settings, paperTitle, incoming, active, onAsk, onClose }) {
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(() => readStored(HISTORY_KEY, []));
  const [auto, setAuto] = useState(() => readStored(AUTO_KEY, true));
  const [clipBlocked, setClipBlocked] = useState(false);
  const timer = useRef(null);
  const latest = useRef(0);
  const lastClip = useRef(null);
  const inputRef = useRef('');
  inputRef.current = input;
  const langName = (LANGS.find(([c]) => c === settings.target_lang) || [, settings.target_lang])[1];

  async function run(text, explain = false) {
    const clean = (text || '').trim();
    if (!clean) return;
    const ticket = ++latest.current;
    explain ? setExplaining(true) : setLoading(true);
    setError('');
    try {
      const data = await postJSON('/translate', {
        text: clean.slice(0, 2000), target: settings.target_lang, explain, context: paperTitle || '', settings,
      });
      if (ticket !== latest.current) return; // a newer lookup replaced this one
      setResult(data);
      if (!explain) {
        const next = [data, ...history.filter(h => h.text.toLowerCase() !== data.text.toLowerCase())].slice(0, 15);
        setHistory(next);
        writeStored(HISTORY_KEY, next);
      }
    } catch (err) {
      if (ticket === latest.current) setError(err.message || 'Translation failed.');
    } finally {
      if (ticket === latest.current) { setLoading(false); setExplaining(false); }
    }
  }

  // Text sent from the selection bubble.
  useEffect(() => {
    if (!incoming?.text) return;
    lastClip.current = incoming.text;
    setInput(incoming.text);
    run(incoming.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.n]);

  // Auto-detect text copied from the PDF (Ctrl+C). Needs the browser's clipboard permission.
  useEffect(() => {
    if (!active || !auto || clipBlocked || !navigator.clipboard?.readText) return undefined;
    const poll = async () => {
      if (!document.hasFocus()) return;
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (lastClip.current === null) { lastClip.current = text; return; } // ignore what was copied before
        if (!text || text === lastClip.current) return;
        lastClip.current = text;
        if (text.length > 400 || !/[A-Za-zঀ-৿]/.test(text) || text === inputRef.current.trim()) return;
        setInput(text);
        run(text);
      } catch (_) { setClipBlocked(true); }
    };
    const id = setInterval(poll, 1200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, auto, clipBlocked, settings.target_lang]);

  function onType(e) {
    const value = e.target.value;
    setInput(value);
    clearTimeout(timer.current);
    if (value.trim()) timer.current = setTimeout(() => run(value), 1000);
  }

  function onPaste(e) {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    clearTimeout(timer.current);
    lastClip.current = text.trim();
    setInput(text);
    run(text);
  }

  async function pasteButton() {
    try {
      const text = await navigator.clipboard.readText();
      lastClip.current = text.trim();
      setInput(text);
      run(text);
    } catch (_) { setError('The browser blocked clipboard access. Click the box and press Ctrl+V instead.'); }
  }

  function speak(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (_) { /* not supported */ }
  }

  function copy(text) {
    lastClip.current = text; // do not translate our own copy
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function toggleAuto(value) { setAuto(value); writeStored(AUTO_KEY, value); if (value) setClipBlocked(false); }

  const dict = result?.dictionary;
  return (
    <>
      <div className="panel-title">
        <span className="panel-name"><Languages size={14} /> TRANSLATOR · {langName.toUpperCase()}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Hide translator" title="Hide (T)"><X size={16} /></button>
      </div>

      <div className="tr-body">
        <div className="tr-input">
          <textarea rows="2" value={input} onChange={onType} onPaste={onPaste}
            placeholder="Type or paste a word or sentence…  Select text in the PDF, press Ctrl+C, and it appears here." />
          <div className="tr-input-actions">
            <button type="button" className="ghost small" onClick={pasteButton}><ClipboardPaste size={13} /> Paste</button>
            <button type="button" className="primary small" onClick={() => run(input)} disabled={!input.trim() || loading}>
              {loading ? <Loader2 size={13} className="spin" /> : 'Translate'}
            </button>
          </div>
          <label className="tr-auto">
            <input type="checkbox" checked={auto && !clipBlocked} onChange={e => toggleAuto(e.target.checked)} />
            Translate text I copy (Ctrl+C) automatically
          </label>
          {clipBlocked && <p className="set-help warn">Clipboard access was blocked, so use Paste or Ctrl+V. Allow it from the lock icon in the address bar, then tick the box again.</p>}
        </div>

        {error && <p className="tr-error">{error}</p>}

        {loading && !result && <div className="tr-loading"><Loader2 size={16} className="spin" /> Translating…</div>}

        {result && (
          <div className={`tr-card ${loading ? 'busy' : ''}`}>
            <div className="tr-orig">
              <span>{result.text}</span>
              <button type="button" className="icon-btn" onClick={() => speak(result.text)} aria-label="Pronounce"><Volume2 size={15} /></button>
            </div>
            {dict?.phonetic && <small className="tr-phonetic">{dict.phonetic}</small>}
            <div className="tr-main translatable-off">{result.translation}</div>

            {dict?.meanings?.length > 0 && (
              <div className="tr-meanings">
                {dict.meanings.map((m, i) => (
                  <div key={i}>
                    <span className="chip">{m.part}</span>
                    <ul>
                      {m.definitions.map((d, j) => (
                        <li key={j}>{d}{m.translations?.[j] && <em>{m.translations[j]}</em>}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {result.explanation && (
              <div className="tr-explain">
                <b><Sparkles size={13} /> In this paper</b>
                <p>{result.explanation}</p>
                {result.explanation_translated && <p className="tr-main small">{result.explanation_translated}</p>}
              </div>
            )}
            {result.explanation_error && <p className="tr-error">{result.explanation_error}</p>}

            <div className="tr-actions">
              {!result.explanation && (
                <button type="button" className="ghost small" disabled={explaining} onClick={() => run(result.text, true)}>
                  {explaining ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Explain in context
                </button>
              )}
              <button type="button" className="ghost small" onClick={() => onAsk(result.text)}><MessageSquareText size={13} /> Ask agent</button>
              <button type="button" className="ghost small" onClick={() => copy(result.translation)}><Copy size={13} /> Copy</button>
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="tr-history">
            <div className="tr-history-head">
              <b>Recent</b>
              <button type="button" className="link-btn" onClick={() => { setHistory([]); writeStored(HISTORY_KEY, []); }}>Clear</button>
            </div>
            <div>
              {history.map(h => (
                <button key={h.text} type="button" onClick={() => { setInput(h.text); setResult(h); setError(''); }}>
                  {h.text.length > 34 ? `${h.text.slice(0, 34)}…` : h.text}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
