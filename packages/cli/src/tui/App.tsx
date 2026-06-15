/**
 * The Omakase TUI: an opencode-style conversational console over a detached
 * daemon. It is a pure CLIENT ({@link RunControllerClient}) — it never owns an
 * Orchestrator. A *session* groups multiple serial runs into one continuous
 * conversation: each task starts a background run whose event stream renders as
 * a chat transcript (left), while a sidebar (right, expanded by default) shows
 * the focused run's plan + agents. Quitting never cancels a run; relaunching
 * re-attaches. Only `/stop` cancels.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import type { DetectedAgent } from '@omakase/daemon';
import type { SessionStore, WorkMode } from '@omakase/core';
import type { DaemonStatus } from '../daemon-control.js';
import type { RunControllerClient } from '../run-client.js';
import { initialRunView, type RunView, type TranscriptItem } from '../view-model.js';
import { parseComposerInput } from '../composer-parse.js';
import { Session } from './Session.js';
import { Orchestration } from './Orchestration.js';
import { Editor } from './editor/Editor.js';

const SLASH_COMMANDS = [
  '/new',
  '/sessions',
  '/runs',
  '/stop',
  '/pause',
  '/resume',
  '/model',
  '/agent',
  '/workflow',
  '/web',
  '/clear',
  '/help',
];

/** Terminal size, kept in sync on resize so the UI fills and adapts. */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
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
  sessions: SessionStore;
  now?: () => number;
  /** Initial task already submitted by the CLI; its correlation token. */
  token?: string;
  /** Initial task text (for display / fallback submit). */
  task?: string;
  /** Local agent detection (for the agent override hints). */
  detect?: () => Promise<DetectedAgent[]>;
  /** Poll the project's daemon status for the header indicator. */
  daemonStatus?: () => Promise<DaemonStatus>;
  /** Stop the project's daemon. */
  stopDaemon?: () => Promise<unknown>;
  /** (Re)start the project's daemon. */
  startDaemon?: () => Promise<unknown>;
  /** Read-only local report/wiki server URL (surfaced via `/web`). */
  readOnlyUrl?: string;
}

type Focus = 'session' | 'sidebar' | 'composer';

