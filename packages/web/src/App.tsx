import { useEffect, useRef, useState, useCallback } from 'react';
import { api, type DashboardState, type RunDetail, type RunEvent } from './api.ts';

const RUNNING = new Set(['running', 'pending', 'paused']);

export function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState('goal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const refreshState = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refreshState();
    const t = setInterval(refreshState, 3000);
    return () => clearInterval(t);
  }, [refreshState]);

  // Live stream via SSE, with a slow poll to refresh run metadata/reports.
  useEffect(() => {
    if (!selected) return;
    const id = selected;
    let alive = true;
    setDetail(null);

    const poll = async () => {
      try {
        const d = await api.run(id);
        if (!alive) return;
        setDetail((prev) => (prev && prev.run.id === id ? { ...d, events: mergeEvents(prev.events, d.events) } : d));
      } catch {
        /* ignore */
      }
    };
    poll();
    const t = setInterval(poll, 2000);

    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/runs/${id}/stream`);
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as RunEvent;
          setDetail((prev) => (prev ? { ...prev, events: mergeEvents(prev.events, [e]) } : prev));
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
      };
    } catch {
      /* EventSource unavailable — polling covers it */
    }

    return () => {
      alive = false;
      clearInterval(t);
      es?.close();
    };
  }, [selected]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [detail?.events.length]);

  const start = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.start(text.trim(), workflow);
      setText('');
      setSelected(runId);
      refreshState();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const available = state?.providers.filter((p) => p.available) ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          omakase<span className="dim"> · {state?.workspace.name ?? '…'}</span>
        </div>
        <div className="chips">
          {available.length ? (
            available.map((p) => (
              <span key={p.id} className="chip ok" title={p.version ?? ''}>
                {p.id}
              </span>
            ))
          ) : (
            <span className="chip warn">no providers</span>
          )}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="layout">
        <aside className="sidebar">
          <div className="panel">
            <div className="panel-title">New goal</div>
            <textarea
              className="goal-input"
              placeholder="Describe your goal…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') start();
              }}
              rows={3}
            />
            <div className="row">
              <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                {(state?.workflows ?? []).map((w) => (
                  <option key={w.name} value={w.name}>
                    {w.name} · v{w.version}
                  </option>
                ))}
              </select>
              <button className="run-btn" onClick={start} disabled={busy || !text.trim()}>
                {busy ? 'Starting…' : 'Run ▸'}
              </button>
            </div>
            <div className="hint">⌘/Ctrl + Enter to run</div>
          </div>

          <div className="panel scroll">
            <div className="panel-title">Runs</div>
            {(state?.runs ?? []).map((r) => (
              <button
                key={r.id}
                className={`run-item ${selected === r.id ? 'active' : ''}`}
                onClick={() => setSelected(r.id)}
              >
                <span className={`status ${r.status}`}>{statusDot(r.status)}</span>
                <span className="run-title">{r.title || r.id}</span>
                <span className="run-meta">
                  {r.workflow} · ${r.spentCostUsd.toFixed(3)}
                </span>
              </button>
            ))}
            {(state?.runs ?? []).length === 0 && <div className="empty">No runs yet.</div>}
          </div>
        </aside>

        <main className="main">
          {detail ? (
            <RunView detail={detail} onCancel={() => selected && api.cancel(selected)} logRef={logRef} />
          ) : (
            <div className="placeholder">Select a run, or start a new goal.</div>
          )}
        </main>
      </div>
    </div>
  );
}

function RunView({
  detail,
  onCancel,
  logRef,
}: {
  detail: RunDetail;
  onCancel: () => void;
  logRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { run, events } = detail;
  const running = RUNNING.has(run.status);
  return (
    <div className="runview">
      <div className="runhead">
        <div>
          <div className="runtitle">{run.goal.text}</div>
          <div className="runsub">
            <span className={`badge ${run.status}`}>{run.status}</span>
            <span className="dim">
              {' '}
              {run.workflow} · {run.spentAgents} agent(s) · ${run.spentCostUsd.toFixed(4)}
            </span>
          </div>
        </div>
        {running && (
          <button className="cancel-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <div className="log" ref={logRef}>
        {events.map((e) => {
          const l = line(e);
          if (!l) return null;
          return (
            <div key={e.seq} className={`log-line ${l.cls}`} style={{ paddingLeft: (l.indent ?? 0) * 14 + 8 }}>
              {l.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function statusDot(status: string): string {
  return status === 'succeeded' ? '✓' : status === 'failed' ? '✗' : status === 'cancelled' ? '◼' : '●';
}

interface Line {
  text: string;
  cls: string;
  indent?: number;
}

function line(e: RunEvent): Line | null {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'run:started':
      return { text: `❯ ${p.goal?.text ?? ''}`, cls: 'fg' };
    case 'phase:started':
      return { text: `▸ ${p.name}`, cls: 'phase' };
    case 'agent:started':
      return { text: `${p.provider} › ${p.title}`, cls: 'agent', indent: 1 };
    case 'agent:activity':
      return { text: `${p.activity?.kind === 'tool' ? '⚙' : '·'} ${p.activity?.summary ?? ''}`, cls: 'dim', indent: 3 };
    case 'agent:completed':
      return { text: `${p.status === 'ok' ? '✓' : '✗'} ${trim(p.text)}${p.costUsd > 0 ? `  $${p.costUsd.toFixed(4)}` : ''}`, cls: p.status === 'ok' ? 'ok' : 'err', indent: 2 };
    case 'agent:failed':
      return { text: `✗ ${trim(p.error)}`, cls: 'err', indent: 2 };
    case 'goal:evaluated':
      return { text: `goal ${p.verdict?.toUpperCase()}${p.gaps?.length ? ` · ${p.gaps.length} gap(s)` : ''}`, cls: p.verdict === 'met' ? 'ok' : 'warn', indent: 1 };
    case 'harness:switched':
      return { text: `↪ ${p.from} → ${p.to}`, cls: 'warn', indent: 2 };
    case 'user:asked':
      return { text: `? ${p.question}${p.options?.length ? ` [${p.options.join('/')}]` : ''}`, cls: 'fg', indent: 1 };
    case 'user:answered':
      return { text: `↳ ${p.answer}`, cls: 'dim', indent: 2 };
    case 'log':
      return { text: trim(p.message), cls: 'dim', indent: 1 };
    case 'report':
      return p.report?.kind === 'final' ? { text: `✓ ${p.report.title}: ${trim(p.report.summary)}`, cls: 'ok' } : null;
    case 'run:ended':
      return { text: `${p.status === 'succeeded' ? '✓' : '✗'} ${p.status} · ${trim(p.summary)}`, cls: p.status === 'succeeded' ? 'ok' : 'err' };
    default:
      return null;
  }
}

function trim(s: unknown, n = 160): string {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function mergeEvents(prev: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const seen = new Set(prev.map((e) => e.seq));
  const merged = prev.concat(incoming.filter((e) => !seen.has(e.seq)));
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}
