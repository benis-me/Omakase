import { test, expect } from 'bun:test';
import { createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store } from '@omakase/core';
import type { ProviderInfo } from '@omakase/providers';
import { App } from './app.tsx';
import { eventLines } from './render.ts';

const providers: ProviderInfo[] = [
  { id: 'claude', command: 'claude', label: 'Claude', available: true, version: '1', path: '/c', models: ['sonnet'] },
  { id: 'codex', command: 'codex', label: 'Codex', available: true, version: '1', path: '/x', models: [] },
];

test('TUI renders the shell without crashing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-tui-'));
  const ws = Workspace.init(dir);
  const store = new Store(':memory:');
  try {
    const setup = await testRender(
      createElement(App, {
        workspace: ws,
        store,
        providers,
        workflows: ['goal', 'mission', 'tdd'],
        onExit: () => {},
      }),
      { width: 100, height: 30 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('omakase');
    expect(frame.toLowerCase()).toContain('workflow: goal');
    expect(frame).toContain('claude');
    // Two-pane layout: runs sidebar + footer keybindings.
    expect(frame.toLowerCase()).toContain('runs');
    expect(frame).toContain('current');
    expect(frame.toLowerCase()).toContain('browse runs');
    setup.renderer.destroy();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test('eventLines maps events to styled lines', () => {
  const lines = eventLines([
    { runId: 'r', seq: 1, type: 'phase:started', payload: { name: 'Plan', index: 0 }, createdAt: 0 },
    {
      runId: 'r',
      seq: 2,
      type: 'agent:completed',
      payload: { callId: 'a', stepKey: 'root#0', text: 'built it', status: 'ok', providerSessionId: null, tokens: 3, costUsd: 0.01, durationMs: 5 },
      createdAt: 0,
    },
  ]);
  expect(lines[0]!.text).toContain('Plan');
  expect(lines[1]!.text).toContain('built it');
});
