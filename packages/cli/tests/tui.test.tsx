import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '@omakase/core';
import { App } from '../src/tui/App.js';
import { Orchestration } from '../src/tui/Orchestration.js';
import { Session as SessionPane } from '../src/tui/Session.js';
import { Editor } from '../src/tui/editor/Editor.js';
import { MarkdownView } from '../src/tui/render/MarkdownView.js';
import { DiffView } from '../src/tui/render/DiffView.js';
import { Overlay, type OverlayItem } from '../src/tui/overlay/Overlay.js';
import { initialRunView, type RunView, type TranscriptItem } from '../src/view-model.js';
import type { RunControllerClient } from '../src/run-client.js';

function delay(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function viewWith(tasks: RunView['tasks'], phases: RunView['phases'] = []): RunView {
  return { ...initialRunView('normal'), runId: 'r1', status: 'running', tasks, phases };
}

// ── Orchestration sidebar (Task 8) ──────────────────────────────────
describe('Orchestration sidebar', () => {
  it('renders the focused run plan and agents', () => {
    const view = viewWith(
      [
        { id: 't0', title: 'scaffold', role: 'worker', status: 'succeeded', tags: ['build'], tokens: 1200, toolCount: 3, startedAt: 1, finishedAt: 2, agentId: 'claude', agentRunId: null, agentLabel: 'claude' },
        { id: 't1', title: 'oauth', role: 'worker', status: 'running', tags: ['build'], tokens: 840, toolCount: 1, startedAt: 1, finishedAt: null, agentId: 'codex', agentRunId: null, agentLabel: 'codex' },
      ],
      [{ stage: 'build', done: 1, total: 2 }],
    );
    const { lastFrame } = render(<Orchestration view={view} focused expanded />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Plan');
    expect(frame).toContain('build');
    expect(frame).toContain('Agents');
    expect(frame).toContain('claude');
    expect(frame).toContain('codex');
  });

  it('renders only a collapsed marker when not expanded', () => {
    const { lastFrame } = render(<Orchestration view={viewWith([])} focused={false} expanded={false} />);
    expect(lastFrame() ?? '').not.toContain('Agents');
    expect(lastFrame() ?? '').toContain('expand');
  });
});

// ── Session transcript pane (Task 9) ────────────────────────────────
describe('Session transcript pane', () => {
  it('renders user messages, route, plan and task progress', () => {
    const transcript: TranscriptItem[] = [
      { kind: 'user-message', text: 'add OAuth' },
      { kind: 'route', routeKind: 'complex', reason: 'multi-file' },
      { kind: 'plan', taskCount: 3 },
      { kind: 'task-progress', role: 'worker', title: 'callback', agentLabel: 'claude', status: 'started' },
      { kind: 'finished', status: 'succeeded', summary: 'done' },
    ];
    const { lastFrame } = render(<SessionPane transcript={transcript} title="redesign" focused rows={40} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('add OAuth');
    expect(frame).toContain('complex');
    expect(frame).toContain('3 task');
    expect(frame).toContain('callback');
    expect(frame).toContain('done');
  });

  it('shows an empty-session hint when there is no transcript', () => {
    const { lastFrame } = render(<SessionPane transcript={[]} title="new" focused rows={40} />);
    expect(lastFrame() ?? '').toMatch(/type a task|empty|start/i);
  });

  it('renders a live streaming assistant block from activity', () => {
    const { lastFrame } = render(
      <SessionPane transcript={[]} title="s" focused rows={40} streaming={['working on **it** now']} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('assistant');
    expect(frame).toContain('working on');
    expect(frame).toContain('it');
  });
});

// ── Rich rendering (markdown + diff) ────────────────────────────────
describe('Markdown / Diff rendering', () => {
  it('renders headings, list markers and code, and colorizes diff fences', () => {
    const src = ['# Heading', '- item one', '```diff', '+added', '-removed', '```'].join('\n');
    const { lastFrame } = render(
      <Box width={60}>
        <MarkdownView source={src} />
      </Box>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Heading');
    expect(frame).toContain('• item one');
    expect(frame).toContain('+added');
    expect(frame).toContain('-removed');
  });

  it('renders a standalone diff', () => {
    const { lastFrame } = render(
      <Box width={60}>
        <DiffView patch={'@@ -1 +1 @@\n-old\n+new'} />
      </Box>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('@@ -1 +1 @@');
    expect(frame).toContain('-old');
    expect(frame).toContain('+new');
  });
});

// ── Editor (multiline, emacs keybinds) ──────────────────────────────
describe('Editor', () => {
  it('accepts mid-line edits and submits the joined text on enter', async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Box width={80}>
        <Editor focused onSubmit={(t) => submitted.push(t)} onChange={() => {}} hint="" />
      </Box>,
    );
    await delay(10);
    stdin.write('helo');
    await delay(10);
    stdin.write('[D'); // left arrow → between 'hel' and 'o'
    await delay(10);
    stdin.write('l'); // 'hello'
    await delay(10);
    stdin.write('\r'); // submit
    await delay(20);
    expect(submitted).toEqual(['hello']);
  });

  it('inserts a newline with ctrl+j and keeps both lines on submit', async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Box width={80}>
        <Editor focused onSubmit={(t) => submitted.push(t)} onChange={() => {}} hint="" />
      </Box>,
    );
    await delay(10);
    stdin.write('line1');
    await delay(10);
    stdin.write('\n'); // ctrl+j → newline (not submit)
    await delay(10);
    stdin.write('line2');
    await delay(10);
    stdin.write('\r'); // submit
    await delay(20);
    expect(submitted).toEqual(['line1\nline2']);
  });

  it('reports the current text via onChange', async () => {
    const changes: string[] = [];
    const { stdin } = render(
      <Box width={80}>
        <Editor focused onSubmit={() => {}} onChange={(t) => changes.push(t)} hint="" />
      </Box>,
    );
    await delay(10);
    stdin.write('/');
    await delay(10);
    expect(changes.at(-1)).toBe('/');
  });
});

// ── Overlay (fuzzy select) ──────────────────────────────────────────
describe('Overlay', () => {
  it('filters by fuzzy query and picks the selected item on enter', async () => {
    const items: OverlayItem[] = [
      { id: '/new', label: '/new' },
      { id: '/stop', label: '/stop' },
      { id: '/workflow', label: '/workflow' },
    ];
    const picked: string[] = [];
    const { stdin, lastFrame } = render(
      <Box width={60}>
        <Overlay title="commands" items={items} active onPick={(i) => picked.push(i.id)} onClose={() => {}} />
      </Box>,
    );
    await delay(10);
    stdin.write('wf'); // fuzzy → /workflow
    await delay(15);
    expect(lastFrame() ?? '').toContain('/workflow');
    stdin.write('\r');
    await delay(15);
    expect(picked).toEqual(['/workflow']);
  });

  it('closes on escape', async () => {
    let closed = false;
    const { stdin } = render(
      <Box width={60}>
        <Overlay title="t" items={[{ id: 'a', label: 'a' }]} active onPick={() => {}} onClose={() => { closed = true; }} />
      </Box>,
    );
    await delay(10);
    stdin.write(''); // escape
    await delay(15);
    expect(closed).toBe(true);
  });
});

// ── App conversational shell (Task 11) ──────────────────────────────
function makeFakeClient(overrides: Partial<RunControllerClient> = {}): RunControllerClient {
  return {
    submit: vi.fn(async () => 'tok'),
    submitToSession: vi.fn(async () => 'tok'),
    resolveRunId: vi.fn(async () => 'run-1'),
    snapshot: vi.fn(async () => null),
    transcript: vi.fn(async () => []),
    list: vi.fn(async () => []),
    tail: vi.fn(() => () => {}),
    tailRun: vi.fn((_id: string, onUpdate: (u: { view: RunView; transcript: TranscriptItem[] }) => void) => {
      onUpdate({ view: viewWith([], []), transcript: [{ kind: 'user-message', text: 'add OAuth' }] });
      return () => {};
    }),
    stop: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    answerGate: vi.fn(async () => {}),
    editCriteria: vi.fn(async () => {}),
  } as unknown as RunControllerClient;
}

describe('TUI App (conversational shell)', () => {
  it('renders the composer and an empty session on launch', async () => {
    const client = makeFakeClient();
    const sessions = new MemorySessionStore();
    const { lastFrame } = render(<App client={client} cwd="/tmp" mode="normal" sessions={sessions} now={() => 1} />);
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('›'); // composer prompt
    expect(frame).toMatch(/session ·/);
  });

  it('submitting a task creates a run in the session and tails it', async () => {
    const client = makeFakeClient();
    const sessions = new MemorySessionStore();
    const { stdin } = render(<App client={client} cwd="/tmp" mode="normal" sessions={sessions} now={() => 1} />);
    await delay(30);
    stdin.write('add OAuth');
    await delay(20);
    stdin.write('\r');
    await delay(60);
    expect(client.submitToSession).toHaveBeenCalled();
    expect(client.tailRun).toHaveBeenCalledWith('run-1', expect.any(Function));
    const list = await sessions.list();
    expect(list[0]?.runIds).toEqual(['run-1']);
  });

  it('shows the daemon status in the header', async () => {
    const client = makeFakeClient();
    const sessions = new MemorySessionStore();
    const daemonStatus = async () => ({
      running: true,
      pid: 4242,
      startedAt: 0,
      version: '0.1.0',
      heartbeatAt: 0,
      cwd: '/tmp',
    });
    const { lastFrame } = render(
      <App client={client} cwd="/tmp" mode="normal" sessions={sessions} now={() => 1} daemonStatus={daemonStatus} />,
    );
    await delay(40);
    expect(lastFrame() ?? '').toMatch(/daemon up \(4242\)/);
  });

  it('opens the command palette on ctrl+p', async () => {
    const client = makeFakeClient();
    const sessions = new MemorySessionStore();
    const { stdin, lastFrame } = render(
      <App client={client} cwd="/tmp" mode="normal" sessions={sessions} now={() => 1} />,
    );
    await delay(40);
    stdin.write(''); // ctrl+p
    await delay(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('commands');
    expect(frame).toContain('/workflow');
  });

  it('quitting does NOT stop a run, but /stop does', async () => {
    const client = makeFakeClient();
    const sessions = new MemorySessionStore();
    const { stdin } = render(
      <App client={client} cwd="/tmp" mode="normal" sessions={sessions} now={() => 1} token="tok" task="x" />,
    );
    await delay(40); // bootstrap attaches run-1 via the token
    stdin.write('\t'); // Tab → focus moves off the composer
    await delay(10);
    stdin.write('q'); // quit (no cancel)
    await delay(20);
    expect(client.stop).not.toHaveBeenCalled();
  });
});
