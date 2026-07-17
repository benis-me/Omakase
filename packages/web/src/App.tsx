import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type DashboardState, type RunDetail, type RunEvent, type RunOptions, type RunSummary } from './api.ts';
import { RunView } from './RunView.tsx';
import { Composer } from './Composer.tsx';
import { useTheme } from './useTheme.ts';
import { statusGlyph, relTime, fmtCost, RUNNING } from './format.ts';

type Filter = 'all' | 'running' | 'succeeded' | 'failed';

export function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [railOpen, setRailOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();

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

  // Live stream via SSE + a slow poll for run metadata, past the seq we hold.
  useEffect(() => {
    if (!selected) return;
    const id = selected;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastSeq = 0;
    setDetail(null);

    const poll = async () => {
      try {
        const d = await api.run(id, lastSeq);
        if (!alive) return;
        const top = d.events[d.events.length - 1]?.seq ?? 0;
        if (top > lastSeq) lastSeq = top;
        setDetail((prev) => (prev && prev.run.id === id ? { ...d, events: mergeEvents(prev.events, d.events) } : d));
        if (!RUNNING.has(d.run.status) && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch {
        /* ignore */
      }
    };
    poll();
    timer = setInterval(poll, 2000);

    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/runs/${id}/stream`);
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as RunEvent;
          if (e.seq > lastSeq) lastSeq = e.seq;
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
      /* polling covers it */
    }

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      es?.close();
    };
  }, [selected]);

  const open = (id: string | null) => {
    setSelected(id);
    setRailOpen(false);
  };

  const run = async (opts: RunOptions) => {
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.start(opts);
      open(runId);
      refreshState();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runs = state?.runs ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (filter === 'running' && !RUNNING.has(r.status)) return false;
      if (filter === 'succeeded' && r.status !== 'succeeded') return false;
      if (filter === 'failed' && r.status !== 'failed' && r.status !== 'cancelled') return false;
      if (q && !`${r.title} ${r.workflow}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [runs, filter, query]);

  const groups = useMemo(() => groupBySession(filtered, state), [filtered, state]);

  // j/k / arrows move through the visible list; Enter opens.
  const flat = filtered;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'n' && !e.metaKey && !e.ctrlKey) {
        open(null);
      }
    };
    const step = (d: number) => {
      if (!flat.length) return;
      const i = flat.findIndex((r) => r.id === selected);
      const next = i < 0 ? (d > 0 ? 0 : flat.length - 1) : Math.min(flat.length - 1, Math.max(0, i + d));
      open(flat[next]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, selected]);

  const available = state?.providers.filter((p) => p.available) ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <button className="iconbtn menu-toggle" onClick={() => setRailOpen((o) => !o)} aria-label="Menu">
          ☰
        </button>
        <div className="brand">
          <span className="tick">▍</span>omakase
          <span className="ws">· {state?.workspace.name ?? '…'}</span>
        </div>
        <span className="spacer" />
        <div className="provs">
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
        <button className="iconbtn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
          {theme === 'dark' ? '☾' : '☀'}
        </button>
      </header>

      {error && <div className="errbar">{error}</div>}

      <div className="body">
        <aside className={`rail ${railOpen ? 'mobile-open' : ''}`}>
          <div className="rail-top">
            <button className={`newbtn ${selected === null ? 'active' : ''}`} onClick={() => open(null)}>
              <span className="plus">＋</span> New goal <kbd>n</kbd>
            </button>
            <div className="search">
              <span className="sicon">⌕</span>
              <input placeholder="Search runs…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="filters">
              {(['all', 'running', 'succeeded', 'failed'] as Filter[]).map((f) => (
                <button key={f} className={`filter ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="runlist">
            {groups.map((g) => (
              <div key={g.label}>
                {groups.length > 1 && <div className="sess-label">{g.label}</div>}
                {g.runs.map((r) => (
                  <button key={r.id} className={`runrow ${selected === r.id ? 'active' : ''}`} onClick={() => open(r.id)}>
                    <span className={`dot status-${r.status}`}>{statusGlyph(r.status)}</span>
                    <span className="rr-main">
                      <div className="rr-title">{r.title || r.id}</div>
                      <div className="rr-meta">
                        <span className="wf">{r.workflow}</span>
                        <span>·</span>
                        <span className="tnum">{fmtCost(r.spentCostUsd)}</span>
                        <span>·</span>
                        <span>{relTime(r.updatedAt)}</span>
                      </div>
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 && <div className="empty" style={{ padding: 24, margin: 0 }}>No runs{query || filter !== 'all' ? ' match' : ' yet'}.</div>}
          </div>
        </aside>

        <main className="main">
          {selected && detail ? (
            <RunView detail={detail} onCancel={() => selected && api.cancel(selected)} />
          ) : selected ? (
            <div className="empty">
              <div className="big">◍</div>
              Loading run…
            </div>
          ) : (
            <Composer state={state} busy={busy} onRun={run} />
          )}
        </main>
      </div>
    </div>
  );
}

interface Group {
  label: string;
  runs: RunSummary[];
}

function groupBySession(runs: RunSummary[], state: DashboardState | null): Group[] {
  // A single-run session is just a run — labelling it repeats the title. Only a
  // session that actually gathered a follow-up thread earns a heading; lone runs
  // fall through into one flat, recency-ordered list.
  const titleOf = new Map((state?.sessions ?? []).map((s) => [s.id, s.title]));
  const size = new Map<string, number>();
  for (const r of runs) if (r.sessionId) size.set(r.sessionId, (size.get(r.sessionId) ?? 0) + 1);

  const groups: Group[] = [];
  const index = new Map<string, number>();
  for (const r of runs) {
    const multi = r.sessionId && (size.get(r.sessionId) ?? 0) > 1;
    const key = multi ? r.sessionId! : '~flat';
    let gi = index.get(key);
    if (gi === undefined) {
      gi = groups.length;
      index.set(key, gi);
      groups.push({ label: multi ? titleOf.get(r.sessionId!) || 'Session' : '', runs: [] });
    }
    groups[gi]!.runs.push(r);
  }
  return groups;
}

function mergeEvents(prev: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (!incoming.length) return prev;
  const seen = new Set(prev.map((e) => e.seq));
  const fresh = incoming.filter((e) => !seen.has(e.seq));
  if (!fresh.length) return prev;
  const merged = prev.concat(fresh);
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}
