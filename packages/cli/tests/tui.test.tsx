import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink-testing-library';
import { render as inkRender } from 'ink';
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

  it('composes and runs a new task interactively when launched idle', async () => {
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
    // No task prop → idle. ink-testing-library reports a TTY, so useInput is live.
    const { lastFrame, stdin, unmount } = render(
      <App runtime={runtime} orchestrator={orchestrator} mode="normal" />,
    );
    await tick();
    expect(lastFrame()).toContain('[i] new task'); // idle hint
    stdin.write('i'); // open the composer
    await tick(20);
    stdin.write('build a parser'); // type the task
    await tick(20);
    stdin.write('\r'); // Enter → submit + start the run
    await tick(150);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Task graph');
    expect(frame).toMatch(/succeeded|running/);
    unmount();
  });

  it('exits when the run ends and raw mode is unsupported (piped stdin / CI)', async () => {
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
    // ink-testing-library hardcodes isTTY=true, so use ink's own render with a
    // NON-TTY stdin → isRawModeSupported is false, exercising the real exit path.
    const sink = () =>
      Object.assign(new EventEmitter(), { columns: 80, rows: 24, write: () => true });
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: false,
      read: () => null,
      ref: () => {},
      unref: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
      setRawMode: () => {},
    });
    const instance = inkRender(
      <App runtime={runtime} orchestrator={orchestrator} task={'- a\n- b'} mode="normal" />,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { stdout: sink() as any, stderr: sink() as any, stdin: stdin as any, patchConsole: false },
    );
    const outcome = await Promise.race([
      instance.waitUntilExit().then(() => 'exited'),
      tick(2000).then(() => 'timeout'),
    ]);
    expect(outcome).toBe('exited');
  });
});
