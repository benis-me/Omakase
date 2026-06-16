/**
 * The Omakase TUI — a factory.ai-style single-column conversational REPL on
 * OpenTUI (run under Bun). One clean transcript column, orchestration shown
 * INLINE (route/plan/agents/diffs as they happen — no persistent sidebar), a
 * bottom input with a `›`/`$` prompt, and a status line. It is a pure CLIENT
 * over the detached daemon and reuses the framework-agnostic data layer
 * (RunControllerClient, SessionStore, reduceTranscript, parseComposerInput,
 * fuzzy). Quitting never cancels a run; only /stop (or esc) does.
 */
import React, { useEffect, useRef, useState } from 'react';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { KeyEvent } from '@opentui/core';
import type { SessionStore, WorkMode } from '@omakase/core';
import type { DetectedAgent } from '@omakase/daemon';
import type { RunControllerClient } from '../run-client.js';
import { initialRunView, type RunView, type TranscriptItem } from '../view-model.js';
import { parseComposerInput } from '../composer-parse.js';

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

const SLASH_COMMANDS = ['/new', '/sessions', '/stop', '/pause', '/resume', '/agent', '/web', '/clear', '/help'];
type OverlayKind = 'commands' | 'sessions' | 'agent';
interface SelItem { id: string; label: string; hint?: string }
interface FeedLine { text: string; tone: 'user' | 'agent' | 'ok' | 'bad' | 'dim' | 'bash' }

const THEME: Record<FeedLine['tone'], string | undefined> = {
  user: 'cyan', agent: undefined, ok: 'green', bad: 'red', dim: 'gray', bash: 'yellow',
};

function transcriptToFeed(items: TranscriptItem[], detail: boolean): FeedLine[] {
  const out: FeedLine[] = [];
  for (const it of items) {
    switch (it.kind) {
      case 'user-message': out.push({ text: `› ${it.text}`, tone: 'user' }); break;
      case 'route': if (detail) out.push({ text: `  ⏺ routed → ${it.routeKind} · ${it.reason}`, tone: 'dim' }); break;
      case 'plan': out.push({ text: `  ⏺ planned ${it.taskCount} task(s)`, tone: 'dim' }); break;
      case 'task-progress': {
        const g = it.status === 'started' ? '⏺' : it.status === 'succeeded' ? '✓' : '✗';
        out.push({ text: `  ${g} ${it.role}${it.agentLabel ? `[${it.agentLabel}]` : ''} ${it.title}`, tone: it.status === 'failed' ? 'bad' : 'agent' });
        break;
      }
      case 'review': out.push({ text: `  ⏺ review ${it.approved ? 'APPROVED' : 'REJECTED'} — ${it.notes}`, tone: it.approved ? 'ok' : 'bad' }); break;
      case 'report': if (detail) out.push({ text: `  ⏺ report: ${it.title}`, tone: 'dim' }); break;
      case 'workflow-phase': out.push({ text: `  ⏺ workflow ${it.status}: ${it.name}`, tone: 'dim' }); break;
      case 'finished': out.push({ text: `  ● ${it.status} — ${it.summary}`, tone: it.status === 'succeeded' ? 'ok' : 'bad' }); break;
    }
  }
  return out;
}

