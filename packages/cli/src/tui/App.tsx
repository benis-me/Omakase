/**
 * The Omakase TUI. A thin Ink presentation layer over the {@link RunView}
 * reducer: it detects agents, optionally drives a run, and renders agents, the
 * task graph, the live event stream, knowledge status, and the active mode —
 * with pause/resume/cancel/replan keybindings. All run logic lives in
 * @omakase/core; this component only displays and forwards control intents.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { DetectedAgent } from '@omakase/daemon';
import type { Orchestrator, RunHandle, WorkMode } from '@omakase/core';
import type { AgentRuntime } from '@omakase/daemon';
import { initialRunView, reduceRunView, type RunView, type TaskView } from '../view-model.js';

export interface AppProps {
  runtime: AgentRuntime;
  orchestrator: Orchestrator;
  task?: string;
  cwd?: string;
  mode: WorkMode;
}

const MODES: WorkMode[] = ['max-power', 'normal', 'custom'];

function taskIcon(status: TaskView['status']): string {
  switch (status) {
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'running':
      return '▸';
    case 'blocked':
      return '⊘';
    case 'ready':
      return '○';
    case 'needs-review':
      return '⚖';
    case 'cancelled':
      return '∅';
    default:
      return '·';
  }
}

function statusColor(status: RunView['status']): string {
  if (status === 'succeeded') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'cancelled' || status === 'incomplete') return 'yellow';
  if (status === 'paused') return 'yellow';
  if (status === 'running') return 'cyan';
  return 'gray';
}

type ComposeMode = 'new' | 'note';

export function App({ runtime, orchestrator, task, cwd, mode: initialMode }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [mode, setMode] = useState<WorkMode>(initialMode);
  const [view, setView] = useState<RunView>(() => initialRunView(initialMode));
  const [compose, setCompose] = useState<{ active: boolean; mode: ComposeMode; buffer: string }>({
    active: false,
    mode: 'new',
    buffer: '',
  });
  const handleRef = useRef<RunHandle | null>(null);
  const activeRef = useRef(true);
  // Read the latest selected mode without re-creating driveRun on every keypress.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const driveRun = (taskText: string): void => {
    if (handleRef.current) return; // one run per orchestrator instance
    const handle = orchestrator.start({
      prompt: taskText,
      mode: modeRef.current,
      ...(cwd ? { cwd } : {}),
    });
    handleRef.current = handle;
    void (async () => {
      try {
        for await (const event of handle.events) {
          if (!activeRef.current) break;
          setView((v) => reduceRunView(v, event));
        }
      } catch {
        /* stream ended */
      } finally {
        // Without a raw-mode TTY (piped stdin / CI) there is no way to press
        // [q], so the app would hang forever after the run ends. Exit once the
        // event stream completes. Interactive sessions stay open for review.
        if (activeRef.current && !isRawModeSupported) exit();
      }
    })();
  };

  useEffect(() => {
    activeRef.current = true;
    void runtime
      .detect()
      .then((list) => {
        if (activeRef.current) setAgents(list);
      })
      .catch(() => undefined);

    if (task) driveRun(task);

    return () => {
      activeRef.current = false;
      handleRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput(
    (input, key) => {
      // Text-composer mode: accumulate a new task / a custom user-input note.
      if (compose.active) {
        if (key.return) {
          const text = compose.buffer.trim();
          const composeMode = compose.mode;
          setCompose({ active: false, mode: composeMode, buffer: '' });
          if (!text) return;
          if (composeMode === 'new') driveRun(text);
          else handleRef.current?.appendUserInput(text);
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
        handleRef.current?.cancel();
        exit();
      } else if (input === 'p') {
        handleRef.current?.pause();
      } else if (input === 'r') {
        handleRef.current?.resume();
      } else if (input === 'c') {
        handleRef.current?.cancel();
      } else if (input === 'i' && handleRef.current === null && !task) {
        // Idle with no preset task → compose one interactively.
        setCompose({ active: true, mode: 'new', buffer: '' });
      } else if (input === 'u' && handleRef.current !== null) {
        // During a run → compose a custom note to feed the orchestrator.
        setCompose({ active: true, mode: 'note', buffer: '' });
      } else if (input === 'm') {
        // A run's mode is fixed once it starts; only let the user pick a mode
        // when no run has been started (gate on the handle, not transient
        // view.status — run-started arrives a microtask after start()), so the
        // header never claims a mode the orchestrator isn't actually using.
        if (!task && handleRef.current === null) {
          setMode((current) => MODES[(MODES.indexOf(current) + 1) % MODES.length]!);
        }
      }
    },
    { isActive: isRawModeSupported },
  );

  const availableCount = agents.filter((a) => a.available).length;
  // Show the running mode once a run starts; the selectable mode only while idle.
  const displayMode = view.status === 'idle' ? mode : view.mode;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="magenta">
          Omakase{' '}
        </Text>
        <Text>
          mode=<Text color="cyan">{displayMode}</Text> · run=
          <Text color={statusColor(view.status)}>{view.status}</Text>
          {view.runId ? <Text dimColor> ({view.runId})</Text> : null}
        </Text>
      </Box>

      <Box>
        <Box flexDirection="column" borderStyle="round" paddingX={1} width={34} marginRight={1}>
          <Text bold>Agents ({availableCount}/{agents.length})</Text>
          {agents.length === 0 ? <Text dimColor>detecting…</Text> : null}
          {agents.map((a) => (
            <Text key={a.id}>
              <Text color={a.available ? 'green' : 'gray'}>{a.available ? '●' : '○'}</Text> {a.id}
              {a.version ? <Text dimColor> {a.version.split(' ')[0]}</Text> : null}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
          <Text bold>Task graph</Text>
          {view.tasks.length === 0 ? <Text dimColor>no plan yet</Text> : null}
          {view.tasks.map((t) => (
            <Text key={t.id}>
              {taskIcon(t.status)} <Text dimColor>[{t.role}]</Text> {t.title}
            </Text>
          ))}
          {view.route ? (
            <Text dimColor>route: {view.route.kind}</Text>
          ) : null}
        </Box>
      </Box>

      <Box>
        <Box borderStyle="round" paddingX={1} marginRight={1}>
          <Text>
            wiki=<Text color="cyan">{view.wikiEntries}</Text>
            {view.codegraphFiles != null ? <Text> · files={view.codegraphFiles}</Text> : null}
          </Text>
        </Box>
        {view.lastReview ? (
          <Box borderStyle="round" paddingX={1}>
            <Text>
              review:{' '}
              <Text color={view.lastReview.approved ? 'green' : 'red'}>
                {view.lastReview.approved ? 'APPROVED' : 'REJECTED'}
              </Text>
            </Text>
          </Box>
        ) : null}
      </Box>

      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Stream</Text>
        {view.events.slice(-8).map((line, i) => (
          <Text key={`${i}-${line.slice(0, 8)}`}>{line}</Text>
        ))}
      </Box>

      {view.summary ? (
        <Text color={statusColor(view.status)}>{view.summary}</Text>
      ) : null}

      {compose.active ? (
        <Box>
          <Text>
            {compose.mode === 'new' ? 'new task' : 'note'} ›{' '}
            <Text color="cyan">{compose.buffer}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}

      <Text dimColor>{hints(compose.active, handleRef.current !== null)}</Text>
    </Box>
  );
}

function hints(composing: boolean, running: boolean): string {
  if (composing) return '[enter] submit  [esc] cancel';
  if (running) return '[p]ause [r]esume [c]ancel [u] add-input [q]uit';
  return '[i] new task  [m] mode  [q]uit';
}
