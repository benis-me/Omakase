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
    ? theme.ok
    : s === 'failed'
      ? theme.err
      : s === 'cancelled'
        ? theme.warn
        : s === 'running'
          ? theme.accent
          : theme.faint;
}

function fit(s: string, w: number): string {
  if (w <= 1) return '';
  return s.length > w ? s.slice(0, w - 1) + '…' : s;
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
  const [lastStatus, setLastStatus] = useState<string | null>(null);
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
      setLastStatus(null);
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
        setLastStatus(outcome.status);
      } catch {
        setLastStatus('failed');
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

  const viewingLive = sel === 0;
  const viewingRun = viewingLive ? null : runs[sel - 1];
  const shownEvents: AnyRunEvent[] = viewingLive ? liveEvents : viewingRun ? safeEvents(props.store, viewingRun.id) : [];

  const compact = height < 24;
  const chromeRows = compact ? 8 : 11; // header + status + input + footer + gaps
  const logHeight = Math.max(3, height - chromeRows);
  const visible = eventLines(shownEvents).slice(-logHeight);

  const available = props.providers.filter((p) => p.available);
  const spin = SPINNER[tick % SPINNER.length]!;
  const running = phase === 'running';
  const elapsed = running && startedAt ? `${((Date.now() - startedAt) / 1000).toFixed(0)}s` : null;

  const sidebarW = Math.min(32, Math.max(22, Math.floor(width * 0.26)));
  const rowW = Math.max(4, sidebarW - 4); // minus border(2) + padding(2)

  const logTitle = viewingLive
    ? running
      ? ` ${spin} running `
      : phase === 'done'
        ? ' result '
        : ' ready '
    : ` ${fit(viewingRun?.id ?? '', sidebarW)} `;

  const stateGlyph = running ? spin : lastStatus === 'succeeded' ? '✓' : lastStatus ? '✗' : '◦';
  const stateColor = running ? theme.accent : lastStatus === 'succeeded' ? theme.ok : lastStatus ? theme.err : theme.faint;
  const stateLabel = running ? 'working' : lastStatus ? lastStatus : 'ready';

  return (
    <box
      style={{
        backgroundColor: theme.canvas,
        flexDirection: 'column',
        width,
        height,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        rowGap: compact ? 0 : 1,
      }}
    >
      {/* Header — a hairline bar, not a heavy box */}
      <box
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingLeft: 1,
          paddingRight: 1,
          paddingBottom: 1,
          border: ['bottom'],
          borderColor: theme.hairline,
        }}
      >
        <box style={{ flexDirection: 'row' }}>
          <text fg={theme.accent}>{'▍ '}</text>
          <text fg={theme.fg}>omakase</text>
          <text fg={theme.faint}>{'  ·  '}</text>
          <text fg={theme.dim}>{props.workspace.getConfig().name}</text>
        </box>
        <box style={{ flexDirection: 'row' }}>
          {available.length === 0 ? (
            <text fg={theme.faint}>no providers</text>
          ) : (
            available.map((p) => (
              <text key={p.id} fg={theme.dim} bg={theme.panelAlt}>
                {` ${p.id} `}
              </text>
            ))
          )}
        </box>
      </box>

      {/* Body — runs sidebar + event log */}
      <box style={{ flexDirection: 'row', flexGrow: 1, columnGap: 1 }}>
        <box
          style={{
            flexDirection: 'column',
            width: sidebarW,
            paddingLeft: 1,
            paddingRight: 1,
            border: true,
            borderStyle: 'rounded',
            borderColor: theme.border,
            backgroundColor: theme.canvas,
          }}
          title=" runs "
          titleColor={theme.faint}
          titleAlignment="left"
        >
          <SidebarRow
            selected={sel === 0}
            mark={running ? spin : '●'}
            markColor={theme.accent}
            label={running ? 'running' : 'current'}
            width={rowW}
          />
          {runs.slice(0, Math.max(0, logHeight - 1)).map((r, i) => (
            <SidebarRow
              key={r.id}
              selected={sel === i + 1}
              mark={STATUS_MARK[r.status] ?? '·'}
              markColor={statusColor(r.status)}
              label={r.title}
              width={rowW}
            />
          ))}
        </box>

        <box
          style={{
            flexDirection: 'column',
            flexGrow: 1,
            paddingLeft: 1,
            paddingRight: 1,
            border: true,
            borderStyle: 'rounded',
            borderColor: theme.border,
            backgroundColor: theme.canvas,
          }}
          title={logTitle}
          titleColor={running && viewingLive ? theme.accent : theme.faint}
          titleAlignment="left"
        >
          {visible.length === 0 ? (
            <text fg={theme.faint}>
              {viewingLive && phase === 'idle' ? 'Ready when you are — press ⏎ to run.' : 'No events.'}
            </text>
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
        <box style={{ flexDirection: 'row' }}>
          <text fg={stateColor}>{`${stateGlyph} ${stateLabel}`}</text>
          <text fg={theme.faint}>{'  ·  '}</text>
          <text fg={theme.dim}>{`${spend.agents} agents`}</text>
          <text fg={theme.faint}>{'  ·  '}</text>
          <text fg={theme.dim}>{`$${spend.cost.toFixed(4)}`}</text>
          {elapsed ? <text fg={theme.faint}>{'  ·  '}</text> : null}
          {elapsed ? <text fg={theme.dim}>{elapsed}</text> : null}
          {liveRunId && !running ? <text fg={theme.faint}>{`  ·  ${liveRunId}`}</text> : null}
        </box>
        <box style={{ flexDirection: 'row' }}>
          <text fg={theme.canvas} bg={theme.accent}>{` ${workflow} `}</text>
          <text fg={theme.faint}> ⇥</text>
        </box>
      </box>

      {/* Goal input — every colour explicit so it never inherits the terminal */}
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 1,
          paddingRight: 1,
          border: true,
          borderStyle: 'rounded',
          backgroundColor: theme.inputBg,
          borderColor: running ? theme.border : theme.borderFocus,
        }}
      >
        <text fg={theme.accent}>{running ? `${spin} ` : '❯ '}</text>
        <input
          style={{ flexGrow: 1 }}
          focused={!running}
          placeholder="Describe a goal…"
          placeholderColor={theme.placeholder}
          backgroundColor={theme.inputBg}
          focusedBackgroundColor={theme.inputBg}
          textColor={theme.inputFg}
          focusedTextColor={theme.inputFgFocus}
          value={goal}
          onInput={(v: string) => setGoal(v)}
          onSubmit={(v: unknown) => start(typeof v === 'string' ? v : goal)}
        />
      </box>

      {/* Footer — keys bright, labels quiet */}
      <box style={{ flexDirection: 'row', paddingLeft: 1 }}>
        <text fg={theme.dim}>↑↓</text>
        <text fg={theme.faint}> browse  </text>
        <text fg={theme.dim}>⇥</text>
        <text fg={theme.faint}> workflow  </text>
        <text fg={theme.dim}>⏎</text>
        <text fg={theme.faint}> run  </text>
        <text fg={theme.dim}>^R</text>
        <text fg={theme.faint}> refresh  </text>
        <text fg={theme.dim}>esc</text>
        <text fg={theme.faint}> {running ? 'cancel' : 'quit'}</text>
      </box>
    </box>
  );
}

function SidebarRow(props: {
  selected: boolean;
  mark: string;
  markColor: string;
  label: string;
  width: number;
}): React.ReactNode {
  const body = `${props.mark} ${props.label}`;
  if (props.selected) {
    // Accent bar + a full-width fill so the selection reads as one solid row.
    return (
      <text fg={theme.accent} bg={theme.panelAlt}>
        {`▍ ${fit(body, props.width - 2)}`.padEnd(props.width)}
      </text>
    );
  }
  return (
    <text fg={props.markColor}>
      {`  ${fit(body, props.width - 2)}`}
    </text>
  );
}

function safeEvents(store: Store, id: string): AnyRunEvent[] {
  try {
    return store.getEvents(id);
  } catch {
    return [];
  }
}
