import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Circle, Loader2 } from 'lucide-react';

// Turn the backend's structured events into one object the UI can draw.
function buildModel(events, fallback) {
  const m = {
    engine: '', model: '', planStarted: false,
    summary: '', titles: [], topics: {},
    unique: null, rankStart: null, rankDone: null,
    done: false, failed: '', start: null, end: null, logs: [],
  };
  for (const e of events) {
    const t = Date.parse(e.t);
    if (m.start === null) m.start = t;
    m.end = t;
    if (e.kind === 'plan_start') { m.planStarted = true; m.engine = e.engine; m.model = e.model; }
    else if (e.kind === 'summary') m.summary = e.summary;
    else if (e.kind === 'topics') m.titles = e.titles;
    else if (e.kind === 'topic_start') m.topics[e.idx] = { state: 'running' };
    else if (e.kind === 'topic_done') m.topics[e.idx] = { state: 'done', found: e.found, kept: e.kept };
    else if (e.kind === 'topic_fail') m.topics[e.idx] = { state: 'fail', error: e.error };
    else if (e.kind === 'collect') m.unique = e.unique;
    else if (e.kind === 'rank_start') m.rankStart = e.candidates;
    else if (e.kind === 'rank_done') m.rankDone = e.count;
    else if (e.kind === 'done') m.done = true;
    else if (e.kind === 'failed') m.failed = e.error;
    else if (e.kind === 'log') m.logs.push(e);
  }
  if (!m.summary && fallback?.summary) m.summary = fallback.summary;
  if (!m.titles.length && fallback?.titles) m.titles = fallback.titles;
  return m;
}

function StateIcon({ state }) {
  if (state === 'done') return <span className="rp-icon done"><Check size={13} strokeWidth={3} /></span>;
  if (state === 'running') return <span className="rp-icon running"><Loader2 size={14} className="spin" /></span>;
  if (state === 'fail') return <span className="rp-icon fail"><AlertTriangle size={13} /></span>;
  return <span className="rp-icon"><Circle size={10} /></span>;
}

function Step({ state, title, right, children }) {
  return (
    <li className={`rp-step ${state}`}>
      <StateIcon state={state} />
      <div className="rp-body">
        <div className="rp-title"><strong>{title}</strong>{right && <span>{right}</span>}</div>
        {children}
      </div>
    </li>
  );
}

export default function ResearchProgress({ events, loading, fallback, error }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!loading) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loading]);

  const m = buildModel(events, fallback);
  const failed = m.failed || error;
  const total = m.titles.length;
  const finished = Object.values(m.topics).filter(t => t.state !== 'running').length;
  const allDone = !loading && !failed && (m.done || fallback);

  const planState = m.summary && total ? 'done' : (failed ? 'fail' : (loading ? 'running' : 'pending'));
  const searchState = total && finished >= total ? 'done' : (total && loading ? 'running' : (failed && total ? 'fail' : 'pending'));
  const mergeState = m.unique !== null ? 'done' : (searchState === 'done' && loading ? 'running' : 'pending');
  const rankState = m.rankDone !== null ? 'done' : (m.rankStart !== null && loading ? 'running' : 'pending');
  const seconds = m.start ? Math.max(0, Math.round(((loading ? now : m.end) - m.start) / 1000)) : 0;

  return (
    <section className="rp" aria-live="polite">
      <header className="rp-head">
        <span className={loading ? 'live-indicator running' : (failed ? 'live-indicator failed' : 'live-indicator ok')} />
        <strong>{loading ? 'Research in progress' : failed ? 'Research failed' : allDone ? 'Research complete' : 'Research activity'}</strong>
        <span className="rp-meta">
          {m.engine && `${m.engine === 'groq' ? 'Groq' : 'Ollama'} · ${m.model}`}{m.start ? ` · ${seconds}s` : ''}
        </span>
      </header>

      <ol className="rp-steps">
        <Step state={planState} title="1. Understanding your idea" right={planState === 'running' ? 'writing summary and topics…' : ''}>
          {m.summary && <div className="rp-summary translatable"><b>Research summary</b><p>{m.summary}</p></div>}
          {total > 0 && (
            <div className="rp-chips translatable">
              {m.titles.map((t, i) => <span key={i} style={{ animationDelay: `${i * 60}ms` }}>{t}</span>)}
            </div>
          )}
        </Step>

        <Step state={searchState} title="2. Searching papers for each topic" right={total ? `${finished}/${total} topics` : ''}>
          {total > 0 && (
            <ul className="rp-topics">
              {m.titles.map((t, i) => {
                const info = m.topics[i];
                const state = info?.state || 'pending';
                return (
                  <li key={i} className={state}>
                    <StateIcon state={state} />
                    <span className="rp-topic-name">{t}</span>
                    <span className="rp-topic-stat">
                      {state === 'done' && `${info.found} found → best ${info.kept} matched to summary`}
                      {state === 'running' && 'searching…'}
                      {state === 'fail' && 'failed, skipped'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Step>

        <Step state={mergeState} title="3. Merging unique papers" right={m.unique !== null ? `${m.unique} unique papers` : ''} />
        <Step state={rankState} title="4. Final ranking by the summary" right={m.rankDone !== null ? `top ${m.rankDone} papers` : (m.rankStart !== null ? `${m.rankStart} candidates` : '')} />
      </ol>

      {failed && <p className="rp-error">{failed}</p>}

      {m.logs.length > 0 && (
        <details className="rp-raw">
          <summary>Raw log ({m.logs.length})</summary>
          <div>
            {m.logs.map((l, i) => (
              <div key={i} className={`rp-log ${l.level.toLowerCase()}`}>
                <span>{new Date(l.t).toLocaleTimeString()}</span>
                <b>{l.level}</b>
                <span>{l.message}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
