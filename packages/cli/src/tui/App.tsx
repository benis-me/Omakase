/**
 * The Omakase TUI: a persistent run console. It is a pure CLIENT over a detached
 * daemon ({@link RunControllerClient}) — it never owns an Orchestrator. Submitted
 * runs live in the daemon, so quitting the TUI does NOT stop them; relaunching
 * re-attaches and keeps showing live progress (replay + tail). Only an explicit
 * stop ([x]) cancels a run.
 *
 * Layout mirrors a workflow monitor: a header (task + N/M agents + elapsed), a
 * left "Phases" pane (stage + done/total), and a right "Detail · N agents" pane
 * (per-task token/tool/elapsed rows), with keybindings in the footer.
 */
import React, { useEffect, useRef, useState } from 'react';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { DetectedAgent } from '@omakase/daemon';
import type { RunStatus, WorkMode } from '@omakase/core';
import type { RunControllerClient, RunSummary } from '../run-client.js';
import type { PhaseView, RunView, RunViewStatus, TaskView } from '../view-model.js';

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
}

type Screen = 'list' | 'run';

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

export function App({ client, cwd, token, task, detect }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const active = useRef(true);

  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [screen, setScreen] = useState<Screen>('list');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState(0);
  const [attachedId, setAttachedId] = useState<string | null>(null);
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
    setAttachedId(id);
    setScreen('run');
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
      if (active.current) setView(v);
    });
    return () => stop();
  }, [attachedId, client]);

  // A 1s tick so live elapsed advances even when no events arrive.
  useEffect(() => {
    if (screen !== 'run') return;
    const timer = setInterval(() => active.current && setNowMs(Date.now()), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [screen]);

  const submitNew = async (text: string): Promise<void> => {
    const t = await client.submit(text);
    const id = await client.resolveRunId(t).catch(() => null);
    if (id) {
      setView(null);
      await attach(id);
    } else {
      // The daemon hasn't picked it up yet — tell the user and show the list so
      // they can attach once it appears, rather than silently doing nothing.
      setNotice('submitted — waiting for the daemon to start it; press [esc] for the run list');
      await refreshRuns();
    }
  };

  const back = (): void => {
    setAttachedId(null);
    setView(null);
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

      if (screen === 'list') {
        if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
        else if (key.downArrow) setSelected((i) => Math.min(runs.length - 1, i + 1));
        else if (key.return && runs[selected]) void attach(runs[selected]!.id);
        return;
      }

      // run screen
      if (key.escape) back();
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

  const availableCount = agents.filter((a) => a.available).length;

  return (
    <Box flexDirection="column">
      <Header view={view} screen={screen} availableCount={availableCount} agentTotal={agents.length} nowMs={nowMs} task={task} />
      {screen === 'list' ? (
        <RunList runs={runs} selected={selected} agents={agents} />
      ) : (
        <RunDetail view={view} nowMs={nowMs} />
      )}
      {compose.active ? (
        <Box>
          <Text>
            {compose.kind === 'new' ? 'new task' : 'note'} › <Text color="cyan">{compose.buffer}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}
      {notice ? <Text dimColor>{notice}</Text> : null}
      <Text dimColor>{hints(compose.active, screen)}</Text>
    </Box>
  );
}

function hints(composing: boolean, screen: Screen): string {
  if (composing) return '[enter] submit  [esc] cancel';
  if (screen === 'list') return '↑↓ select · [enter] attach · [i] new task · [q]uit';
  return '[x] stop · [p]ause/resume · [u] input · [s]ave · [esc] back · [i] new · [q]uit';
}

function Header({
  view,
  screen,
  availableCount,
  agentTotal,
  nowMs,
  task,
}: {
  view: RunView | null;
  screen: Screen;
  availableCount: number;
  agentTotal: number;
  nowMs: number;
  task?: string;
}): React.ReactElement {
  const title = view?.title ?? task ?? 'Omakase';
  const elapsed = view ? fmtDuration(elapsedOf(view, nowMs)) : '';
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text bold color="magenta">
          omakase{' '}
        </Text>
        <Text>{title.split('\n')[0]?.slice(0, 60)}</Text>
        {view ? (
          <Text>
            {' '}
            · <Text color={statusColor(view.status)}>{view.status}</Text>
          </Text>
        ) : null}
      </Box>
      <Text dimColor>
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
    <Box>
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
        {agents.map((a) => (
          <Text key={a.id}>
            <Text color={a.available ? 'green' : 'gray'}>{a.available ? '●' : '○'}</Text> {a.id}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function RunDetail({ view, nowMs }: { view: RunView | null; nowMs: number }): React.ReactElement {
  if (!view) return <Text dimColor>attaching…</Text>;
  return (
    <Box>
      <Box flexDirection="column" borderStyle="round" paddingX={1} width={34} marginRight={1}>
        <Text bold>Phases</Text>
        {view.phases.length === 0 ? <Text dimColor>no plan yet</Text> : null}
        {view.phases.map((p: PhaseView) => (
          <Text key={p.stage}>
            {p.done === p.total ? <Text color="green">✔</Text> : <Text dimColor>·</Text>} {p.stage}
            <Text dimColor>
              {'  '}
              {p.done}/{p.total}
            </Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
        <Text bold>Detail · {view.totalAgents} agents</Text>
        {view.tasks.map((t) => {
          const el = t.startedAt != null ? fmtDuration((t.finishedAt ?? nowMs) - t.startedAt) : '—';
          return (
            <Text key={t.id}>
              {taskIcon(t.status)} <Text dimColor>[{t.role}]</Text> {t.title.slice(0, 40)}
              <Text dimColor>
                {'   '}
                {t.tokens} tok · {t.toolCount} tools · {el}
              </Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
