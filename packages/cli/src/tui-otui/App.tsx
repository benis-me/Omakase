/**
 * The Omakase TUI, rebuilt on OpenTUI (the framework opencode itself uses) and
 * run under Bun. It is a pure CLIENT over the detached daemon — it reuses the
 * framework-agnostic data layer (RunControllerClient, SessionStore,
 * reduceTranscript, parseComposerInput, fuzzy, leader) and renders with native
 * OpenTUI primitives: <textarea> (real multiline editor), <markdown>/<diff>,
 * <select>, <scrollbox>. Quitting never cancels a run; only /stop (or esc) does.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { KeyEvent } from '@opentui/core';
import type { SessionStore, WorkMode } from '@omakase/core';
import type { DetectedAgent } from '@omakase/daemon';
import type { RunControllerClient } from '../run-client.js';
import { initialRunView, type RunView, type TranscriptItem } from '../view-model.js';
import { parseComposerInput } from '../composer-parse.js';
import { fuzzyFilter } from '../tui/overlay/fuzzy.js';
import { resolveLeader, LEADER_HINT, type LeaderAction } from '../tui/leader.js';

export interface OtuiAppProps {
  client: RunControllerClient;
  sessions: SessionStore;
  cwd: string;
  mode: WorkMode;
  token?: string;
  readOnlyUrl?: string;
  detect?: () => Promise<DetectedAgent[]>;
  daemonStatus?: () => Promise<{ running: boolean; pid: number | null }>;
  stopDaemon?: () => Promise<unknown>;
  now?: () => number;
}

type Focus = 'composer' | 'transcript' | 'sidebar';
type OverlayKind = 'commands' | 'sessions' | 'model' | 'agent';

const SLASH_COMMANDS = [
  '/new', '/sessions', '/runs', '/stop', '/pause', '/resume',
  '/model', '/agent', '/workflow', '/web', '/clear', '/help',
];

interface SelItem { id: string; label: string; hint?: string }

const STATUS_GLYPH: Record<string, string> = {
  succeeded: '✓', running: '▸', failed: '✗', cancelled: '⊘', blocked: '◌', pending: '◷',
};

export function App(props: OtuiAppProps): React.ReactElement {
  const now = props.now ?? (() => Date.now());
  const dims = useTerminalDimensions();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('session');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [view, setView] = useState<RunView>(initialRunView(props.mode));
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>('composer');
  const [daemon, setDaemon] = useState<{ running: boolean; pid: number | null } | null>(null);
  const [notice, setNotice] = useState('ctrl+x leader · ctrl+p palette · enter send');
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);
  const [overlayItems, setOverlayItems] = useState<SelItem[]>([]);
  const [mainAgent, setMainAgent] = useState<string | null>(null);
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [leaderArmed, setLeaderArmed] = useState(false);

  const tailRef = useRef<() => void>(() => {});
  const composerRef = useRef('');
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

  // bootstrap session + initial token
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
      if (props.token) {
        const runId = await props.client.resolveRunId(props.token);
        if (runId) {
          await props.sessions.appendRun(id, runId, now());
          attachRun(runId);
        }
      }
    })();
    return () => tailRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // detected agents
  useEffect(() => {
    if (!props.detect) return;
    let live = true;
    void props.detect().then((l) => live && setAgents(l));
    return () => { live = false; };
  }, [props.detect]);

  // daemon status
  useEffect(() => {
    if (!props.daemonStatus) return;
    let live = true;
    const tick = async (): Promise<void> => { const s = await props.daemonStatus!(); if (live) setDaemon(s); };
    void tick();
    const t = setInterval(() => void tick(), 1500);
    (t as { unref?: () => void }).unref?.();
    return () => { live = false; clearInterval(t); };
  }, [props.daemonStatus]);

  async function submit(raw: string): Promise<void> {
    const intent = parseComposerInput(raw);
    const { sessionId: sid, activeRunId: runId, status } = stateRef.current;
    if (intent.kind === 'empty' || !sid) return;
    if (intent.kind === 'command') return void runCommand(intent.name);
    if (runId && (status === 'running' || status === 'paused')) {
      await props.client.sendInput(runId, intent.kind === 'workflow' ? `/workflow ${intent.source}` : intent.prompt);
      setNotice('sent input to the running run');
      return;
    }
    const session = await props.sessions.load(sid);
    const rollingSummary = session?.rollingSummary ?? '';
    const taskIntent =
      intent.kind === 'workflow'
        ? { prompt: intent.source, files: [] as string[] }
        : { prompt: intent.prompt, agentOverride: intent.agentOverride ?? mainAgent ?? undefined, files: intent.files };
    setNotice(intent.kind === 'workflow' ? 'running workflow' : 'submitted — waiting for the daemon');
    const tok = await props.client.submitToSession({ rollingSummary }, taskIntent);
    const created = await props.client.resolveRunId(tok);
    if (created) {
      await props.sessions.appendRun(sid, created, now());
      attachRun(created);
      setNotice('');
    }
  }

  async function runCommand(name: string): Promise<void> {
    const { activeRunId: runId } = stateRef.current;
    switch (name) {
      case 'stop': if (runId) await props.client.stop(runId); setNotice('stop requested'); break;
      case 'pause': if (runId) await props.client.pause(runId); break;
      case 'resume': if (runId) await props.client.resume(runId); break;
      case 'new': await newSession(); break;
      case 'sessions': void openOverlay('sessions'); break;
      case 'model': case 'agent': void openOverlay(name); break;
      case 'web': setNotice(props.readOnlyUrl ? `report server: ${props.readOnlyUrl}` : 'no report server'); break;
      case 'clear': setNotice(''); break;
      case 'help': setNotice(LEADER_HINT); break;
      default: setNotice(`unknown command: /${name}`);
    }
  }

  async function newSession(): Promise<void> {
    const created = await props.sessions.create({ id: `ses-${now()}`, title: 'session', now: now() });
    tailRef.current();
    setActiveRunId(null);
    setTranscript([]);
    setView(initialRunView(props.mode));
    setSessionId(created.id);
    setSessionTitle(created.title);
    setNotice('new session');
  }

  async function openOverlay(kind: OverlayKind): Promise<void> {
    if (kind === 'commands') setOverlayItems(SLASH_COMMANDS.map((c) => ({ id: c, label: c })));
    else if (kind === 'sessions') {
      const list = await props.sessions.list();
      setOverlayItems(list.map((s) => ({ id: s.id, label: s.title, hint: `${s.runIds.length} runs` })));
    } else {
      setOverlayItems([
        { id: '__auto__', label: 'auto', hint: 'router picks' },
        ...agents.filter((a) => a.available).map((a) => ({ id: a.id, label: a.id, hint: a.authStatus })),
      ]);
    }
    setOverlay(kind);
  }

  async function pickOverlay(item: SelItem): Promise<void> {
    const kind = overlay;
    setOverlay(null);
    if (kind === 'commands') void runCommand(item.label.replace(/^\//, ''));
    else if (kind === 'sessions') void switchSession(item.id);
    else { setMainAgent(item.id === '__auto__' ? null : item.id); setNotice(`main agent: ${item.id === '__auto__' ? 'auto' : item.id}`); }
  }

  async function switchSession(id: string): Promise<void> {
    const s = await props.sessions.load(id);
    if (!s) return;
    tailRef.current();
    setActiveRunId(null);
    setTranscript([]);
    setView(initialRunView(props.mode));
    setSessionId(s.id);
    setSessionTitle(s.title);
    const latest = s.runIds.at(-1);
    if (latest) attachRun(latest);
  }

  function dispatchLeader(action: LeaderAction): void {
    if (action === 'new-session') void newSession();
    else if (action === 'sidebar') setFocus((f) => (f === 'sidebar' ? 'composer' : 'sidebar'));
    else if (action === 'quit') process.exit(0);
    else void runCommand(action);
  }

  useKeyboard((key: KeyEvent) => {
    if (overlay) {
      if (key.name === 'escape') setOverlay(null);
      return; // the <select> handles navigation/selection
    }
    if (leaderArmed) {
      setLeaderArmed(false);
      const action = resolveLeader(key.name ?? '');
      if (action) dispatchLeader(action);
      return;
    }
    if (key.ctrl && key.name === 'x') { setLeaderArmed(true); return; }
    if (key.ctrl && key.name === 'p') { void openOverlay('commands'); return; }
    if (key.name === 'tab') {
      setFocus((f) => (f === 'composer' ? 'transcript' : f === 'transcript' ? 'sidebar' : 'composer'));
      return;
    }
    if (key.name === 'escape' && activeRunId && (view.status === 'running' || view.status === 'paused')) {
      void runCommand('stop');
    }
  });

  // ── render ──────────────────────────────────────────────────────────
  const daemonText = daemon?.running ? `daemon up (${daemon.pid})` : daemon ? 'daemon down' : '';
  const statusText = ['omakase', `session ${sessionTitle}`, `agent ${mainAgent ?? 'auto'}`, props.mode, daemonText, `${view.activeAgents}/${view.totalAgents} agents`]
    .filter(Boolean).join('  ·  ');
  const streaming = view.status === 'running' ? view.activity.slice(-8) : [];
  const selectOptions = fuzzyFilter(overlayItems, '', (i) => i.label).map((i) => ({
    name: i.hint ? `${i.label}  —  ${i.hint}` : i.label,
    value: i.id,
  }));

  return (
    <box style={{ flexDirection: 'column', width: dims.width, height: dims.height }}>
      <box style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text>{statusText}</text>
      </box>
      <box style={{ flexGrow: 1, flexDirection: 'row' }}>
        <scrollbox
          focused={focus === 'transcript'}
          style={{ flexGrow: 1, border: true, borderColor: focus === 'transcript' ? 'cyan' : 'gray', padding: 1 }}
        >
          <text>{`session · ${sessionTitle}`}</text>
          {transcript.length === 0 && streaming.length === 0 ? (
            <text>type a task below — the router will plan and dispatch agents</text>
          ) : (
            transcript.map((item, i) => <TranscriptLine key={i} item={item} />)
          )}
          {streaming.length > 0 ? (
            <box style={{ flexDirection: 'column', marginTop: 1 }}>
              <text>▌ assistant</text>
              <markdown content={streaming.join('\n')} />
            </box>
          ) : null}
        </scrollbox>
        <box style={{ flexDirection: 'column', border: true, borderColor: focus === 'sidebar' ? 'cyan' : 'gray', padding: 1, minWidth: 28 }}>
          <text>{`run ▸ ${view.activeAgents} agents`}</text>
          <text>Plan</text>
          {view.phases.length === 0 ? <text> no plan yet</text> : view.phases.map((p) => (
            <text key={p.stage}>{` ${p.done === p.total ? '✓' : '▸'} ${p.stage} ${p.done}/${p.total}`}</text>
          ))}
          <text>Tasks</text>
          {view.tasks.slice(0, 12).map((t) => (
            <text key={t.id}>{` ${STATUS_GLYPH[t.status] ?? '·'} ${t.title}`}</text>
          ))}
        </box>
      </box>
      {overlay ? (
        <box style={{ flexDirection: 'column', border: true, borderColor: 'cyan', padding: 1 }}>
          <text>{`${overlay}  (↑↓ · enter · esc)`}</text>
          <select
            focused
            options={selectOptions}
            onSelect={(_i: number, opt: { value?: string } | null) => {
              const item = overlayItems.find((it) => it.id === opt?.value);
              if (item) void pickOverlay(item);
            }}
          />
        </box>
      ) : (
        <box style={{ flexDirection: 'column' }}>
          <box style={{ border: true, borderColor: focus === 'composer' ? 'cyan' : 'gray', paddingLeft: 1, paddingRight: 1 }}>
            <textarea
              focused={focus === 'composer'}
              placeholder="message omakase…  (enter send · ctrl+j newline)"
              onContentChange={(e: { text?: string; content?: string } | string) => {
                composerRef.current = typeof e === 'string' ? e : (e.text ?? e.content ?? '');
              }}
              onSubmit={() => {
                const raw = composerRef.current;
                composerRef.current = '';
                if (raw.trim()) void submit(raw);
              }}
            />
          </box>
          <text>{leaderArmed ? LEADER_HINT : notice}</text>
        </box>
      )}
    </box>
  );
}

function TranscriptLine({ item }: { item: TranscriptItem }): React.ReactElement {
  switch (item.kind) {
    case 'user-message':
      return <text>{`› ${item.text}`}</text>;
    case 'route':
      return <text>{`  ↪ router → ${item.routeKind} (${item.reason})`}</text>;
    case 'plan':
      return <text>{`  ▤ planned ${item.taskCount} task(s)`}</text>;
    case 'task-progress':
      return <text>{`  ${item.status === 'started' ? '▸' : item.status === 'succeeded' ? '✓' : '✗'} ${item.role}${item.agentLabel ? `[${item.agentLabel}]` : ''} ${item.title}`}</text>;
    case 'review':
      return <text>{`  ⚖ ${item.approved ? 'APPROVED' : 'REJECTED'} — ${item.notes}`}</text>;
    case 'report':
      return <text>{`  ▣ report: ${item.title}`}</text>;
    case 'workflow-phase':
      return <text>{`  ▧ workflow ${item.status}: ${item.name}`}</text>;
    case 'finished':
      return <text>{`  ■ ${item.status} — ${item.summary}`}</text>;
  }
}
