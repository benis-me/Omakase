import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { MemoryRunStore, Orchestrator, createModelPolicy, type Router } from '@omakase/core';
import { App } from '../src/tui/App.js';

const OFFLINE = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;
const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

function tick(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TUI App', () => {
  it('renders the shell and the agents panel', async () => {
    const runtime = createAgentRuntime({ detection: OFFLINE });
    const orchestrator = new Orchestrator({ runtime, store: new MemoryRunStore() });
    const { lastFrame, unmount } = render(
      <App runtime={runtime} orchestrator={orchestrator} mode="normal" />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Omakase');
    expect(frame).toContain('Agents');
    expect(frame).toContain('claude'); // a known built-in adapter id
    unmount();
  });

  it('drives a run and shows tasks + final status', async () => {
    const exec = createScriptedAgent((input) =>
      String(input.metadata?.role) === 'reviewer'
        ? [{ type: 'text_delta', delta: 'APPROVE' }]
        : [{ type: 'text_delta', delta: 'done' }],
    );
    const runtime = createAgentRuntime({ executors: { scripted: exec }, detection: OFFLINE, now: () => 0 });
    const orchestrator = new Orchestrator({
      runtime,
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: OFFLINE,
    });
    const { lastFrame, unmount } = render(
      <App runtime={runtime} orchestrator={orchestrator} task={'- a\n- b'} mode="normal" />,
    );
    await tick(120);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Task graph');
    expect(frame).toMatch(/succeeded/);
    unmount();
  });
});
