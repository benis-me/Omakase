import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/tui/App.js';
import { initialRunView, type RunView } from '../src/view-model.js';
import type { RunControllerClient, RunSummary } from '../src/run-client.js';

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
    expect(frame).toContain('Phases');
    expect(frame).toContain('Detail · logic'); // detail filtered to the selected phase
    expect(frame).toContain('1 agents');
    expect(frame).toContain('worker one');
    expect(frame).toContain('120 tok');
    expect(frame).toContain('2 tools');
    expect(frame).toMatch(/agents ·/); // header N/M agents · elapsed
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

  it('↑↓ selects a phase and the Detail pane filters to it', async () => {
    const twoPhase: RunView = {
      ...sampleView(),
      tasks: [
        { id: 't1', title: 'build it', role: 'worker', status: 'succeeded', tags: ['logic'], tokens: 10, toolCount: 1, startedAt: 0, finishedAt: 0, agentId: 'codex' },
        { id: 't2', title: 'review it', role: 'reviewer', status: 'running', tags: ['review'], tokens: 5, toolCount: 0, startedAt: 0, finishedAt: null, agentId: 'claude' },
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
});
