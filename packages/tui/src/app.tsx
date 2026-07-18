import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { defaultTextareaKeyBindings, type TextareaRenderable } from '@opentui/core';
import { runGoal, resumeRun } from '@omakase/engine';
import type { Workspace, Store, AnyRunEvent, RunRecord } from '@omakase/core';
import type { ProviderInfo } from '@omakase/providers';
import { eventLines, layoutRows, logWindow, theme } from './render.ts';
import { SettingsView } from './settings-view.tsx';
import { COMMANDS, filterCommands, isCommandInput, parseCommand, argSuggestions } from './commands.ts';

export interface AppProps {
  workspace: Workspace;
  store: Store;
  providers: ProviderInfo[];
  workflows: string[];
  initialGoal?: string;
  onExit: (code: number) => void;
}

type Phase = 'idle' | 'running' | 'done';
type View = 'main' | 'settings' | 'help';
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const STATUS_MARK: Record<string, string> = {
  succeeded: '✓', failed: '✗', cancelled: '◼', running: '●', pending: '·', paused: '·',
};

function statusColor(s: string): string {
  return s === 'succeeded' ? theme.ok
    : s === 'failed' ? theme.err
    : s === 'cancelled' ? theme.warn
    : s === 'running' ? theme.accent
    : theme.faint;
}

function fit(s: string, w: number): string {
  if (w <= 1) return '';
  return s.length > w ? s.slice(0, w - 1) + '…' : s;
}

/**
 * The composer is a goal box, not a document editor, so it departs from the
 * textarea defaults twice: ⏎ runs the goal (the default inserts a newline, and
 * ⏎ has always been "go" here), and ↑↓ are left alone so they keep browsing the
 * runs list. ⌥⏎ is the newline instead — terminals deliver it as an escape
 * prefix, where shift+⏎ needs a protocol not every terminal speaks.
 */
const COMPOSER_BINDINGS = [
  ...defaultTextareaKeyBindings.filter(
    (b) => !['move-up', 'move-down', 'newline', 'submit'].includes(b.action),
  ),
  { name: 'return', action: 'submit' as const },
  { name: 'kpenter', action: 'submit' as const },
  { name: 'return', meta: true, action: 'newline' as const },
  { name: 'kpenter', meta: true, action: 'newline' as const },
];

/** How many rows the composer shows: one per line, capped so the log keeps room. */
function composerHeight(text: string): number {
  return Math.min(6, Math.max(1, text.split('\n').length));
}

