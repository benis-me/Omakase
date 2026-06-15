/**
 * Bun smoke test for the OpenTUI TUI (the Node/vitest harness can't render it).
 * Renders the real <App> with a stubbed client + in-memory session store and
 * asserts it draws without throwing. Run: bun run tests-bun/smoke.tsx
 */
import React from 'react';
import { testRender } from '@opentui/react/test-utils';
import { MemorySessionStore } from '@omakase/core';
import { App } from '../src/tui-otui/App.js';

const client = {
  resolveRunId: async () => null,
  tailRun: () => () => {},
  transcript: async () => [],
  snapshot: async () => null,
  list: async () => [],
  submit: async () => 'tok',
  submitToSession: async () => 'tok',
  stop: async () => {},
  pause: async () => {},
  resume: async () => {},
  sendInput: async () => {},
  answerGate: async () => {},
  editCriteria: async () => {},
} as unknown as import('../src/run-client.js').RunControllerClient;

const sessions = new MemorySessionStore();

let ok = false;
try {
  const r: any = await testRender(
    <App client={client} sessions={sessions} cwd="/tmp" mode="normal" now={() => 1} />,
    { width: 100, height: 30 },
  );
  await new Promise((res) => setTimeout(res, 60));
  // Find a frame-capture method across possible API shapes.
  const cap =
    r.captureCharFrame?.bind(r) ??
    r.renderer?.captureCharFrame?.bind(r.renderer) ??
    r.renderOnce?.bind(r);
  const frame: string = cap ? String(cap()) : '';
  if (!frame.includes('omakase')) throw new Error(`frame missing 'omakase':\n${frame.slice(0, 400)}`);
  if (!frame.includes('session')) throw new Error(`frame missing 'session'`);
  ok = true;
  r.destroy?.();
} catch (e) {
  console.error('SMOKE_FAIL:', (e as Error).message);
  process.exit(1);
}
console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL');
process.exit(ok ? 0 : 1);
