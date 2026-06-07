import React from 'react';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { DetectedAgent } from '@omakase/daemon';
import { App } from '../src/tui/App.js';
import { initialRunView, type RunView } from '../src/view-model.js';
import type { RunControllerClient, RunSummary } from '../src/run-client.js';

const TWO_AGENTS = [
  { id: 'codex', available: true },
  { id: 'claude', available: true },
] as unknown as DetectedAgent[];

const NOISY_AGENT_SCAN = [
  { id: 'codex', available: true, authStatus: 'ok' },
  { id: 'gemini', available: true, authStatus: 'missing' },
  { id: 'opencode', available: false, authStatus: 'unknown' },
  { id: 'claude', available: false, authStatus: 'unknown', unavailableReason: 'CLAUDE_BIN is not executable' },
] as unknown as DetectedAgent[];

function tick(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sampleView(): RunView {
  return {
    ...initialRunView('normal'),
    runId: 'r1',
    status: 'running',
    title: 'build a parser',
    tasks: [
      {
        id: 't1',
        title: 'worker one',
        role: 'worker',
        status: 'running',
        tags: ['logic'],
        tokens: 120,
        toolCount: 2,
        startedAt: 0,
        finishedAt: null,
        agentId: 'codex',
        agentRunId: 'agent-run-1',
        agentLabel: 'codex#t1',
      },
    ],
    phases: [{ stage: 'logic', done: 0, total: 1 }],
    activeAgents: 1,
    totalAgents: 1,
    totalTokens: 120,
    startedAt: 0,
    updatedAt: 0,
  };
}

function multiAgentView(): RunView {
  return {
    ...sampleView(),
    tasks: [
      {
        id: 't1',
        title: 'first focused agent',
        role: 'worker',
        status: 'running',
        tags: ['logic'],
        tokens: 10,
        toolCount: 1,
        startedAt: 0,
        finishedAt: null,
        agentId: 'codex',
        agentRunId: 'agent-run-1',
        agentLabel: 'codex#t1',
      },
      {
        id: 't2',
        title: 'second focused agent',
        role: 'reviewer',
        status: 'running',
        tags: ['logic'],
        tokens: 5,
        toolCount: 0,
        startedAt: 0,
        finishedAt: null,
        agentId: 'claude',
        agentRunId: 'agent-run-2',
        agentLabel: 'claude#t2',
      },
    ],
    phases: [{ stage: 'logic', done: 0, total: 2 }],
    activeAgents: 2,
    totalAgents: 2,
    totalTokens: 15,
  };
}

function viewForRun(id: string, title: string): RunView {
  return {
    ...sampleView(),
    runId: id,
    title,
    tasks: sampleView().tasks.map((t) => ({ ...t, title })),
  };
}

function fakeClient(overrides: Partial<RunControllerClient> = {}): RunControllerClient {
  const view = sampleView();
  const summaries: RunSummary[] = [
    { id: 'r1', title: 'build a parser', status: 'running', done: 0, total: 1, updatedAt: 0 },
  ];
  return {
    submit: vi.fn(async () => 'tok'),
    resolveRunId: vi.fn(async () => 'r1'),
    snapshot: vi.fn(async () => view),
    list: vi.fn(async () => summaries),
    tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
      onView(view);
      return () => {};
    }),
    stop: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    answerGate: vi.fn(async () => {}),
    editCriteria: vi.fn(async () => {}),
    ...overrides,
  } as unknown as RunControllerClient;
}

