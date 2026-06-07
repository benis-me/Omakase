/**
 * The Omakase TUI: a persistent run console. It is a pure CLIENT over a detached
 * daemon ({@link RunControllerClient}) — it never owns an Orchestrator. Submitted
 * runs live in the daemon, so quitting the TUI does NOT stop them; relaunching
 * re-attaches and keeps showing live progress (replay + tail). Only an explicit
 * stop ([x]) cancels a run.
 *
 * Layout mirrors a workflow monitor: a header (task + N/M agents + elapsed), a
 * left "Plan" pane (stage + done/total), and a right "Activity" + detail pane
 * (live route/planner/agent stream plus per-task token/tool/elapsed rows).
 */
import React, { useEffect, useRef, useState } from 'react';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import type { DetectedAgent } from '@omakase/daemon';
import type { RunStatus, WorkMode } from '@omakase/core';
import type { DaemonStatus } from '../daemon-control.js';
import type { RunControllerClient, RunSummary } from '../run-client.js';
import { initialRunView, type PhaseView, type RunView, type RunViewStatus, type TaskView } from '../view-model.js';
import { loadTuiPreferences, saveTuiPreferences } from './preferences.js';

/** Terminal size, kept in sync on resize so the UI fills and adapts. */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void =>
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

export interface AppProps {
  client: RunControllerClient;
  cwd: string;
  mode: WorkMode;
  /** Initial task already submitted by the CLI; its correlation token. */
  token?: string;
  /** Initial task text (for display / fallback submit). */
  task?: string;
  /** Local agent detection for the dashboard. */
  detect?: () => Promise<DetectedAgent[]>;
  /** Poll the project's daemon status for the header indicator. */
  daemonStatus?: () => Promise<DaemonStatus>;
  /** Stop the project's daemon (for the daemon-management keys). */
  stopDaemon?: () => Promise<unknown>;
  /** (Re)start the project's daemon. */
  startDaemon?: () => Promise<unknown>;
  /** Read-only local report/wiki server URL. */
  readOnlyUrl?: string;
}

/** A task's phase/stage — must match view-model's computePhases grouping. */
function stageOf(t: TaskView): string {
  return t.tags[0] ?? t.role ?? 'Plan';
}

function tasksForPhase(view: RunView | null, selectedPhase: number): {
  phaseIdx: number;
  stage: string | undefined;
  tasks: TaskView[];
} {
  if (!view) return { phaseIdx: 0, stage: undefined, tasks: [] };
  const phaseIdx = view.phases.length > 0 ? Math.min(selectedPhase, view.phases.length - 1) : 0;
  const stage = view.phases[phaseIdx]?.stage;
  return {
    phaseIdx,
    stage,
    tasks: stage != null ? view.tasks.filter((t) => stageOf(t) === stage) : view.tasks,
  };
}

function isRunnableAgent(agent: DetectedAgent): boolean {
  return agent.available && agent.authStatus !== 'missing';
}

/** Cycle the "main agent" selection: auto → each available agent → auto. */
function cycleAgent(current: string | null, agents: DetectedAgent[]): string | null {
  const cycle: Array<string | null> = [null, ...agents.filter(isRunnableAgent).map((a) => a.id)];
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % cycle.length] ?? null;
}

type Screen = 'list' | 'run';
type FocusPane = 'plan' | 'detail';
type Workspace = 'Plan' | 'Agents' | 'Acceptance' | 'Knowledge' | 'Reports' | 'Gate';
const WORKSPACES: readonly Workspace[] = ['Plan', 'Agents', 'Acceptance', 'Knowledge', 'Reports', 'Gate'];

function taskIcon(status: TaskView['status']): string {
  switch (status) {
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'cancelled':
      return '∅';
    case 'running':
      return '▸';
    case 'blocked':
      return '⊘';
    default:
      return '·';
  }
}

function statusColor(status: RunViewStatus | RunStatus): string {
  if (status === 'succeeded') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'cancelled' || status === 'incomplete' || status === 'paused') return 'yellow';
  if (status === 'running') return 'cyan';
  return 'gray';
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function elapsedOf(view: RunView, nowMs: number): number {
  if (view.startedAt == null) return 0;
  // Only a genuinely-advancing run (running/paused) ticks; anything else
  // (succeeded/failed/cancelled AND incomplete) freezes at its last update.
  const advancing = view.status === 'running' || view.status === 'paused';
  const end = advancing ? nowMs : view.updatedAt ?? view.startedAt;
  return Math.max(0, end - view.startedAt);
}

