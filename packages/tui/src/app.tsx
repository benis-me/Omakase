import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { runGoal } from '@omakase/engine';
import type { Workspace, Store, AnyRunEvent, RunRecord } from '@omakase/core';
import type { ProviderInfo } from '@omakase/providers';
import { eventLines, theme } from './render.ts';

export interface AppProps {
  workspace: Workspace;
  store: Store;
  providers: ProviderInfo[];
  workflows: string[];
  initialGoal?: string;
  onExit: (code: number) => void;
}

type Phase = 'idle' | 'running' | 'done';
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const STATUS_MARK: Record<string, string> = {
  succeeded: '✓',
  failed: '✗',
  cancelled: '◼',
  running: '●',
  pending: '·',
  paused: '·',
};
function statusColor(s: string): string {
  return s === 'succeeded'
    ? theme.green
    : s === 'failed'
      ? theme.red
      : s === 'cancelled'
        ? theme.yellow
        : theme.cyan;
}

export function App(props: AppProps) {
  const { width, height } = useTerminalDimensions();
  const [goal, setGoal] = useState(props.initialGoal ?? '');
  const [wfIndex, setWfIndex] = useState(Math.max(0, props.workflows.indexOf('goal')));
  const [liveEvents, setLiveEvents] = useState<AnyRunEvent[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [spend, setSpend] = useState({ agents: 0, cost: 0 });
  const [tick, setTick] = useState(0);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [sel, setSel] = useState(0); // 0 = live/current, 1.. = runs[sel-1]
  const abortRef = useRef<AbortController | null>(null);

  const workflow = props.workflows[wfIndex] ?? 'goal';

  const refreshRuns = useCallback(() => {
    try {
      setRuns(props.store.listRuns({ limit: 30 }));
    } catch {
      /* ignore */
    }
  }, [props.store]);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    if (phase !== 'running') return;
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [phase]);

  const start = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || phase === 'running') return;
      setLiveEvents([]);
      setSpend({ agents: 0, cost: 0 });
      setPhase('running');
      setSel(0);
      setStartedAt(Date.now());
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const outcome = await runGoal({
          goal: { text: trimmed, workflow, cwd: props.workspace.root },
          workspace: props.workspace,
          store: props.store,
          signal: controller.signal,
          onEvent: (e) => {
            setLiveEvents((prev) => (prev.length > 600 ? [...prev.slice(-500), e] : [...prev, e]));
            if (e.type === 'run:started') setLiveRunId(e.runId);
            if (e.type === 'agent:completed') setSpend((s) => ({ agents: s.agents + 1, cost: s.cost + e.payload.costUsd }));
          },
        });
        setLiveRunId(outcome.runId);
      } catch {
        /* surfaced via events */
      } finally {
        setPhase('done');
        abortRef.current = null;
        refreshRuns();
      }
    },
    [phase, workflow, props.workspace, props.store, refreshRuns],
  );

  useKeyboard((key: { name?: string; ctrl?: boolean }) => {
    const name = key.name ?? '';
    if ((name === 'c' && key.ctrl) || name === 'escape') {
      if (phase === 'running') abortRef.current?.abort();
      else props.onExit(0);
      return;
    }
    if (name === 'tab' && phase !== 'running') {
      setWfIndex((i) => (i + 1) % Math.max(1, props.workflows.length));
      return;
    }
    if (name === 'up') setSel((s) => Math.max(0, s - 1));
    else if (name === 'down') setSel((s) => Math.min(runs.length, s + 1));
    else if (name === 'r' && key.ctrl) refreshRuns();
  });

  // Which run's events to show: 0 = the live/current run, else a past run.
  const viewingLive = sel === 0;
  const viewingRun = viewingLive ? null : runs[sel - 1];
  const shownEvents: AnyRunEvent[] = viewingLive
    ? liveEvents
    : viewingRun
      ? safeEvents(props.store, viewingRun.id)
      : [];

  const allLines = eventLines(shownEvents);
  const logHeight = Math.max(3, height - 10);
  const visible = allLines.slice(-logHeight);

  const available = props.providers.filter((p) => p.available);
  const elapsed = phase === 'running' && startedAt ? ((Date.now() - startedAt) / 1000).toFixed(0) : null;
  const spin = SPINNER[tick % SPINNER.length];
  const sidebarW = Math.min(30, Math.max(20, Math.floor(width * 0.28)));
  const logTitle = viewingLive
    ? phase === 'running'
      ? `${spin} running`
      : phase === 'done'
        ? 'result'
        : 'ready'
    : `run ${viewingRun?.id ?? ''}`;

  return (
    <box style={{ flexDirection: 'column', width, height }}>
      {/* Header */}
      <box
        style={{ flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 1, paddingRight: 1, border: true, borderStyle: 'rounded', borderColor: theme.border }}
        title="omakase"
        titleColor={theme.magenta}
      >
        <text fg={theme.dim}>{props.workspace.getConfig().name}</text>
        <text fg={theme.dim}>{available.length ? available.map((p) => p.id).join('  ') : 'no providers'}</text>
      </box>

      {/* Body: runs sidebar + event log */}
      <box style={{ flexDirection: 'row', flexGrow: 1 }}>
        <box
          style={{ flexDirection: 'column', width: sidebarW, paddingLeft: 1, paddingRight: 1, border: true, borderStyle: 'rounded', borderColor: theme.border }}
          title="runs"
          titleColor={theme.dim}
        >
          <text fg={sel === 0 ? theme.magenta : theme.dim}>{(sel === 0 ? '❯ ' : '  ') + (phase === 'running' ? `${spin} current` : '● current')}</text>
          {runs.slice(0, logHeight).map((r, i) => {
            const active = sel === i + 1;
            const mark = STATUS_MARK[r.status] ?? '·';
            return (
              <text key={r.id} fg={active ? theme.magenta : statusColor(r.status)}>
                {(active ? '❯ ' : '  ') + mark + ' ' + r.title.slice(0, sidebarW - 6)}
              </text>
            );
          })}
        </box>

        <box
          style={{ flexDirection: 'column', flexGrow: 1, paddingLeft: 1, paddingRight: 1, border: true, borderStyle: 'rounded', borderColor: theme.border }}
          title={logTitle}
          titleColor={phase === 'running' && viewingLive ? theme.yellow : theme.dim}
        >
          {visible.length === 0 ? (
            <text fg={theme.faint}>{viewingLive && phase === 'idle' ? 'Type a goal below and press Enter.' : 'No events.'}</text>
          ) : (
            visible.map((ln, i) => (
              <text key={i} fg={ln.color}>
                {'  '.repeat(ln.indent ?? 0) + ln.text}
              </text>
            ))
          )}
        </box>
      </box>

      {/* Status line */}
      <box style={{ flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 1, paddingRight: 1 }}>
        <text fg={theme.dim}>
          {phase === 'running' ? `${spin} working` : phase === 'done' ? 'done' : 'ready'}
          {`  ·  ${spend.agents} agent(s)  ·  $${spend.cost.toFixed(4)}`}
          {elapsed ? `  ·  ${elapsed}s` : ''}
          {liveRunId && phase !== 'running' ? `  ·  ${liveRunId}` : ''}
        </text>
        <text fg={theme.magenta}>{`workflow: ${workflow}  ⇥`}</text>
      </box>

      {/* Goal input */}
      <box
        style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1, border: true, borderStyle: 'rounded', borderColor: phase === 'running' ? theme.border : theme.borderFocus }}
      >
        <text fg={theme.magenta}>{'❯ '}</text>
        <input
          style={{ flexGrow: 1 }}
          focused={phase !== 'running'}
          placeholder="Describe your goal…"
          value={goal}
          onInput={(v: string) => setGoal(v)}
          onSubmit={(v: unknown) => start(typeof v === 'string' ? v : goal)}
        />
      </box>

      {/* Footer keybindings */}
      <box style={{ flexDirection: 'row', paddingLeft: 1 }}>
        <text fg={theme.faint}>↑/↓ browse runs · ⇥ workflow · ⏎ run · ^R refresh · esc/^C quit</text>
      </box>
    </box>
  );
}

function safeEvents(store: Store, id: string): AnyRunEvent[] {
  try {
    return store.getEvents(id);
  } catch {
    return [];
  }
}
