/**
 * The Omakase TUI — a single-column conversational REPL (factory.ai × opencode)
 * on OpenTUI/Bun. A pure CLIENT over the detached daemon: it reuses the
 * data layer (RunControllerClient, SessionStore) and the pure UI logic
 * (parseInput, mapKey, buildFeed, fuzzyFilter) and just paints + routes keys.
 * Orchestration is shown INLINE in the feed; no persistent sidebar. Quitting
 * never cancels a run; only /stop or esc does.
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
import { parseInput } from '../composer.js';
import { fuzzyFilter } from '../fuzzy.js';
import { mapKey, type Action } from '../keymap.js';
import { buildFeed, type FeedLine } from '../feed.js';
import { Composer } from './Composer.js';
import { Transcript } from './Transcript.js';
import { StatusLine } from './StatusLine.js';
import { Palette, type PaletteItem } from './Palette.js';
import { GatePrompt } from './GatePrompt.js';

export interface OtuiAppProps {
  client: RunControllerClient;
  sessions: SessionStore;
  cwd: string;
  mode: WorkMode;
  token?: string;
  readOnlyUrl?: string;
  detect?: () => Promise<DetectedAgent[]>;
  daemonStatus?: () => Promise<{ running: boolean; pid: number | null }>;
  now?: () => number;
}

type UiMode = 'auto' | 'plan' | 'mission';
type OverlayKind = 'commands' | 'sessions' | 'agent';
const COMMANDS = ['/new', '/sessions', '/stop', '/pause', '/resume', '/agent', '/web', '/clear', '/help'];
const MODE_PREFIX: Record<UiMode, string> = {
  auto: '',
  plan: 'First produce a short plan, then execute it.\n\n',
  mission: 'Use multiple specialized agents to complete this.\n\n',
};
const HELP = 'enter send · shift+enter newline · ! bash · / commands · @file · shift+tab mode · ctrl+n agent · ctrl+o detail · esc stop · ctrl+c quit';

export function App(props: OtuiAppProps): React.ReactElement {
  const now = props.now ?? (() => Date.now());
  const dims = useTerminalDimensions();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('session');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [view, setView] = useState<RunView>(initialRunView(props.mode));
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [bashMode, setBashMode] = useState(false);
  const [bashLog, setBashLog] = useState<FeedLine[]>([]);
  const [detail, setDetail] = useState(true);
  const [scroll, setScroll] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [notice, setNotice] = useState(HELP);
  const [overlay, setOverlay] = useState<{ kind: OverlayKind; items: PaletteItem[] } | null>(null);
  const [uiMode, setUiMode] = useState<UiMode>('auto');
  const [mainAgent, setMainAgent] = useState<string | null>(null);
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [daemon, setDaemon] = useState<{ running: boolean; pid: number | null } | null>(null);
  const [leaderArmed, setLeaderArmed] = useState(false);

  const tailRef = useRef<() => void>(() => {});
  const composerRef = useRef('');
  const leaderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gate = view.riskGates.find((g) => g.status === 'open') ?? null;
  const feed = buildFeed(transcript, bashLog, { detail });
  const ref = useRef({ sessionId, activeRunId, status: view.status, bashMode, overlayOpen: false, leaderArmed, feedLen: feed.length, gateOpen: Boolean(gate) });
  ref.current = { sessionId, activeRunId, status: view.status, bashMode, overlayOpen: Boolean(overlay), leaderArmed, feedLen: feed.length, gateOpen: Boolean(gate) };

  function clearComposer(): void { composerRef.current = ''; setEpoch((e) => e + 1); }
  function attachRun(runId: string): void {
    tailRef.current();
    setActiveRunId(runId);
    setScroll(0);
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

  useEffect(() => {
    if (!props.daemonStatus) return; let live = true;
    const tick = async (): Promise<void> => { const s = await props.daemonStatus!(); if (live) setDaemon(s); };
    void tick();
    const t = setInterval(() => void tick(), 1500); (t as { unref?: () => void }).unref?.();
    return () => { live = false; clearInterval(t); };
  }, [props.daemonStatus]);

  // ── actions ─────────────────────────────────────────────────────────
  function cycleAgent(dir: 1 | -1): void {
    const ids: Array<string | null> = [null, ...agents.filter((a) => a.available).map((a) => a.id)];
    const i = ids.indexOf(mainAgent);
    const next = ids[(i + dir + ids.length) % ids.length] ?? null;
    setMainAgent(next); setNotice(`agent: ${next ?? 'auto'}`);
  }
  function cycleMode(): void {
    const order: UiMode[] = ['auto', 'plan', 'mission'];
    const next = order[(order.indexOf(uiMode) + 1) % order.length]!;
    setUiMode(next); setNotice(`mode: ${next}`);
  }
  async function openOverlay(kind: OverlayKind): Promise<void> {
    let items: PaletteItem[] = [];
    if (kind === 'commands') items = COMMANDS.map((c) => ({ id: c, label: c }));
    else if (kind === 'sessions') items = (await props.sessions.list()).map((s) => ({ id: s.id, label: s.title, hint: `${s.runIds.length} runs` }));
    else items = [{ id: '__auto__', label: 'auto', hint: 'router picks' }, ...agents.filter((a) => a.available).map((a) => ({ id: a.id, label: a.id, hint: a.authStatus }))];
    setOverlay({ kind, items });
  }
  function pickOverlay(id: string): void {
    const kind = overlay?.kind; setOverlay(null);
    if (kind === 'commands') void runCommand(id.replace(/^\//, ''));
    else if (kind === 'sessions') void switchSession(id);
    else { setMainAgent(id === '__auto__' ? null : id); setNotice(`agent: ${id === '__auto__' ? 'auto' : id}`); }
  }
  async function switchSession(id: string): Promise<void> {
    const s = await props.sessions.load(id); if (!s) return;
    tailRef.current(); setActiveRunId(null); setTranscript([]); setBashLog([]); setView(initialRunView(props.mode)); setScroll(0);
    setSessionId(s.id); setSessionTitle(s.title);
    const latest = s.runIds.at(-1); if (latest) attachRun(latest);
  }
  async function newSession(): Promise<void> {
    const c = await props.sessions.create({ id: `ses-${now()}`, title: 'session', now: now() });
    tailRef.current(); setActiveRunId(null); setTranscript([]); setBashLog([]); setView(initialRunView(props.mode)); setScroll(0);
    setSessionId(c.id); setSessionTitle(c.title); setNotice('new session');
  }
  async function runCommand(name: string): Promise<void> {
    const runId = ref.current.activeRunId;
    switch (name) {
      case 'stop': if (runId) await props.client.stop(runId); setNotice('stop requested'); break;
      case 'pause': if (runId) await props.client.pause(runId); break;
      case 'resume': if (runId) await props.client.resume(runId); break;
      case 'new': await newSession(); break;
      case 'sessions': await openOverlay('sessions'); break;
      case 'agent': await openOverlay('agent'); break;
      case 'web': setNotice(props.readOnlyUrl ? `report server: ${props.readOnlyUrl}` : 'no report server'); break;
      case 'clear': setBashLog([]); setNotice(HELP); break;
      case 'help': setNotice(HELP); break;
      default: setNotice(`unknown command: /${name}`);
    }
  }
  function appendBash(line: FeedLine): void { setBashLog((b) => [...b, line].slice(-200)); }
  async function runBash(cmd: string): Promise<void> {
    appendBash({ text: `$ ${cmd}`, tone: 'bash' });
    await new Promise<void>((resolve) => {
      execFile('sh', ['-lc', cmd], { cwd: props.cwd, timeout: 30_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
        const body = `${stdout}${stderr}`.trimEnd();
        if (body) for (const l of body.split('\n').slice(-40)) appendBash({ text: `  ${l}`, tone: 'dim' });
        else if (err) appendBash({ text: `  ${err.message}`, tone: 'bad' });
        resolve();
      });
    });
  }
  async function submitTask(prompt: string, agentOverride: string | undefined, files: string[]): Promise<void> {
    const sid = ref.current.sessionId; if (!sid) return;
    const runId = ref.current.activeRunId;
    if (runId && (ref.current.status === 'running' || ref.current.status === 'paused')) {
      await props.client.sendInput(runId, prompt); setNotice('sent input to the running run'); return;
    }
    const session = await props.sessions.load(sid);
    const composed = MODE_PREFIX[uiMode] + prompt;
    setNotice('submitted — waiting for the daemon');
    const tok = await props.client.submitToSession({ rollingSummary: session?.rollingSummary ?? '' }, { prompt: composed, agentOverride: agentOverride ?? mainAgent ?? undefined, files });
    const created = await props.client.resolveRunId(tok);
    if (created) { await props.sessions.appendRun(sid, created, now()); attachRun(created); setNotice(''); }
  }
  function onComposerSubmit(): void {
    const raw = composerRef.current; clearComposer();
    if (!raw.trim()) return;
    if (ref.current.bashMode) { void runBash(raw.trim()); return; }
    const intent = parseInput(raw);
    if (intent.kind === 'empty') return;
    if (intent.kind === 'bash') { void runBash(intent.command); return; }
    if (intent.kind === 'command') { void runCommand(intent.name); return; }
    if (intent.kind === 'workflow') { void submitTask(`/workflow ${intent.source}`, undefined, []); return; }
    void submitTask(intent.prompt, intent.agentOverride, intent.files);
  }

  function dispatch(action: Action): void {
    switch (action.type) {
      case 'close-overlay': setOverlay(null); break;
      case 'palette': void openOverlay('commands'); break;
      case 'arm-leader':
        setLeaderArmed(true);
        if (leaderTimer.current) clearTimeout(leaderTimer.current);
        leaderTimer.current = setTimeout(() => setLeaderArmed(false), 2000);
        (leaderTimer.current as { unref?: () => void }).unref?.();
        break;
      case 'sessions': void openOverlay('sessions'); break;
      case 'new-session': void newSession(); break;
      case 'pick-agent': void openOverlay('agent'); break;
      case 'cycle-agent': cycleAgent(action.dir); break;
      case 'cycle-mode': cycleMode(); break;
      case 'toggle-detail': setDetail((d) => !d); break;
      case 'exit-bash': setBashMode(false); clearComposer(); break;
      case 'interrupt': void runCommand('stop'); break;
      case 'help': setNotice(HELP); break;
      case 'scroll': {
        const max = ref.current.feedLen;
        if (action.by === 'top') setScroll(max);
        else if (action.by === 'bottom') setScroll(0);
        else setScroll((s) => Math.max(0, Math.min(max, s - action.by)));
        break;
      }
      default: break;
    }
  }

  useKeyboard((key: KeyEvent) => {
    const c = ref.current;
    const action = mapKey(key, { leaderArmed: c.leaderArmed, bashMode: c.bashMode, overlayOpen: c.overlayOpen || c.gateOpen, runActive: c.status === 'running' || c.status === 'paused' });
    if (c.leaderArmed) setLeaderArmed(false);
    dispatch(action);
  });

  // ── render ──────────────────────────────────────────────────────────
  const cwdName = path.basename(props.cwd) || props.cwd;
  const daemonText = daemon?.running ? `daemon up (${daemon.pid})` : daemon ? 'daemon down' : '';
  const streaming = view.status === 'running' ? view.activity : [];
  return (
    <box style={{ flexDirection: 'column', width: dims.width, height: dims.height }}>
      <box style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
        <text>{`omakase · ${cwdName} · ${sessionTitle}`}</text>
      </box>
      <Transcript feed={feed} streaming={streaming} scroll={scroll} emptyHint="type a task and press enter · ! bash · / commands · @file" />
      {gate && activeRunId ? (
        <GatePrompt question={gate.question} onAnswer={(a) => void props.client.answerGate(activeRunId, gate.id, a)} />
      ) : overlay ? (
        <Palette title={overlay.kind} items={fuzzyFilter(overlay.items, '', (i) => i.label)} onPick={pickOverlay} />
      ) : (
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          <Composer
            glyph={bashMode ? '$' : '›'}
            placeholder={bashMode ? 'shell command…  (esc exits bash)' : 'message omakase…  (enter send · shift+enter newline)'}
            bashMode={bashMode}
            focused
            epoch={epoch}
            onContentChange={(v) => {
              composerRef.current = v;
              if (!ref.current.bashMode && v === '!') { setBashMode(true); clearComposer(); }
              else if (!ref.current.overlayOpen && v === '/') { void openOverlay('commands'); clearComposer(); }
            }}
            onSubmit={onComposerSubmit}
          />
          <StatusLine mode={uiMode} agent={mainAgent ?? 'auto'} tokens={view.totalTokens} daemon={daemonText} hint={leaderArmed ? 'leader: l sessions · n new · m agent' : notice} />
        </box>
      )}
    </box>
  );
}