export function App({
  client,
  cwd,
  mode,
  token,
  task,
  detect,
  daemonStatus,
  stopDaemon,
  startDaemon,
  readOnlyUrl,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { columns, rows } = useTerminalSize();
  const active = useRef(true);

  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [screen, setScreen] = useState<Screen>('list');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState(0);
  const [selectedPhase, setSelectedPhase] = useState(0);
  const [focusPane, setFocusPane] = useState<FocusPane>('plan');
  const [workspace, setWorkspace] = useState<Workspace>('Plan');
  const [selectedTask, setSelectedTask] = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(
    () => loadTuiPreferences(cwd).selectedAgent,
  ); // null = auto
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [attachedId, setAttachedId] = useState<string | null>(null);
  const attachedIdRef = useRef<string | null>(null);
  const pendingTokenRef = useRef<string | null>(null);
  const [view, setView] = useState<RunView | null>(null);
  const [compose, setCompose] = useState<{ active: boolean; kind: 'new' | 'note'; buffer: string }>({
    active: false,
    kind: 'new',
    buffer: '',
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refreshRuns = async (): Promise<RunSummary[]> => {
    const list = await client.list();
    if (active.current) setRuns(list);
    return list;
  };

  const attach = async (id: string): Promise<void> => {
    if (!active.current) return;
    pendingTokenRef.current = null;
    attachedIdRef.current = id;
    setAttachedId(id);
    setView(null);
    setSelectedPhase(0);
    setFocusPane('plan');
    setWorkspace('Plan');
    setSelectedTask(0);
    setExpandedTaskId(null);
    setScreen('run');
    await refreshRuns();
  };

  // Mount: detect agents, then attach the initial task (if any) or show the list.
  useEffect(() => {
    active.current = true;
    if (detect) void detect().then((a) => active.current && setAgents(a)).catch(() => undefined);
    void (async () => {
      if (token) {
        const id = await client.resolveRunId(token).catch(() => null);
        if (id) await attach(id);
        else {
          setNotice('could not find the submitted run');
          await refreshRuns();
        }
      } else if (task) {
        const t = await client.submit(task);
        const id = await client.resolveRunId(t).catch(() => null);
        if (id) await attach(id);
      } else {
        await refreshRuns();
      }
    })();
    return () => {
      active.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-tail the attached run (replay + poll). Detach/quit does NOT stop it.
  useEffect(() => {
    if (!attachedId) return;
    const stop = client.tail(attachedId, (v) => {
      if (active.current && attachedIdRef.current === attachedId && v.runId === attachedId) {
        setView(v);
        void refreshRuns();
      }
    });
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachedId, client]);

  useEffect(() => {
    if (!view || !notice) return;
    const terminal = view.status === 'succeeded' || view.status === 'failed' || view.status === 'cancelled';
    if (notice.startsWith('stopping') && terminal) setNotice(null);
    if (notice.startsWith('pausing') && view.status === 'paused') setNotice(null);
    if (notice.startsWith('resuming') && view.status === 'running') setNotice(null);
  }, [notice, view]);

  // A 1s tick so live elapsed advances even when no events arrive.
  useEffect(() => {
    if (screen !== 'run') return;
    const timer = setInterval(() => active.current && setNowMs(Date.now()), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [screen]);

  // The daemon may create the run record after the user backs out of a pending
  // submission. Keep the list fresh without requiring another keypress/relaunch.
  useEffect(() => {
    if (screen !== 'list') return;
    void refreshRuns();
    const timer = setInterval(() => void refreshRuns(), 500);
    timer.unref?.();
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // Poll the daemon's status for the header indicator (it can die independently).
  useEffect(() => {
    if (!daemonStatus) return;
    const poll = (): void => {
      void daemonStatus().then((s) => active.current && setDaemon(s)).catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, 3000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [daemonStatus]);

  const submitNew = async (text: string): Promise<void> => {
    const t = await client.submit(text, selectedAgent ?? undefined);
    pendingTokenRef.current = t;
    const pending = {
      ...initialRunView(mode),
      status: 'pending' as const,
      title: text,
      events: [`queued ${t}`],
      phrases: [`queued: ${text}`],
      activity: [`queued: ${text}`],
    };
    attachedIdRef.current = null;
    setAttachedId(null);
    setSelectedPhase(0);
    setFocusPane('plan');
    setWorkspace('Plan');
    setSelectedTask(0);
    setExpandedTaskId(null);
    setView(pending);
    setScreen('run');
    setNotice('submitted — waiting for the daemon to start it');
    void refreshRuns();
    void resolveSubmittedRun(t);
  };

  const resolveSubmittedRun = async (tokenToResolve: string): Promise<void> => {
    for (;;) {
      const id = await client.resolveRunId(tokenToResolve, 1000).catch(() => null);
      if (!active.current || pendingTokenRef.current !== tokenToResolve) return;
      if (id) {
        await attach(id);
        return;
      }
      setNotice('submitted — waiting for the daemon to start it');
      await refreshRuns();
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const back = (): void => {
    pendingTokenRef.current = null;
    attachedIdRef.current = null;
    setAttachedId(null);
    setView(null);
    setFocusPane('plan');
    setWorkspace('Plan');
    setSelectedTask(0);
    setExpandedTaskId(null);
    setScreen('list');
    void refreshRuns();
  };

  const save = (): void => {
    if (!view || !attachedId) return;
    const file = path.join(cwd, `omakase-run-${attachedId}.md`);
    const lines = [
      `# Run ${attachedId} — ${view.status}`,
      view.title ? `\n${view.title}\n` : '',
      ...view.events,
    ];
    try {
      writeFileSync(file, lines.join('\n'), 'utf8');
      setNotice(`saved ${file}`);
    } catch {
      setNotice('save failed');
    }
  };

  useInput(
    (input, key) => {
      if (compose.active) {
        if (key.return) {
          const text = compose.buffer.trim();
          const kind = compose.kind;
          setCompose({ active: false, kind, buffer: '' });
          if (!text) return;
          if (kind === 'new') void submitNew(text);
          else if (attachedId) void client.sendInput(attachedId, text);
        } else if (key.escape) {
          setCompose((c) => ({ ...c, active: false, buffer: '' }));
        } else if (key.backspace || key.delete) {
          setCompose((c) => ({ ...c, buffer: c.buffer.slice(0, -1) }));
        } else if (input && !key.ctrl && !key.meta) {
          setCompose((c) => ({ ...c, buffer: c.buffer + input }));
        }
        return;
      }

      if (input === 'q') {
        exit(); // quitting NEVER cancels the run — the daemon keeps driving it
        return;
      }
      if (input === 'i') {
        setCompose({ active: true, kind: 'new', buffer: '' });
        return;
      }
      if (input === 'a') {
        // Switch the "main agent" used for the NEXT task you start here.
        setSelectedAgent((cur) => {
          const next = cycleAgent(cur, agents);
          saveTuiPreferences(cwd, { selectedAgent: next });
          return next;
        });
        return;
      }

      if (screen === 'list') {
        if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
        else if (key.downArrow) setSelected((i) => Math.min(runs.length - 1, i + 1));
        else if (key.return && runs[selected]) void attach(runs[selected]!.id);
        else if (input === 'k' && stopDaemon) {
          setNotice('stopping daemon…');
          void stopDaemon().then(() => active.current && setNotice('daemon stopped'));
        } else if (input === 'r' && (startDaemon || stopDaemon)) {
          setNotice('restarting daemon…');
          void (async () => {
            await stopDaemon?.();
            await startDaemon?.();
            if (active.current) setNotice('daemon restarted');
          })();
        }
        return;
      }

      // run screen
      const workspaceIndex = Number.parseInt(input, 10);
      if (Number.isInteger(workspaceIndex) && workspaceIndex >= 1 && workspaceIndex <= WORKSPACES.length) {
        setWorkspace(WORKSPACES[workspaceIndex - 1]!);
        setFocusPane('plan');
        return;
      }
      if (key.leftArrow) setFocusPane('plan');
      else if (key.rightArrow) setFocusPane('detail');
      else if (key.upArrow) {
        if (focusPane === 'detail') setSelectedTask((i) => Math.max(0, i - 1));
        else {
          setSelectedPhase((i) => Math.max(0, i - 1));
          setSelectedTask(0);
          setExpandedTaskId(null);
        }
      } else if (key.downArrow) {
        if (focusPane === 'detail') {
          const taskCount = tasksForPhase(view, selectedPhase).tasks.length;
          setSelectedTask((i) => Math.min(Math.max(0, taskCount - 1), i + 1));
        } else {
          setSelectedPhase((i) => Math.min(Math.max(0, (view?.phases.length ?? 1) - 1), i + 1));
          setSelectedTask(0);
          setExpandedTaskId(null);
        }
      } else if (key.return && focusPane === 'detail') {
        const task = tasksForPhase(view, selectedPhase).tasks[selectedTask];
        if (task) setExpandedTaskId((id) => (id === task.id ? null : task.id));
      } else if (key.escape) back();
      else if (input === 'x' && attachedId) {
        setNotice('stopping…');
        void client.stop(attachedId);
      } else if (input === 'p' && attachedId) {
        if (view?.status === 'paused') void client.resume(attachedId);
        else {
          setNotice('pausing…');
          void client.pause(attachedId);
        }
      } else if (input === 'u' && attachedId) {
        setCompose({ active: true, kind: 'note', buffer: '' });
      } else if (input === 's') {
        save();
      }
    },
    { isActive: isRawModeSupported },
  );

  useEffect(() => {
    if (!view) return;
    setSelectedPhase((i) => Math.min(Math.max(0, view.phases.length - 1), i));
  }, [view]);

  useEffect(() => {
    if (!view) return;
    const tasks = tasksForPhase(view, selectedPhase).tasks;
    setSelectedTask((i) => Math.min(Math.max(0, tasks.length - 1), i));
    if (expandedTaskId && !tasks.some((t) => t.id === expandedTaskId)) setExpandedTaskId(null);
  }, [expandedTaskId, selectedPhase, view]);

  const availableCount = agents.filter(isRunnableAgent).length;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header
        view={view}
        screen={screen}
        availableCount={availableCount}
        agentTotal={agents.length}
        nowMs={nowMs}
        task={task}
        daemon={daemon}
      />
      <Box flexGrow={1} flexDirection="column">
        {screen === 'list' ? (
          <RunList runs={runs} selected={selected} agents={agents} />
        ) : (
          <RunDetail
            view={view}
            nowMs={nowMs}
            selectedPhase={selectedPhase}
            focusPane={focusPane}
            workspace={workspace}
            selectedTask={selectedTask}
            expandedTaskId={expandedTaskId}
          />
        )}
      </Box>
      {compose.active ? (
        <Box>
          <Text>
            {compose.kind === 'new' ? 'new task' : 'note'} › <Text color="cyan">{compose.buffer}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}
      {notice ? <Text dimColor>{notice}</Text> : null}
      {readOnlyUrl ? <Text dimColor>web: {readOnlyUrl}</Text> : null}
      <Box justifyContent="space-between">
        <Text dimColor>{hints(compose.active, screen)}</Text>
        <Text>
          <Text dimColor>main agent: </Text>
          <Text color="yellow">{selectedAgent ?? 'auto'}</Text>
          <Text dimColor> [a]</Text>
        </Text>
      </Box>
    </Box>
  );
}

function hints(composing: boolean, screen: Screen): string {
  if (composing) return '[enter] submit  [esc] cancel';
  if (screen === 'list') return '↑↓ select · [enter] attach · [i] new · [k] stop daemon · [r] restart · [q]uit';
  return '[1-6] workspace · ←→ focus · ↑↓ select · [enter] expand · [x] stop · [p]ause/resume · [u] input · [s]ave · [esc] back · [q]uit';
}

function daemonLabel(d: DaemonStatus | null): { text: string; color: string } {
  if (!d) return { text: 'daemon ?', color: 'gray' };
  return d.running
    ? { text: `daemon ● up (${d.pid})`, color: 'green' }
    : { text: 'daemon ○ down', color: 'red' };
}

function Header({
  view,
  screen,
  availableCount,
  agentTotal,
  nowMs,
  task,
  daemon,
}: {
  view: RunView | null;
  screen: Screen;
  availableCount: number;
  agentTotal: number;
  nowMs: number;
  task?: string;
  daemon: DaemonStatus | null;
}): React.ReactElement {
  const title = view?.title ?? task ?? 'Omakase';
  const elapsed = view ? fmtDuration(elapsedOf(view, nowMs)) : '';
  const dl = daemonLabel(daemon);
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text bold color="magenta">
          omakase{' '}
        </Text>
        <Text>{title.split('\n')[0]?.slice(0, 56)}</Text>
        {view ? (
          <Text>
            {' '}
            · <Text color={statusColor(view.status)}>{view.status}</Text>
          </Text>
        ) : null}
      </Box>
      <Text dimColor>
        <Text color={dl.color}>{dl.text}</Text>
        {'  '}
        {screen === 'run' && view
          ? `${view.activeAgents}/${view.totalAgents} agents · ${elapsed}`
          : `${availableCount}/${agentTotal} agents`}
      </Text>
    </Box>
  );
}

function RunList({
  runs,
  selected,
  agents,
}: {
  runs: RunSummary[];
  selected: number;
  agents: DetectedAgent[];
}): React.ReactElement {
  return (
    <Box flexGrow={1}>
      <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1} marginRight={1}>
        <Text bold>Runs ({runs.length})</Text>
        {runs.length === 0 ? <Text dimColor>no runs yet — press [i] to start one</Text> : null}
        {runs.map((r, i) => (
          <Text key={r.id} inverse={i === selected}>
            <Text color={statusColor(r.status)}>{r.status.padEnd(10)}</Text> {r.done}/{r.total}{' '}
            {r.title.split('\n')[0]?.slice(0, 48)}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" borderStyle="round" paddingX={1} width={28}>
        <Text bold>Agents</Text>
        {agents.length === 0 ? <Text dimColor>detecting…</Text> : null}
        {agents.map((a) => {
          const runnable = isRunnableAgent(a);
          const color = runnable ? 'green' : a.available ? 'yellow' : 'gray';
          const dot = runnable ? '●' : a.available ? '◐' : '○';
          return (
            <Text key={a.id}>
              <Text color={color}>{dot}</Text> {a.id}
              {a.available && a.authStatus === 'missing' ? <Text dimColor> auth</Text> : null}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

function knowledgeLabel(view: RunView): string | null {
  const stats = view.codegraphStats;
  if (view.wikiEntries === 0 && !stats && view.codegraphFiles == null) return null;
  if (stats) {
    return `Knowledge · ${view.wikiEntries} wiki · ${stats.files} files · ${stats.internalEdges}/${stats.externalEdges} edges · ${stats.symbols} symbols · ${stats.cycles} cycles`;
  }
  return `Knowledge · ${view.wikiEntries} wiki${view.codegraphFiles != null ? ` · ${view.codegraphFiles} files` : ''}`;
}

function WorkspacePane({
  view,
  workspace,
  phaseIdx,
}: {
  view: RunView;
  workspace: Workspace;
  phaseIdx: number;
}): React.ReactElement {
  if (workspace === 'Plan') {
    return (
      <>
        {view.phases.length === 0 ? <Text dimColor>no plan yet</Text> : null}
        {view.phases.map((p: PhaseView, i) => (
          <Text key={p.stage} color={i === phaseIdx ? 'cyan' : undefined}>
            {i === phaseIdx ? '›' : ' '}
            {p.done === p.total && p.total > 0 ? <Text color="green">✔</Text> : <Text dimColor>·</Text>} {p.stage}
            <Text dimColor>
              {'  '}
              {p.done}/{p.total}
            </Text>
          </Text>
        ))}
      </>
    );
  }
  if (workspace === 'Agents') {
    return (
      <>
        {view.tasks.length === 0 ? <Text dimColor>no agents yet</Text> : null}
        {view.tasks.map((task) => (
          <Text key={task.id}>
            {taskIcon(task.status)} {task.agentId ?? 'unassigned'} <Text dimColor>{task.tokens} tok · {task.toolCount} tools</Text>
          </Text>
        ))}
      </>
    );
  }
  if (workspace === 'Acceptance') {
    const criteria = view.acceptance?.criteria ?? [];
    return (
      <>
        <Text dimColor>
          {view.acceptance
            ? `${view.acceptance.progress.passed}/${view.acceptance.progress.total} complete`
            : 'no acceptance yet'}
        </Text>
        {criteria.map((criterion) => (
          <Text key={criterion.id}>
            {criterion.status === 'pass' ? <Text color="green">✓</Text> : criterion.status === 'fail' ? <Text color="red">✗</Text> : <Text dimColor>·</Text>}{' '}
            {criterion.title.slice(0, 28)}
          </Text>
        ))}
      </>
    );
  }
  if (workspace === 'Knowledge') {
    return (
      <>
        <Text>{knowledgeLabel(view) ?? 'No project knowledge yet'}</Text>
        {view.knowledgeEvents.slice(-6).map((event) => (
          <React.Fragment key={event.id}>
            <Text>◇ {event.title.slice(0, 28)}</Text>
            {event.authorAgentId ? <Text dimColor>  wiki-curator/{event.authorAgentId}</Text> : null}
          </React.Fragment>
        ))}
      </>
    );
  }
  if (workspace === 'Reports') {
    return (
      <>
        {view.reports.length === 0 ? <Text dimColor>no reports yet</Text> : null}
        {view.reports.slice(-8).map((report) => (
          <React.Fragment key={report.id}>
            <Text>▣ {report.title.slice(0, 28)}</Text>
            <Text dimColor>  {report.authorAgentId ? `${report.authorRole}/${report.authorAgentId}` : report.source}</Text>
          </React.Fragment>
        ))}
      </>
    );
  }
  return (
    <>
      {view.riskGates.length === 0 ? <Text dimColor>no open gates</Text> : null}
      {view.riskGates.slice(-6).map((gate) => (
        <Text key={gate.id}>
          {gate.status === 'open' ? <Text color="yellow">⚠</Text> : <Text color="green">✓</Text>} {gate.question.slice(0, 28)}
        </Text>
      ))}
    </>
  );
}

function RunDetail({
  view,
  nowMs,
  selectedPhase,
  focusPane,
  workspace,
  selectedTask,
  expandedTaskId,
}: {
  view: RunView | null;
  nowMs: number;
  selectedPhase: number;
  focusPane: FocusPane;
  workspace: Workspace;
  selectedTask: number;
  expandedTaskId: string | null;
}): React.ReactElement {
  if (!view) return <Text dimColor>attaching…</Text>;
  const { phaseIdx, stage, tasks } = tasksForPhase(view, selectedPhase);
  const activity = (
    view.activity.length > 0 ? view.activity : view.phrases.length > 0 ? view.phrases : view.events
  ).slice(-10);
  const knowledge = knowledgeLabel(view);
  return (
    <Box flexGrow={1}>
      <Box flexDirection="column" borderStyle="round" paddingX={1} width={34} marginRight={1}>
        <Text bold color={focusPane === 'plan' ? 'cyan' : undefined}>
          {focusPane === 'plan' ? '› ' : ''}
          {workspace}
        </Text>
        <Text dimColor>{WORKSPACES.map((item, i) => `${i + 1}:${item === workspace ? `[${item}]` : item}`).join(' ')}</Text>
        <WorkspacePane view={view} workspace={workspace} phaseIdx={phaseIdx} />
      </Box>
      <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
        <Text bold>Activity</Text>
        {knowledge ? <Text dimColor>{knowledge.slice(0, 82)}</Text> : null}
        {activity.length === 0 ? <Text dimColor>waiting for planner…</Text> : null}
        {activity.map((p, i) => (
          <Text key={`${i}-${p.slice(0, 12)}`} dimColor>
            {p.slice(0, 82)}
          </Text>
        ))}
        <Text bold color={focusPane === 'detail' ? 'cyan' : undefined}>
          {focusPane === 'detail' ? '› ' : ''}
          Detail{stage != null ? ` · ${stage}` : ''} · {tasks.length} agents
        </Text>
        {tasks.map((t, i) => {
          const el = t.startedAt != null ? fmtDuration((t.finishedAt ?? nowMs) - t.startedAt) : '—';
          const selected = focusPane === 'detail' && i === selectedTask;
          const expanded = expandedTaskId === t.id;
          return (
            <React.Fragment key={t.id}>
              <Text color={selected ? 'cyan' : undefined}>
                {selected ? '›' : ' '}
                {taskIcon(t.status)} <Text dimColor>[{t.role}]</Text> {t.title.slice(0, 36)}
                <Text dimColor>
                  {'   '}
                  {t.agentId ? `${t.agentId} · ` : ''}
                  {t.tokens} tok · {t.toolCount} tools · {el}
                </Text>
              </Text>
              {expanded ? (
                <>
                  <Text dimColor>
                    {'   '}id: {t.id} · status: {t.status} · role: {t.role}
                  </Text>
                  <Text dimColor>
                    {'   '}agent: {t.agentId ?? 'unassigned'} · tokens: {t.tokens} · tools: {t.toolCount} · time: {el}
                  </Text>
                  <Text dimColor>{'   '}title: {t.title}</Text>
                </>
              ) : null}
            </React.Fragment>
          );
        })}
      </Box>
    </Box>
  );
}