export function App(props: AppProps): React.ReactElement {
  const now = props.now ?? (() => Date.now());
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const size = useTerminalSize();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('session');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [view, setView] = useState<RunView>(initialRunView(props.mode));
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>('composer');
  const [expanded, setExpanded] = useState(true); // sidebar expanded by default
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('');

  const tailRef = useRef<() => void>(() => {});
  // Mirror the bits onSubmit needs but that live in async closures, so the
  // single stable input handler always sees current values.
  const stateRef = useRef({ sessionId, activeRunId, status: view.status as RunView['status'] });
  stateRef.current = { sessionId, activeRunId, status: view.status };

  function attachRun(runId: string): void {
    tailRef.current();
    setActiveRunId(runId);
    tailRef.current = props.client.tailRun(runId, (u) => {
      setView(u.view);
      setTranscript(u.transcript);
    });
  }

  async function attachToken(sid: string, token: string): Promise<void> {
    const runId = await props.client.resolveRunId(token);
    if (!runId) return;
    await props.sessions.appendRun(sid, runId, now());
    attachRun(runId);
  }

  // ── session bootstrap ──────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      const existing = await props.sessions.list();
      let id = existing[0]?.id ?? null;
      let title = existing[0]?.title ?? 'session';
      if (!id) {
        const created = await props.sessions.create({ id: `ses-${now()}`, title: 'session', now: now() });
        id = created.id;
        title = created.title;
      }
      setSessionId(id);
      setSessionTitle(title);
      if (props.token) await attachToken(id, props.token);
    })();
    return () => tailRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── daemon status poll ─────────────────────────────────────────────
  useEffect(() => {
    if (!props.daemonStatus) return;
    let live = true;
    const tick = async (): Promise<void> => {
      const status = await props.daemonStatus!();
      if (live) setDaemon(status);
    };
    void tick();
    const t = setInterval(() => void tick(), 1500);
    t.unref?.();
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [props.daemonStatus]);

  async function onSubmit(raw: string): Promise<void> {
    const intent = parseComposerInput(raw);
    const { sessionId: sid, activeRunId: runId, status } = stateRef.current;
    if (intent.kind === 'empty' || !sid) return;
    if (intent.kind === 'command') return void handleCommand(intent.name, intent.args);

    // Serial within a session: a follow-up during an active run is an input note.
    if (runId && (status === 'running' || status === 'paused')) {
      const text = intent.kind === 'workflow' ? `/workflow ${intent.source}` : intent.prompt;
      await props.client.sendInput(runId, text);
      setNotice('sent input to the running run');
      return;
    }

    const session = await props.sessions.load(sid);
    const rollingSummary = session?.rollingSummary ?? '';
    const taskIntent =
      intent.kind === 'workflow'
        ? { prompt: intent.source, files: [] as string[] }
        : { prompt: intent.prompt, agentOverride: intent.agentOverride, files: intent.files };
    setNotice(intent.kind === 'workflow' ? 'running workflow' : 'submitted — waiting for the daemon');
    const token = await props.client.submitToSession({ rollingSummary }, taskIntent);
    const created = await props.client.resolveRunId(token);
    if (created) {
      await props.sessions.appendRun(sid, created, now());
      attachRun(created);
      setNotice('');
    }
  }

  async function handleCommand(name: string, args: string): Promise<void> {
    const { activeRunId: runId } = stateRef.current;
    switch (name) {
      case 'stop':
        if (runId) await props.client.stop(runId);
        setNotice('stop requested');
        break;
      case 'pause':
        if (runId) await props.client.pause(runId);
        setNotice('pause requested');
        break;
      case 'resume':
        if (runId) await props.client.resume(runId);
        setNotice('resume requested');
        break;
      case 'new': {
        const created = await props.sessions.create({ id: `ses-${now()}`, title: 'session', now: now() });
        tailRef.current();
        setActiveRunId(null);
        setTranscript([]);
        setView(initialRunView(props.mode));
        setSessionId(created.id);
        setSessionTitle(created.title);
        setNotice('new session');
        break;
      }
      case 'web':
        setNotice(props.readOnlyUrl ? `report server: ${props.readOnlyUrl}` : 'no report server');
        break;
      case 'clear':
        setNotice('');
        break;
      case 'help':
        setNotice('keys: [tab] focus  [o] sidebar  /stop /pause /resume /new /web /agent /model /workflow');
        break;
      default:
        setNotice(`unknown command: /${name}${args ? ' ' + args : ''}`);
    }
  }

  useInput(
    (input, key) => {
      if (key.tab) {
        setFocus((f) => (f === 'session' ? 'sidebar' : f === 'sidebar' ? 'composer' : 'session'));
        return;
      }
      if (focus !== 'composer') {
        if (input === 'o') setExpanded((e) => !e);
        if (input === 'q') exit(); // quit never cancels runs
      }
    },
    { isActive: isRawModeSupported },
  );

  const slashHint = draft.startsWith('/')
    ? SLASH_COMMANDS.filter((c) => c.startsWith(draft.split(/\s/)[0] ?? '')).join('  ')
    : '';
  const daemonText = daemon?.running ? `daemon up (${daemon.pid})` : daemon ? 'daemon down' : '';
  const headerText = `omakase${daemonText ? `  ·  ${daemonText}` : ''}  ·  ${view.activeAgents}/${view.totalAgents} agents`;
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Box paddingX={1}>
        <Text>{headerText}</Text>
      </Box>
      <Box flexGrow={1}>
        <Session
          transcript={transcript}
          title={sessionTitle}
          focused={focus === 'session'}
          rows={size.rows - 6}
        />
        <Orchestration view={view} focused={focus === 'sidebar'} expanded={expanded} />
      </Box>
      <Editor
        focused={focus === 'composer'}
        hint={slashHint || notice}
        onSubmit={(raw) => void onSubmit(raw)}
        onChange={setDraft}
      />
    </Box>
  );
}
