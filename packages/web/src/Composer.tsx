import { useState, useRef, useEffect } from 'react';
import type { DashboardState, RunOptions } from './api.ts';

export function Composer({
  state,
  busy,
  onRun,
}: {
  state: DashboardState | null;
  busy: boolean;
  onRun: (opts: RunOptions) => void;
}) {
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState('goal');
  const [provider, setProvider] = useState('');
  const [checks, setChecks] = useState('');
  const [criteria, setCriteria] = useState('');
  const [maxAgents, setMaxAgents] = useState('');
  const [maxUsd, setMaxUsd] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const available = state?.providers.filter((p) => p.available) ?? [];

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    const lines = (s: string) =>
      s
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    onRun({
      text: t,
      workflow,
      ...(provider ? { provider } : {}),
      ...(checks.trim() ? { checks: lines(checks) } : {}),
      ...(criteria.trim() ? { criteria: lines(criteria) } : {}),
      ...(maxAgents.trim() ? { maxAgents: Number(maxAgents) } : {}),
      ...(maxUsd.trim() ? { maxUsd: Number(maxUsd) } : {}),
    });
  };

  return (
    <div className="composer-wrap">
      <h1>New goal</h1>
      <p className="sub">Describe what you want done. Omakase plans it, drives agents to build it, and verifies the result.</p>

      <div className="composer">
        <textarea
          ref={ref}
          placeholder="e.g. Add a /healthz endpoint and an integration test, then wire it into the router"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
          }}
        />
        <div className="composer-bar">
          <label className="selectish">
            <span className="lbl">flow</span>
            <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
              {(state?.workflows ?? []).map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="selectish">
            <span className="lbl">agent</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">auto</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <button className="runbtn" onClick={submit} disabled={busy || !text.trim()}>
            {busy ? 'Starting…' : 'Run'} <kbd>⌘⏎</kbd>
          </button>
        </div>
      </div>

      <details className="opts">
        <summary>
          <span className="caret">▸</span> Success criteria &amp; budget <span style={{ color: 'var(--fg-faint)' }}>— optional</span>
        </summary>
        <div className="opts-grid">
          <div className="field">
            <label>Checks — shell commands that must exit 0</label>
            <input value={checks} onChange={(e) => setChecks(e.target.value)} placeholder="bun test" />
            <div className="hint">One per line. The loop keeps working until every check passes.</div>
          </div>
          <div className="field">
            <label>Criteria — judged in natural language</label>
            <input value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="the endpoint returns JSON with an ok field" />
            <div className="hint">One per line. A model verifies these against the result.</div>
          </div>
          <div className="two">
            <div className="field">
              <label>Max agents</label>
              <input className="tnum" value={maxAgents} onChange={(e) => setMaxAgents(e.target.value)} placeholder="unlimited" inputMode="numeric" />
            </div>
            <div className="field">
              <label>Max spend (USD)</label>
              <input className="tnum" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} placeholder="unlimited" inputMode="decimal" />
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