export function App(props: AppProps) {
  const { width, height } = useTerminalDimensions();
  const [view, setView] = useState<View>('main');
  const [goal, setGoal] = useState(props.initialGoal ?? '');
  const [wfIndex, setWfIndex] = useState(Math.max(0, props.workflows.indexOf('goal')));
  const [pinnedProvider, setPinnedProvider] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<AnyRunEvent[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [spend, setSpend] = useState({ agents: 0, cost: 0 });
  const [tick, setTick] = useState(0);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [sel, setSel] = useState(0); // 0 = live/current, 1.. = runs[sel-1]
  const [palIndex, setPalIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // Rows scrolled back from the newest; 0 pins the log to the tail so a live run
  // keeps streaming into view.
  const [scrollBack, setScrollBack] = useState(0);
  const [full, setFull] = useState(false); // wrap results instead of clipping
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<TextareaRenderable | null>(null);

  // The composer owns its own buffer, so anything that writes into it on the
  // app's behalf (clearing, completing a command) has to say so twice.
  const writeComposer = useCallback((text: string) => {
    setGoal(text);
    composerRef.current?.setText(text);
  }, []);

  const workflow = props.workflows[wfIndex] ?? 'goal';
  const running = phase === 'running';
  const paletteOpen = view === 'main' && isCommandInput(goal);
  const matches = paletteOpen ? filterCommands(goal) : [];

  const refreshRuns = useCallback(() => {
    try {
      setRuns(props.store.listRuns({ limit: 30 }));
    } catch {
      /* ignore */
    }
  }, [props.store]);

  useEffect(() => { refreshRuns(); }, [refreshRuns]);
  useEffect(() => { setPalIndex(0); }, [goal]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [running]);

  const streamOpts = useCallback(
    (controller: AbortController) => ({
      signal: controller.signal,
      onEvent: (e: AnyRunEvent) => {
        setLiveEvents((prev) => (prev.length > 600 ? [...prev.slice(-500), e] : [...prev, e]));
        if (e.type === 'run:started' || e.type === 'run:resumed') setLiveRunId(e.runId);
        if (e.type === 'agent:completed') setSpend((s) => ({ agents: s.agents + 1, cost: s.cost + e.payload.costUsd }));
      },
    }),
    [],
  );

  const begin = useCallback(() => {
    setLiveEvents([]);
    setSpend({ agents: 0, cost: 0 });
    setPhase('running');
    setLastStatus(null);
    setNotice(null);
    setSel(0);
    setStartedAt(Date.now());
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, []);

  const finish = useCallback((status: string | null) => {
    setLastStatus(status);
    setPhase('done');
    abortRef.current = null;
    refreshRuns();
  }, [refreshRuns]);

  const start = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || running) return;
      const controller = begin();
      try {
        const outcome = await runGoal({
          goal: {
            text: trimmed,
            workflow,
            cwd: props.workspace.root,
            ...(pinnedProvider ? { provider: pinnedProvider } : {}),
          },
          workspace: props.workspace,
          store: props.store,
          ...streamOpts(controller),
        });
        setLiveRunId(outcome.runId);
        finish(outcome.status);
      } catch {
        finish('failed');
      }
    },
    [running, workflow, pinnedProvider, props.workspace, props.store, begin, finish, streamOpts],
  );

  const resume = useCallback(
    async (runId: string) => {
      if (running) return;
      if (!props.store.getRun(runId)) { setNotice(`no such run: ${runId}`); return; }
      const controller = begin();
      try {
        const outcome = await resumeRun(runId, {
          workspace: props.workspace,
          store: props.store,
          ...streamOpts(controller),
        });
        finish(outcome.status);
      } catch {
        finish('failed');
      }
    },
    [running, props.workspace, props.store, begin, finish, streamOpts],
  );

  const execCommand = useCallback(
    (value: string) => {
      const parsed = parseCommand(value);
      const cmd = matches[palIndex] ?? (parsed ? COMMANDS.find((c) => c.name === parsed.name) : undefined);
      if (!cmd) { setNotice(`unknown command: ${value}`); writeComposer(''); return; }
      const arg = parsed?.arg ?? '';
      writeComposer('');
      setNotice(null);
      switch (cmd.name) {
        case 'workflow': {
          const i = props.workflows.indexOf(arg);
          if (i >= 0) setWfIndex(i);
          else setNotice(`unknown workflow: ${arg || '(none)'} — try ${props.workflows.join(', ')}`);
          break;
        }
        case 'provider': {
          const ids = props.providers.filter((p) => p.available).map((p) => p.id);
          if (!arg || arg === 'auto') setPinnedProvider(null);
          else if (ids.includes(arg)) setPinnedProvider(arg);
          else setNotice(`unknown provider: ${arg} — try auto, ${ids.join(', ')}`);
          break;
        }
        case 'settings': setView('settings'); break;
        case 'runs': setSel(runs.length ? 1 : 0); break;
        case 'resume': void resume(arg || liveRunId || ''); break;
        // The input only takes keys while nothing is running, so a submitted
        // /cancel arrives with no controller to abort — name the keys that do.
        case 'cancel':
          if (abortRef.current) abortRef.current.abort();
          else setNotice('nothing to cancel — esc or ^C stops a run');
          break;
        case 'clear': setLiveEvents([]); break;
        case 'help': setView('help'); break;
        case 'quit': props.onExit(0); break;
      }
    },
    [matches, palIndex, props, runs.length, resume, liveRunId, writeComposer],
  );

  const submit = useCallback(
    (value: string) => {
      if (isCommandInput(value)) execCommand(value);
      else void start(value);
    },
    [execCommand, start],
  );

  useKeyboard((key: { name?: string; ctrl?: boolean }) => {
    const name = key.name ?? '';
    if (view === 'settings') return; // SettingsView owns its keys
    if (view === 'help') {
      if (name === 'escape' || name === 'return' || name === 'q') setView('main');
      return;
    }
    if (name === 'c' && key.ctrl) {
      if (running) abortRef.current?.abort();
      else props.onExit(0);
      return;
    }
    if (name === 'escape') {
      if (running) abortRef.current?.abort();
      else if (goal) writeComposer('');
      else props.onExit(0);
      return;
    }
    if (name === 'u' && key.ctrl) { writeComposer(''); return; }
    if (name === 'tab') {
      if (paletteOpen && matches[palIndex]) {
        const cmd = matches[palIndex]!;
        writeComposer(cmd.arg === 'none' ? `/${cmd.name}` : `/${cmd.name} `);
      } else if (!running) {
        setWfIndex((i) => (i + 1) % Math.max(1, props.workflows.length));
      }
      return;
    }
    // Scrollback: the log is the one pane that outgrows its box, so it gets the
    // paging keys. ↑↓ stay on the runs list — a live run would otherwise fight
    // the reader for the cursor.
    // Page keys only: home/end belong to the composer's text cursor, and the
    // input keeps focus while the log is being read.
    if (name === 'pageup') { setScrollBack((s) => s + Math.max(1, logHeight - 1)); return; }
    if (name === 'pagedown') { setScrollBack((s) => Math.max(0, s - Math.max(1, logHeight - 1))); return; }
    if (name === 'f' && key.ctrl) { setFull((f) => !f); return; }
    if (name === 'up') {
      if (paletteOpen) setPalIndex((i) => Math.max(0, i - 1));
      else setSel((s) => Math.max(0, s - 1));
    } else if (name === 'down') {
      if (paletteOpen) setPalIndex((i) => Math.min(Math.max(0, matches.length - 1), i + 1));
      else setSel((s) => Math.min(runs.length, s + 1));
    } else if (name === 'r' && key.ctrl) {
      refreshRuns();
    }
  });

  // Switching runs, or starting a new one, returns the log to the newest row.
  useEffect(() => { setScrollBack(0); }, [sel, liveRunId]);

  const viewingLive = sel === 0;
  const viewingRun = viewingLive ? null : runs[sel - 1];

  // A stored run's log comes straight off SQLite and is unbounded, so it must
  // not sit on the render path: the spinner re-renders at 10Hz for the whole of
  // a run, and the runs list stays browsable while one is in flight. Re-read it
  // only while the selected run is the one still writing — a finished log cannot
  // change, and another run's events say nothing about it.
  const growing = viewingRun && viewingRun.id === liveRunId ? liveEvents.length : 0;
  const storedEvents = useMemo<AnyRunEvent[]>(
    () => (viewingRun ? safeEvents(props.store, viewingRun.id) : []),
    [viewingRun?.id, growing, props.store],
  );
  const shownEvents = viewingLive ? liveEvents : storedEvents;
  const lines = useMemo(() => eventLines(shownEvents), [shownEvents]);

  const compact = height < 24;
  const PALETTE_MAX = 9;
  const paletteRows = paletteOpen ? Math.min(PALETTE_MAX, Math.max(1, matches.length)) + 2 : 0;
  // Everything the log box does not get: padding, the header and its rule, the
  // row gaps, the status line, the bordered input, the footer, and this panel's
  // own borders. Overshooting costs a blank row; undershooting paints rows on
  // top of each other, so this errs high.
  // 15 assumed a one-line composer; a taller one costs the log those rows.
  const composerRows = composerHeight(goal);
  const chromeRows = (compact ? 12 : 15) + paletteRows + (composerRows - 1);
  const logHeight = Math.max(3, height - chromeRows);
  const sidebarW = Math.min(32, Math.max(22, Math.floor(width * 0.26)));
  // The log box's usable width: the root's padding, the sidebar and the gap, then
  // this panel's own border and padding.
  const logWidth = Math.max(12, width - sidebarW - 9);
  const rows = useMemo(() => layoutRows(lines, logWidth, full), [lines, logWidth, full]);
  const win = logWindow(rows.length, logHeight, scrollBack);
  const offset = win.offset;
  const visible = rows.slice(win.start, win.end);

  const available = props.providers.filter((p) => p.available);
  const spin = SPINNER[tick % SPINNER.length]!;
  const elapsed = running && startedAt ? `${((Date.now() - startedAt) / 1000).toFixed(0)}s` : null;
  const rowW = Math.max(4, sidebarW - 4);

  const baseTitle = viewingLive
    ? running ? ` ${spin} running ` : phase === 'done' ? ' result ' : ' ready '
    : ` ${fit(viewingRun?.id ?? '', sidebarW)} `;
  // Say so when the log is held above the tail — otherwise a paused view looks
  // like a stalled run.
  const logTitle = offset > 0 ? `${baseTitle}↑${offset} ` : baseTitle;

  // While browsing history the status line belongs to the run being read, not to
  // whatever the live slot last did.
  const shownStatus = viewingLive ? (running ? 'running' : lastStatus) : (viewingRun?.status ?? null);
  const shownAgents = viewingLive ? spend.agents : (viewingRun?.spentAgents ?? 0);
  const shownCost = viewingLive ? spend.cost : (viewingRun?.spentCostUsd ?? 0);
  const stateGlyph = running && viewingLive ? spin : shownStatus === 'succeeded' ? '✓' : shownStatus === 'cancelled' ? '◼' : shownStatus ? '✗' : '◦';
  const stateColor = running && viewingLive ? theme.accent : statusColor(shownStatus ?? '');
  const stateLabel = running && viewingLive ? 'working' : (shownStatus ?? 'ready');

  return (
    <box style={{ backgroundColor: theme.canvas, flexDirection: 'column', width, height, paddingLeft: 2, paddingRight: 2, paddingTop: 1, rowGap: compact ? 0 : 1 }}>
      {/* Header */}
      <box style={{ flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 1, paddingRight: 1, paddingBottom: 1, border: ['bottom'], borderColor: theme.hairline }}>
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
              <text key={p.id} fg={pinnedProvider === p.id ? theme.canvas : theme.dim} bg={pinnedProvider === p.id ? theme.accent : theme.panelAlt}>
                {` ${p.id} `}
              </text>
            ))
          )}
        </box>
      </box>

      {view === 'settings' ? (
        <SettingsView workspace={props.workspace} providers={props.providers} onClose={() => setView('main')} width={width} />
      ) : view === 'help' ? (
        <HelpView />
      ) : (
        <>
          {/* Body */}
          <box style={{ flexDirection: 'row', flexGrow: 1, columnGap: 1 }}>
            <box
              style={{ flexDirection: 'column', width: sidebarW, paddingLeft: 1, paddingRight: 1, border: true, borderStyle: 'rounded', borderColor: theme.border, backgroundColor: theme.canvas }}
              title=" runs " titleColor={theme.faint} titleAlignment="left"
            >
              <SidebarRow selected={sel === 0} mark={running ? spin : '●'} markColor={theme.accent} label={running ? 'running' : 'current'} width={rowW} />
              {runs.slice(0, Math.max(0, logHeight - 1)).map((r, i) => (
                <SidebarRow key={r.id} selected={sel === i + 1} mark={STATUS_MARK[r.status] ?? '·'} markColor={statusColor(r.status)} label={r.title} width={rowW} />
              ))}
            </box>

            <box
              style={{ flexDirection: 'column', flexGrow: 1, paddingLeft: 1, paddingRight: 1, border: true, borderStyle: 'rounded', borderColor: theme.border, backgroundColor: theme.canvas }}
              title={logTitle} titleColor={running && viewingLive ? theme.accent : theme.faint} titleAlignment="left"
            >
              {visible.length === 0 ? (
                <text fg={theme.faint}>{viewingLive && phase === 'idle' ? 'Ready when you are — press ⏎ to run, or / for commands.' : 'No events.'}</text>
              ) : (
                visible.map((ln, i) => (
                  <text key={i} fg={ln.color}>{ln.text}</text>
                ))
              )}
            </box>
          </box>

          {/* Status line */}
          <box style={{ flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 1, paddingRight: 1 }}>
            <box style={{ flexDirection: 'row' }}>
              <text fg={stateColor}>{`${stateGlyph} ${stateLabel}`}</text>
              <text fg={theme.faint}>{'  ·  '}</text>
              <text fg={theme.dim}>{`${shownAgents} agents`}</text>
              <text fg={theme.faint}>{'  ·  '}</text>
              <text fg={theme.dim}>{`$${shownCost.toFixed(4)}`}</text>
              {elapsed ? <text fg={theme.faint}>{'  ·  '}</text> : null}
              {elapsed ? <text fg={theme.dim}>{elapsed}</text> : null}
              {notice ? <text fg={theme.warn}>{`  ·  ${fit(notice, 48)}`}</text> : null}
              {!notice && liveRunId && !running ? <text fg={theme.faint}>{`  ·  ${liveRunId}`}</text> : null}
            </box>
            <box style={{ flexDirection: 'row' }}>
              {pinnedProvider ? <text fg={theme.faint}>{`${pinnedProvider}  `}</text> : null}
              <text fg={theme.canvas} bg={theme.accent}>{` ${workflow} `}</text>
              <text fg={theme.faint}> ⇥</text>
            </box>
          </box>

          {/* Command palette */}
          {paletteOpen ? (
            <box
              style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1, border: true, borderStyle: 'rounded', borderColor: theme.accent2, backgroundColor: theme.panel }}
              title=" commands " titleColor={theme.accent2} titleAlignment="left"
            >
              {matches.length === 0 ? (
                <text fg={theme.faint}>no matching command</text>
              ) : (
                matches.slice(0, PALETTE_MAX).map((c, i) => {
                  const active = i === palIndex;
                  const sugg = active ? argSuggestions(c, {
                    workflows: props.workflows,
                    providers: available.map((p) => p.id),
                    runIds: runs.map((r) => r.id),
                  }) : [];
                  return (
                    <box key={c.name} style={{ flexDirection: 'row' }}>
                      <text fg={active ? theme.accent : theme.faint}>{active ? '▍ ' : '  '}</text>
                      <text fg={active ? theme.fg : theme.dim}>{c.usage.padEnd(22)}</text>
                      <text fg={theme.faint}>{fit(sugg.length ? sugg.join('  ') : c.description, Math.max(10, width - sidebarW - 10))}</text>
                    </box>
                  );
                })
              )}
            </box>
          ) : null}

          {/* Goal input */}
          <box
            style={{
              flexDirection: 'row', alignItems: 'center', paddingLeft: 1, paddingRight: 1,
              border: true, borderStyle: 'rounded', backgroundColor: theme.inputBg,
              borderColor: running ? theme.border : paletteOpen ? theme.accent2 : theme.borderFocus,
            }}
          >
            {/* The value already shows the "/", so keep the caret glyph stable
                and let its colour signal command mode. */}
            <text fg={paletteOpen ? theme.accent2 : theme.accent}>{running ? `${spin} ` : '❯ '}</text>
            <textarea
              ref={composerRef}
              style={{ flexGrow: 1, height: composerRows }}
              focused={!running}
              placeholder="Describe a goal…  (/ for commands)"
              placeholderColor={theme.placeholder}
              backgroundColor={theme.inputBg}
              focusedBackgroundColor={theme.inputBg}
              textColor={theme.inputFg}
              focusedTextColor={theme.inputFgFocus}
              keyBindings={COMPOSER_BINDINGS}
              onContentChange={() => setGoal(composerRef.current?.plainText ?? '')}
              onSubmit={() => submit(composerRef.current?.plainText ?? goal)}
            />
          </box>

          {/* Footer */}
          <box style={{ flexDirection: 'row', paddingLeft: 1 }}>
            <Hint k="/" label="commands" />
            <Hint k="↑↓" label={paletteOpen ? 'pick' : 'runs'} />
            <Hint k="⇥" label={paletteOpen ? 'complete' : 'workflow'} />
            <Hint k="⏎" label="run" />
            {width >= 96 ? <Hint k="⌥⏎" label="newline" /> : null}
            {!compact ? <Hint k="⇞⇟" label="scroll" /> : null}
            {!compact ? <Hint k="^F" label={full ? 'clip' : 'full text'} /> : null}
            <Hint k="esc" label={running ? 'cancel' : 'quit'} />
          </box>
        </>
      )}
    </box>
  );
}