export function App(props: OtuiAppProps): React.ReactElement {
  const now = props.now ?? (() => Date.now());
  const dims = useTerminalDimensions();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('session');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [view, setView] = useState<RunView>(initialRunView(props.mode));
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [bashLog, setBashLog] = useState<FeedLine[]>([]);
  const [bashMode, setBashMode] = useState(false);
  const [detail, setDetail] = useState(true);
  const [notice, setNotice] = useState('shift+tab agent · ! bash · / commands · esc stop · ctrl+c quit');
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);
  const [overlayItems, setOverlayItems] = useState<SelItem[]>([]);
  const [mainAgent, setMainAgent] = useState<string | null>(null);
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [epoch, setEpoch] = useState(0); // bump to clear/remount the uncontrolled textarea

  const tailRef = useRef<() => void>(() => {});
  const composerRef = useRef('');
  const stateRef = useRef({ sessionId, activeRunId, status: view.status as RunView['status'], bashMode, overlay });
  stateRef.current = { sessionId, activeRunId, status: view.status, bashMode, overlay };

  function clearComposer(): void { composerRef.current = ''; setEpoch((e) => e + 1); }

  function attachRun(runId: string): void {
    tailRef.current();
    setActiveRunId(runId);
    tailRef.current = props.client.tailRun(runId, (u) => { setView(u.view); setTranscript(u.transcript); });
  }

  useEffect(() => {
    void (async () => {
      const existing = await props.sessions.list();
      let id = existing[0]?.id ?? null;
      let title = existing[0]?.title ?? 'session';
      if (!id) { const c = await props.sessions.create({ id: `ses-${now()}`, title: 'session', now: now() }); id = c.id; title = c.title; }
      setSessionId(id); setSessionTitle(title);
      if (props.token) {
        const runId = await props.client.resolveRunId(props.token);
        if (runId) { await props.sessions.appendRun(id, runId, now()); attachRun(runId); }
      }
    })();
    return () => tailRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!props.detect) return; let live = true;
    void props.detect().then((l) => live && setAgents(l));
    return () => { live = false; };
  }, [props.detect]);

  function appendBash(line: FeedLine): void { setBashLog((b) => [...b, line].slice(-200)); }

  async function runBash(cmd: string): Promise<void> {
    appendBash({ text: `$ ${cmd}`, tone: 'bash' });
    await new Promise<void>((resolve) => {
      execFile('sh', ['-lc', cmd], { cwd: props.cwd, timeout: 30_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
        const body = `${stdout}${stderr}`.trimEnd();
        if (body) for (const l of body.split('\n').slice(-40)) appendBash({ text: `  ${l}`, tone: 'dim' });
        if (err && !body) appendBash({ text: `  ${err.message}`, tone: 'bad' });
        resolve();
      });
    });
  }

  async function submit(raw: string): Promise<void> {
    const { sessionId: sid, activeRunId: runId, status, bashMode: bash } = stateRef.current;
    if (!raw.trim() || !sid) return;
    if (bash) { await runBash(raw.trim()); return; }
    const intent = parseComposerInput(raw);
    if (intent.kind === 'empty') return;
    if (intent.kind === 'command') return void runCommand(intent.name);
    if (runId && (status === 'running' || status === 'paused')) {
      await props.client.sendInput(runId, intent.kind === 'workflow' ? `/workflow ${intent.source}` : intent.prompt);
      setNotice('sent input to the running run'); return;
    }
    const session = await props.sessions.load(sid);
    const rollingSummary = session?.rollingSummary ?? '';
    const taskIntent = intent.kind === 'workflow'
      ? { prompt: intent.source, files: [] as string[] }
      : { prompt: intent.prompt, agentOverride: intent.agentOverride ?? mainAgent ?? undefined, files: intent.files };
    setNotice(intent.kind === 'workflow' ? 'running workflow' : 'submitted — waiting for the daemon');
    const tok = await props.client.submitToSession({ rollingSummary }, taskIntent);
    const created = await props.client.resolveRunId(tok);
    if (created) { await props.sessions.appendRun(sid, created, now()); attachRun(created); setNotice(''); }
  }

  async function runCommand(name: string): Promise<void> {
    const { activeRunId: runId } = stateRef.current;
    switch (name) {
      case 'stop': if (runId) await props.client.stop(runId); setNotice('stop requested'); break;
      case 'pause': if (runId) await props.client.pause(runId); break;
      case 'resume': if (runId) await props.client.resume(runId); break;
      case 'new': await newSession(); break;
      case 'sessions': await openOverlay('sessions'); break;
      case 'agent': await openOverlay('agent'); break;
      case 'web': setNotice(props.readOnlyUrl ? `report server: ${props.readOnlyUrl}` : 'no report server'); break;
      case 'clear': setBashLog([]); setNotice(''); break;
      case 'help': setNotice('shift+tab agent · ctrl+o detail · ! bash · / commands · esc stop · ctrl+c quit'); break;
      default: setNotice(`unknown command: /${name}`);
    }
  }

  async function newSession(): Promise<void> {
    const c = await props.sessions.create({ id: `ses-${now()}`, title: 'session', now: now() });
    tailRef.current(); setActiveRunId(null); setTranscript([]); setBashLog([]); setView(initialRunView(props.mode));
    setSessionId(c.id); setSessionTitle(c.title); setNotice('new session');
  }

  async function openOverlay(kind: OverlayKind): Promise<void> {
    if (kind === 'commands') setOverlayItems(SLASH_COMMANDS.map((c) => ({ id: c, label: c })));
    else if (kind === 'sessions') setOverlayItems((await props.sessions.list()).map((s) => ({ id: s.id, label: s.title, hint: `${s.runIds.length} runs` })));
    else setOverlayItems([{ id: '__auto__', label: 'auto', hint: 'router picks' }, ...agents.filter((a) => a.available).map((a) => ({ id: a.id, label: a.id, hint: a.authStatus }))]);
    setOverlay(kind);
  }

  function pickOverlay(item: SelItem): void {
    const kind = overlay; setOverlay(null);
    if (kind === 'commands') void runCommand(item.label.replace(/^\//, ''));
    else if (kind === 'sessions') void switchSession(item.id);
    else { setMainAgent(item.id === '__auto__' ? null : item.id); setNotice(`agent: ${item.id === '__auto__' ? 'auto' : item.id}`); }
  }

  async function switchSession(id: string): Promise<void> {
    const s = await props.sessions.load(id); if (!s) return;
    tailRef.current(); setActiveRunId(null); setTranscript([]); setBashLog([]); setView(initialRunView(props.mode));
    setSessionId(s.id); setSessionTitle(s.title);
    const latest = s.runIds.at(-1); if (latest) attachRun(latest);
  }

  function cycleAgent(dir: 1 | -1): void {
    const ids: Array<string | null> = [null, ...agents.filter((a) => a.available).map((a) => a.id)];
    const i = ids.indexOf(mainAgent);
    const next = ids[(i + dir + ids.length) % ids.length] ?? null;
    setMainAgent(next); setNotice(`agent: ${next ?? 'auto'}`);
  }

  useKeyboard((key: KeyEvent) => {
    if (stateRef.current.overlay) { if (key.name === 'escape') setOverlay(null); return; }
    if (key.name === 'tab' && key.shift) { cycleAgent(1); return; }
    if (key.ctrl && key.name === 'n') { cycleAgent(1); return; }
    if (key.ctrl && key.name === 'o') { setDetail((d) => !d); return; }
    if (key.ctrl && key.name === 'p') { void openOverlay('commands'); return; }
    if (key.name === 'escape') {
      if (stateRef.current.bashMode) { setBashMode(false); clearComposer(); return; }
      const { activeRunId: r, status } = stateRef.current;
      if (r && (status === 'running' || status === 'paused')) void runCommand('stop');
    }
  });

  // ── render ──────────────────────────────────────────────────────────
  const feed = [...transcriptToFeed(transcript, detail), ...bashLog];
  const tok = view.totalTokens;
  const cwdName = path.basename(props.cwd) || props.cwd;
  const statusLeft = `${props.mode} · ${mainAgent ?? 'auto'}${tok ? ` · ${tok} tok` : ''}${view.status === 'running' ? ' · running' : ''}`;
  const promptGlyph = bashMode ? '$' : '›';
  const selectOptions = overlayItems.map((i) => ({ name: i.hint ? `${i.label}  —  ${i.hint}` : i.label, value: i.id }));

  return (
    <box style={{ flexDirection: 'column', width: dims.width, height: dims.height }}>
      <box style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
        <text>{`omakase · ${cwdName} · ${sessionTitle}`}</text>
      </box>
      <scrollbox focused style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 }}>
        {feed.length === 0 ? (
          <text fg="gray">type a task and press enter · ! bash · / commands</text>
        ) : feed.map((l, i) => <text key={i} fg={THEME[l.tone]}>{l.text}</text>)}
        {view.status === 'running' && view.activity.length > 0 ? (
          <box style={{ flexDirection: 'column', marginTop: 1 }}>
            <text fg="magenta">▌ working…</text>
            <markdown content={view.activity.slice(-8).join('\n')} />
          </box>
        ) : null}
      </scrollbox>
      {overlay ? (
        <box style={{ flexDirection: 'column', flexShrink: 0, border: true, borderColor: 'cyan', paddingLeft: 1, paddingRight: 1 }}>
          <text>{`${overlay}  (↑↓ · enter · esc)`}</text>
          <select
            focused
            options={selectOptions}
            onSelect={(_i: number, opt: { value?: string } | null) => {
              const item = overlayItems.find((it) => it.id === opt?.value);
              if (item) pickOverlay(item);
            }}
          />
        </box>
      ) : (
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          <box style={{ flexDirection: 'row', border: true, borderColor: bashMode ? 'yellow' : 'gray', minHeight: 3, paddingLeft: 1, paddingRight: 1 }}>
            <text fg={bashMode ? 'yellow' : 'cyan'}>{`${promptGlyph} `}</text>
            <textarea
              key={epoch}
              focused={!overlay}
              placeholder={bashMode ? 'shell command…  (esc exits bash)' : 'message omakase…  (enter send · shift+enter newline)'}
              style={{ flexGrow: 1, minHeight: 1 }}
              onContentChange={(e: { text?: string; content?: string } | string) => {
                const v = typeof e === 'string' ? e : (e.text ?? e.content ?? '');
                composerRef.current = v;
                if (!stateRef.current.bashMode && v === '!') { setBashMode(true); clearComposer(); }
                else if (!stateRef.current.overlay && v === '/') { void openOverlay('commands'); clearComposer(); }
              }}
              onSubmit={() => { const raw = composerRef.current; clearComposer(); if (raw.trim()) void submit(raw); }}
            />
          </box>
          <box style={{ paddingLeft: 1, paddingRight: 1 }}>
            <text fg="gray">{`${statusLeft}    ${notice}`}</text>
          </box>
        </box>
      )}
    </box>
  );
}
