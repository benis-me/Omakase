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
    expect(frame).toContain('Detail · 1 agents');
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
});