function Hint(props: { k: string; label: string }): React.ReactNode {
  return (
    <>
      <text fg={theme.dim}>{props.k}</text>
      <text fg={theme.faint}>{` ${props.label}  `}</text>
    </>
  );
}

function HelpView(): React.ReactNode {
  const rows: [string, string][] = [
    ['⏎', 'run the goal (or the typed command)'],
    ['/', 'open the command palette'],
    ['↑ ↓', 'browse runs (or pick a command)'],
    ['⇥', 'cycle workflow (or complete a command)'],
    ['⌥ ⏎', 'newline in the composer (⏎ runs the goal)'],
    ['⇞ ⇟', 'scroll the log back and forward'],
    ['^F', 'full text — wrap results instead of clipping'],
    ['^U', 'clear the input'],
    ['^R', 'refresh the runs list'],
    ['esc', 'cancel a run · clear input · quit'],
    ['^C', 'cancel a run · quit'],
  ];
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      <box
        style={{ flexDirection: 'column', flexGrow: 1, paddingLeft: 1, paddingRight: 1, border: true, borderStyle: 'rounded', borderColor: theme.borderFocus, backgroundColor: theme.canvas }}
        title=" help " titleColor={theme.accent} titleAlignment="left"
      >
        <text fg={theme.dim}>Keys</text>
        {rows.map(([k, d]) => (
          <box key={k} style={{ flexDirection: 'row' }}>
            <text fg={theme.accent}>{`  ${k.padEnd(6)}`}</text>
            <text fg={theme.dim}>{d}</text>
          </box>
        ))}
        <box style={{ paddingTop: 1 }}><text fg={theme.dim}>Commands</text></box>
        {COMMANDS.map((c) => (
          <box key={c.name} style={{ flexDirection: 'row' }}>
            <text fg={theme.accent2}>{`  ${c.usage.padEnd(22)}`}</text>
            <text fg={theme.dim}>{c.description}</text>
          </box>
        ))}
      </box>
      <box style={{ flexDirection: 'row', paddingLeft: 1 }}>
        <text fg={theme.dim}>esc</text>
        <text fg={theme.faint}> back</text>
      </box>
    </box>
  );
}

function SidebarRow(props: { selected: boolean; mark: string; markColor: string; label: string; width: number }): React.ReactNode {
  const body = `${props.mark} ${props.label}`;
  if (props.selected) {
    return (
      <text fg={theme.accent} bg={theme.panelAlt}>{`▍ ${fit(body, props.width - 2)}`.padEnd(props.width)}</text>
    );
  }
  return <text fg={props.markColor}>{`  ${fit(body, props.width - 2)}`}</text>;
}

function safeEvents(store: Store, id: string): AnyRunEvent[] {
  try {
    return store.getEvents(id);
  } catch {
    return [];
  }
}