describe('TUI App (persistent client)', () => {
  it('shows the run list when launched with no task', async () => {
    const client = fakeClient();
    const { lastFrame, unmount } = render(<App client={client} cwd="/p" mode="normal" />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Runs');
    expect(frame).toContain('build a parser');
    unmount();
  });

  it('attaches to the initial run and renders the two-pane detail with stats', async () => {
    const client = fakeClient();
    const { lastFrame, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" task="build a parser" />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Plan');
    expect(frame).toContain('Activity');
    expect(frame).not.toContain('Phrases');
    expect(frame).toContain('Detail · logic'); // detail filtered to the selected phase
    expect(frame).toContain('1 agents');
    expect(frame).toContain('worker one');
    expect(frame).toContain('codex#t1');
    expect(frame).toContain('120 tok');
    expect(frame).toContain('2 tools');
    expect(frame).toMatch(/agents ·/); // header N/M agents · elapsed
    unmount();
  });

  it('shows the read-only server URL and switches workspaces', async () => {
    const rich: RunView = {
      ...sampleView(),
      acceptance: {
        criteria: [
          {
            id: 'criterion-1',
            title: 'feature works',
            description: 'feature works',
            status: 'pass',
            evidence: [],
            source: 'planner',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        progress: { passed: 1, total: 1, complete: true },
      },
      reports: [
        {
          id: 'report-1',
          runId: 'r1',
          kind: 'planning',
          title: 'Planning report',
          summary: 'planned one task',
          markdown: '# Planning report',
          taskId: null,
          authorAgentId: 'codex',
          authorRole: 'reporter',
          source: 'agent',
          createdAt: 0,
        },
      ],
      knowledgeEvents: [
        {
          id: 'knowledge-1',
          runId: 'r1',
          kind: 'synthesis',
          title: 'Wiki synthesis: Planning report',
          body: 'Agent-authored project wiki: durable project facts.',
          authorAgentId: 'codex',
          reportId: 'report-1',
          createdAt: 0,
        },
      ],
      riskGates: [
        {
          id: 'gate-1',
          status: 'open',
          reason: 'review-uncertain',
          question: 'Continue?',
          answer: null,
          criteria: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    rich.activity = ['worker/codex: main worker output'];
    rich.supportActivity = ['reporter/codex: streaming report sidecar', 'wiki-curator/codex: streaming wiki sidecar'];
    const client = fakeClient({
      tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
        onView(rich);
        return () => {};
      }),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" readOnlyUrl="http://127.0.0.1:4555" />,
    );
    await tick();
    expect(lastFrame() ?? '').toContain('web: http://127.0.0.1:4555');
    expect(lastFrame() ?? '').toContain('main worker output');
    expect(lastFrame() ?? '').not.toContain('streaming report sidecar');
    stdin.write('3');
    await tick(20);
    expect(lastFrame() ?? '').toContain('Acceptance');
    expect(lastFrame() ?? '').toContain('feature works');
    stdin.write('5');
    await tick(20);
    expect(lastFrame() ?? '').toContain('Reports');
    expect(lastFrame() ?? '').toContain('Planning report');
    expect(lastFrame() ?? '').toContain('reporter/codex');
    expect(lastFrame() ?? '').toContain('streaming report sidecar');
    stdin.write('4');
    await tick(20);
    expect(lastFrame() ?? '').toContain('Knowledge');
    expect(lastFrame() ?? '').toContain('wiki-curator/codex');
    expect(lastFrame() ?? '').toContain('Wiki synthesis');
    expect(lastFrame() ?? '').toContain('streaming wiki sidecar');
    stdin.write('6');
    await tick(20);
    expect(lastFrame() ?? '').toContain('Gate');
    expect(lastFrame() ?? '').toContain('Continue?');
    unmount();
  });

  it('edits criteria and answers the active gate from the TUI workspaces', async () => {
    const rich: RunView = {
      ...sampleView(),
      acceptance: {
        criteria: [
          {
            id: 'criterion-1',
            title: 'old criterion',
            description: 'old criterion',
            status: 'pending',
            evidence: [],
            source: 'planner',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        progress: { passed: 0, total: 1, complete: false },
      },
      riskGates: [
        {
          id: 'gate-1',
          status: 'open',
          reason: 'review-uncertain',
          question: 'Continue with edited scope?',
          answer: null,
          criteria: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    const client = fakeClient({
      tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
        onView(rich);
        return () => {};
      }),
    });
    const { stdin, unmount } = render(<App client={client} cwd="/p" mode="normal" token="tok" />);
    await tick();

    stdin.write('3'); // Acceptance workspace
    await tick(20);
    stdin.write('e');
    await tick(20);
    stdin.write('new criterion;has evidence');
    await tick(20);
    stdin.write('\r');
    await tick(20);
    expect(client.editCriteria).toHaveBeenCalledWith('r1', ['new criterion', 'has evidence']);

    stdin.write('6'); // Gate workspace
    await tick(20);
    stdin.write('g');
    await tick(20);
    stdin.write('continue with current risk');
    await tick(20);
    stdin.write('\r');
    await tick(20);
    expect(client.answerGate).toHaveBeenCalledWith('r1', 'gate-1', 'continue with current risk');
    unmount();
  });

  it('adds editable wiki entries from the Knowledge workspace without treating them as run input', async () => {
    const addWikiEntry = vi.fn(async () => {});
    const client = fakeClient();
    const { stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" addWikiEntry={addWikiEntry} />,
    );
    await tick();

    stdin.write('4'); // Knowledge workspace
    await tick(20);
    stdin.write('w');
    await tick(20);
    stdin.write('Manual architecture decision :: Keep wiki entries editable from TUI and web-visible.');
    await tick(20);
    stdin.write('\r');
    await tick(20);

    expect(addWikiEntry).toHaveBeenCalledWith({
      title: 'Manual architecture decision',
      body: 'Keep wiki entries editable from TUI and web-visible.',
      kind: 'note',
      tags: ['knowledge', 'manual', 'tui'],
    });
    expect(client.sendInput).not.toHaveBeenCalled();
    unmount();
  });

  it('[x] stops the attached run', async () => {
    const client = fakeClient();
    const { stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" />,
    );
    await tick();
    stdin.write('x');
    await tick(20);
    expect(client.stop).toHaveBeenCalledWith('r1');
    unmount();
  });

  it('quitting does NOT stop the run', async () => {
    const client = fakeClient();
    const { stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" />,
    );
    await tick();
    stdin.write('q');
    await tick(20);
    expect(client.stop).not.toHaveBeenCalled();
    unmount();
  });

  it('shows the daemon status in the header', async () => {
    const client = fakeClient();
    const daemonStatus = async () => ({
      running: true,
      pid: 4242,
      startedAt: 0,
      version: '0.1.0',
      heartbeatAt: 0,
      cwd: '/p',
    });
    const { lastFrame, unmount } = render(
      <App client={client} cwd="/p" mode="normal" daemonStatus={daemonStatus} />,
    );
    await tick();
    expect(lastFrame() ?? '').toMatch(/daemon ● up \(4242\)/);
    unmount();
  });

  it('[a] switches the main agent and [k]/[r] manage the daemon from the list', async () => {
    const client = fakeClient();
    const stopDaemon = vi.fn(async () => {});
    const startDaemon = vi.fn(async () => {});
    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        cwd="/p"
        mode="normal"
        detect={async () => TWO_AGENTS}
        stopDaemon={stopDaemon}
        startDaemon={startDaemon}
      />,
    );
    await tick();
    expect(lastFrame()).toContain('main agent: auto');
    stdin.write('a'); // auto → codex
    await tick(20);
    expect(lastFrame()).toContain('main agent: codex');
    stdin.write('k'); // stop the daemon
    await tick(20);
    expect(stopDaemon).toHaveBeenCalled();
    stdin.write('r'); // restart
    await tick(20);
    expect(startDaemon).toHaveBeenCalled();
    unmount();
  });

  it('hides absent agent registry noise while keeping actionable auth/setup rows', async () => {
    const client = fakeClient();
    const { lastFrame, unmount } = render(
      <App client={client} cwd="/p" mode="normal" detect={async () => NOISY_AGENT_SCAN} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('codex');
    expect(frame).toContain('gemini auth');
    expect(frame).toContain('claude');
    expect(frame).not.toContain('opencode');
    unmount();
  });

  it('carries the selected agent when starting a new task', async () => {
    const client = fakeClient();
    const { stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" detect={async () => TWO_AGENTS} />,
    );
    await tick();
    stdin.write('a'); // select codex
    await tick(20);
    stdin.write('i'); // compose
    await tick(20);
    stdin.write('build it');
    await tick(20);
    stdin.write('\r'); // submit
    await tick(20);
    expect(client.submit).toHaveBeenCalledWith('build it', 'codex');
    unmount();
  });

  it('shows a pending run immediately after submitting a new task', async () => {
    const client = fakeClient({
      resolveRunId: vi.fn(async () => null),
      list: vi.fn(async () => []),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" detect={async () => TWO_AGENTS} />,
    );
    await tick();
    stdin.write('i');
    await tick(20);
    stdin.write('ship it');
    await tick(20);
    stdin.write('\r');
    await tick(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ship it');
    expect(frame).toContain('pending');
    unmount();
  });

  it('keeps resolving a submitted task token and attaches without leaving/re-entering', async () => {
    const attached = viewForRun('r2', 'daemon attached task');
    const client = fakeClient({
      resolveRunId: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('r2'),
      list: vi.fn(async () => []),
      tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
        onView(attached);
        return () => {};
      }),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" detect={async () => TWO_AGENTS} />,
    );
    await tick();
    stdin.write('i');
    await tick(20);
    stdin.write('delayed task');
    await tick(20);
    stdin.write('\r');
    await tick(40);
    expect(lastFrame() ?? '').toContain('delayed task');
    expect(lastFrame() ?? '').toContain('pending');
    await tick(160);
    expect(client.resolveRunId).toHaveBeenCalledTimes(2);
    expect(lastFrame() ?? '').toContain('daemon attached task');
    expect(lastFrame() ?? '').toContain('running');
    expect(lastFrame() ?? '').not.toContain('submitted — waiting for the daemon to start it');

    stdin.write('\u001b');
    await tick(40);
    expect(lastFrame() ?? '').toContain('Runs');
    expect(lastFrame() ?? '').not.toContain('submitted — waiting for the daemon to start it');
    unmount();
  });

  it('refreshes the runs list after leaving a pending submitted task', async () => {
    let showCreatedRun = false;
    const client = fakeClient({
      resolveRunId: vi.fn(async () => null),
      list: vi.fn(async () =>
        showCreatedRun
          ? [
              {
                id: 'r-new',
                title: 'created after back',
                status: 'running',
                done: 0,
                total: 1,
                updatedAt: 10,
              },
            ] satisfies RunSummary[]
          : [],
      ),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" detect={async () => TWO_AGENTS} />,
    );
    await tick();
    stdin.write('i');
    await tick(20);
    stdin.write('submitted then listed');
    await tick(20);
    stdin.write('\r');
    await tick(40);
    expect(lastFrame() ?? '').toContain('submitted then listed');
    expect(lastFrame() ?? '').toContain('pending');

    stdin.write(''); // back to runs before the daemon-created run is visible
    await tick(40);
    showCreatedRun = true;
    await tick(650);

    expect(lastFrame() ?? '').toContain('Runs');
    expect(lastFrame() ?? '').toContain('created after back');
    unmount();
  });

  it('persists the selected main agent per project', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-tui-prefs-'));
    const first = render(
      <App client={fakeClient()} cwd={cwd} mode="normal" detect={async () => TWO_AGENTS} />,
    );
    await tick();
    first.stdin.write('a'); // auto -> codex
    await tick(20);
    expect(first.lastFrame()).toContain('main agent: codex');
    first.unmount();

    const second = render(
      <App client={fakeClient()} cwd={cwd} mode="normal" detect={async () => TWO_AGENTS} />,
    );
    await tick();
    expect(second.lastFrame()).toContain('main agent: codex');
    second.unmount();
  });

  it('clears the stopping notice when a stopped run reaches a terminal status', async () => {
    let push!: (v: RunView) => void;
    const running = sampleView();
    const cancelled: RunView = { ...running, status: 'cancelled', updatedAt: 100 };
    const client = fakeClient({
      tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
        push = onView;
        onView(running);
        return () => {};
      }),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" />,
    );
    await tick();
    stdin.write('x');
    await tick(20);
    expect(lastFrame()).toContain('stopping');
    push(cancelled);
    await tick(20);
    expect(lastFrame()).toContain('cancelled');
    expect(lastFrame()).not.toContain('stopping');
    unmount();
  });

  it('ignores stale tail updates after switching to another run', async () => {
    const callbacks = new Map<string, (v: RunView) => void>();
    const disposers = new Map<string, () => void>();
    const client = fakeClient({
      list: vi.fn(async () => [
        { id: 'r1', title: 'first run', status: 'running', done: 0, total: 1, updatedAt: 2 },
        { id: 'r2', title: 'second run', status: 'running', done: 0, total: 1, updatedAt: 1 },
      ] satisfies RunSummary[]),
      tail: vi.fn((id: string, onView: (v: RunView) => void) => {
        callbacks.set(id, onView);
        onView(viewForRun(id, id === 'r1' ? 'first run detail' : 'second run detail'));
        const dispose = vi.fn();
        disposers.set(id, dispose);
        return dispose;
      }),
    });
    const { lastFrame, stdin, unmount } = render(<App client={client} cwd="/p" mode="normal" />);
    await tick();
    stdin.write('\r'); // attach r1
    await tick(40);
    expect(lastFrame() ?? '').toContain('first run detail');
    stdin.write(''); // back to list
    await tick(40);
    stdin.write('[B'); // select r2
    await tick(20);
    stdin.write('\r'); // attach r2
    await tick(40);
    expect(lastFrame() ?? '').toContain('second run detail');

    callbacks.get('r1')?.(viewForRun('r1', 'stale first run detail'));
    await tick(20);
    expect(disposers.get('r1')).toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('second run detail');
    expect(lastFrame() ?? '').not.toContain('stale first run detail');
    unmount();
  });

  it('↑↓ selects a phase and the Detail pane filters to it', async () => {
    const twoPhase: RunView = {
      ...sampleView(),
      tasks: [
        { id: 't1', title: 'build it', role: 'worker', status: 'succeeded', tags: ['logic'], tokens: 10, toolCount: 1, startedAt: 0, finishedAt: 0, agentId: 'codex', agentRunId: 'agent-run-1', agentLabel: 'codex#t1' },
        { id: 't2', title: 'review it', role: 'reviewer', status: 'running', tags: ['review'], tokens: 5, toolCount: 0, startedAt: 0, finishedAt: null, agentId: 'claude', agentRunId: 'agent-run-2', agentLabel: 'claude#t2' },
      ],
      phases: [
        { stage: 'logic', done: 1, total: 1 },
        { stage: 'review', done: 0, total: 1 },
      ],
      totalAgents: 2,
    };
    const client = fakeClient({
      tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
        onView(twoPhase);
        return () => {};
      }),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" />,
    );
    await tick();
    // Phase 0 ('logic') selected → Detail shows the logic task only.
    expect(lastFrame() ?? '').toContain('Detail · logic');
    expect(lastFrame() ?? '').toContain('build it');
    expect(lastFrame() ?? '').not.toContain('review it');
    stdin.write('[B'); // down arrow → select phase 1 ('review')
    await tick(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Detail · review');
    expect(frame).toContain('review it');
    expect(frame).not.toContain('build it');
    unmount();
  });

  it('←→ switches focus between Plan and Detail panes', async () => {
    const client = fakeClient({
      tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
        onView(multiAgentView());
        return () => {};
      }),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" />,
    );
    await tick();
    expect(lastFrame() ?? '').toContain('› Plan');
    stdin.write('[C'); // right arrow
    await tick(20);
    expect(lastFrame() ?? '').toContain('› Detail');
    stdin.write('[D'); // left arrow
    await tick(20);
    expect(lastFrame() ?? '').toContain('› Plan');
    unmount();
  });

  it('Detail focus can select and expand an agent row', async () => {
    const client = fakeClient({
      tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
        onView(multiAgentView());
        return () => {};
      }),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" />,
    );
    await tick();
    stdin.write('[C'); // focus Detail
    await tick(20);
    stdin.write('[B'); // select second agent row
    await tick(20);
    stdin.write('\r'); // expand
    await tick(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('second focused agent');
    expect(frame).toContain('id: t2');
    expect(frame).toContain('status: running');
    expect(frame).toContain('agent: claude');
    expect(frame).toContain('instance: claude#t2');
    expect(frame).toContain('tokens: 5');
    expect(frame).toContain('tools: 0');
    unmount();
  });

  it('Agents workspace detail focuses every agent instead of the selected phase only', async () => {
    const crossPhase: RunView = {
      ...sampleView(),
      tasks: [
        { id: 't1', title: 'logic worker', role: 'worker', status: 'succeeded', tags: ['logic'], tokens: 10, toolCount: 1, startedAt: 0, finishedAt: 0, agentId: 'codex', agentRunId: 'agent-run-1', agentLabel: 'codex#t1' },
        { id: 't2', title: 'review agent', role: 'reviewer', status: 'running', tags: ['review'], tokens: 5, toolCount: 0, startedAt: 0, finishedAt: null, agentId: 'claude', agentRunId: 'agent-run-2', agentLabel: 'claude#t2' },
      ],
      phases: [
        { stage: 'logic', done: 1, total: 1 },
        { stage: 'review', done: 0, total: 1 },
      ],
      totalAgents: 2,
    };
    const client = fakeClient({
      tail: vi.fn((_id: string, onView: (v: RunView) => void) => {
        onView(crossPhase);
        return () => {};
      }),
    });
    const { lastFrame, stdin, unmount } = render(
      <App client={client} cwd="/p" mode="normal" token="tok" />,
    );
    await tick();
    expect(lastFrame() ?? '').toContain('Detail · logic');
    expect(lastFrame() ?? '').not.toContain('review agent');
    stdin.write('2'); // Agents workspace
    await tick(20);
    expect(lastFrame() ?? '').toContain('Detail · all agents');
    expect(lastFrame() ?? '').toContain('logic worker');
    expect(lastFrame() ?? '').toContain('review agent');
    stdin.write('[C'); // focus Detail
    await tick(20);
    stdin.write('[B'); // select review agent
    await tick(20);
    stdin.write('\r');
    await tick(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('id: t2');
    expect(frame).toContain('agent: claude');
    expect(frame).toContain('instance: claude#t2');
    unmount();
  });
});
