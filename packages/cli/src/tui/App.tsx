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

export function App({ runtime, orchestrator, task, cwd, mode: initialMode }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [mode, setMode] = useState<WorkMode>(initialMode);
  const [view, setView] = useState<RunView>(() => initialRunView(initialMode));
  const handleRef = useRef<RunHandle | null>(null);

  useEffect(() => {
    let active = true;
    void runtime
      .detect()
      .then((list) => {
        if (active) setAgents(list);
      })
      .catch(() => undefined);

    if (task) {
      const handle = orchestrator.start({
        prompt: task,
        mode: initialMode,
        ...(cwd ? { cwd } : {}),
      });
      handleRef.current = handle;
      void (async () => {
        try {
          for await (const event of handle.events) {
            if (!active) break;
            setView((v) => reduceRunView(v, event));
          }
        } catch {
          /* stream ended */
        }
      })();
    }

    return () => {
      active = false;
      handleRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput(
    (input) => {
      if (input === 'q') {
        handleRef.current?.cancel();
        exit();
      } else if (input === 'p') {
        handleRef.current?.pause();
      } else if (input === 'r') {
        handleRef.current?.resume();
      } else if (input === 'c') {
        handleRef.current?.cancel();
      } else if (input === 'u') {
        handleRef.current?.appendUserInput('Reviewer note: keep going and harden edge cases.');
      } else if (input === 'm') {
        // A run's mode is fixed once it starts; only let the user pick a mode
        // while idle (e.g. the TUI was opened without a task) so the header
        // never claims a mode the orchestrator isn't actually using.
        if (view.status === 'idle') {
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

      <Text dimColor>[p]ause [r]esume [c]ancel [u] add-input [m] mode [q]uit</Text>
    </Box>
  );
}
