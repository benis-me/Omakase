/**
 * Bun smoke for the rebuilt TUI (the Node/vitest harness can't render OpenTUI).
 * Renders the real <App> with a stub client over OpenTUI's testRender and
 * asserts the empty state and a populated transcript both draw correctly.
 * Run: bun --conditions=development run tests-bun/smoke.tsx
 */
import React from 'react';
import { testRender } from '@opentui/react/test-utils';
import { MemorySessionStore } from '@omakase/core';
import { App } from '../src/tui/App.js';
import type { RunControllerClient } from '../src/run-client.js';
import type { TranscriptItem } from '../src/view-model.js';

function stubClient(transcript: TranscriptItem[], runId: string | null): RunControllerClient {
  const view = {
    runId, status: transcript.some((t) => t.kind === 'finished') ? 'succeeded' : 'running',
    activeAgents: 0, totalAgents: 4, totalTokens: 12400, phases: [], tasks: [], activity: [],
    mode: 'normal', title: null, route: null, events: [], phrases: [], supportActivity: [],
    wikiEntries: 0, codegraphFiles: null, codegraphStats: null, acceptance: null, iterations: [],
    riskGates: [], reports: [], knowledgeEvents: [], workflow: null, lastReview: null, summary: null,
    startedAt: 0, updatedAt: 0,
  };
  return {
    resolveRunId: async () => runId,
    tailRun: (_id: string, cb: (u: { view: unknown; transcript: TranscriptItem[] }) => void) => { cb({ view, transcript }); return () => {}; },
    transcript: async () => transcript, snapshot: async () => null, list: async () => [],
    submit: async () => 't', submitToSession: async () => 't',
    stop: async () => {}, pause: async () => {}, resume: async () => {}, sendInput: async () => {},
    answerGate: async () => {}, editCriteria: async () => {},
  } as unknown as RunControllerClient;
}

async function frame(client: RunControllerClient, token?: string): Promise<string> {
  const sessions = new MemorySessionStore();
  await sessions.create({ id: 'ses-1', title: 'demo-session', now: 1 });
  const r: any = await testRender(
    <App client={client} sessions={sessions} cwd="/x/demo" mode="normal" now={() => 1} {...(token ? { token } : {})} />,
    { width: 84, height: 18 },
  );
  await new Promise((res) => setTimeout(res, 100));
  const cap = r.captureCharFrame?.bind(r) ?? r.renderer?.captureCharFrame?.bind(r.renderer);
  const f = cap ? String(cap()) : '';
  r.destroy?.();
  return f;
}

function assert(cond: boolean, msg: string): void { if (!cond) { console.error('SMOKE_FAIL:', msg); process.exit(1); } }

try {
  const empty = await frame(stubClient([], null));
  assert(empty.includes('omakase'), 'empty: header');
  assert(empty.includes('demo-session'), 'empty: session title');
  assert(empty.includes('›') || empty.includes('message omakase'), 'empty: composer');

  const full = await frame(stubClient([
    { kind: 'user-message', text: 'add OAuth' },
    { kind: 'route', routeKind: 'complex', reason: 'multi-file' },
    { kind: 'plan', taskCount: 4 },
    { kind: 'task-progress', role: 'worker', title: 'callback.ts', agentLabel: 'claude', status: 'succeeded' },
    { kind: 'review', approved: true, notes: 'looks correct' },
    { kind: 'finished', status: 'succeeded', summary: '4/4 tasks' },
  ], 'r1'), 't');
  assert(full.includes('add OAuth'), 'full: user turn');
  assert(full.includes('callback.ts'), 'full: inline task');
  assert(full.includes('succeeded'), 'full: finished');
  console.log('SMOKE_OK');
  process.exit(0);
} catch (e) {
  console.error('SMOKE_FAIL:', (e as Error).message);
  process.exit(1);
}
