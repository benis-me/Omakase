import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { readdirSync } from 'node:fs';
import { FileControlSource, MemoryRunStore } from '@omakase/core';
import type { RunStore } from '@omakase/core';
import { createServer, type ServeConfig } from '../src/serve.js';
import { RunControllerClient } from '../src/run-client.js';
import { reduceTranscript, type RunView } from '../src/view-model.js';

const OFFLINE = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;

function config(cwd: string): ServeConfig {
  return {
    cwd,
    runsDir: path.join(cwd, '.omakase', 'runs'),
    queueDir: path.join(cwd, '.omakase', 'queue'),
    concurrency: 1,
    mode: 'normal',
    agentOverride: 'scripted',
    detectionOptions: OFFLINE,
  };
}

function scriptedServer(cwd: string) {
  const exec = createScriptedAgent((input) =>
    String(input.metadata?.role) === 'reviewer'
      ? [{ type: 'text_delta', delta: 'APPROVE' }]
      : [{ type: 'text_delta', delta: 'done' }],
  );
  return createServer(config(cwd), {
    write: () => {},
    createRuntime: () => createAgentRuntime({ executors: { scripted: exec }, detection: OFFLINE }),
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('RunControllerClient', () => {
  it('submits a task, correlates the daemon-allocated run id, and tails its view', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-client-'));
    const runsDir = path.join(cwd, '.omakase', 'runs');
    const queueDir = path.join(cwd, '.omakase', 'queue');
    const server = scriptedServer(cwd);
    const client = new RunControllerClient({ store: server.store, controlDir: runsDir, queueDir });

    const token = await client.submit('summarize the project');
    await server.cycle(); // daemon claims the queue file, runs, persists

    const id = await client.resolveRunId(token);
    expect(id).toBeTruthy();

    const view = await client.snapshot(id!);
    expect(view?.runId).toBe(id);
    expect(view?.status).toBe('succeeded');
    expect(view?.tasks.length).toBeGreaterThan(0);

    const summaries = await client.list();
    expect(summaries.some((s) => s.id === id)).toBe(true);
  });

  it('shows the plan + running task while a simple-route task is still in flight', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-client-live-'));
    const runsDir = path.join(cwd, '.omakase', 'runs');
    const queueDir = path.join(cwd, '.omakase', 'queue');
    // A worker that blocks until aborted — stands in for a long real-agent task.
    // Answer the agent-router's classification quickly so only the worker blocks.
    const exec = createScriptedAgent(async (input) => {
      if (input.prompt.includes('Classify the following request')) {
        return [{ type: 'text_delta', delta: 'SIMPLE' }];
      }
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) return resolve();
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const server = createServer(config(cwd), {
      write: () => {},
      createRuntime: () => createAgentRuntime({ executors: { scripted: exec }, detection: OFFLINE }),
    });
    const client = new RunControllerClient({ store: server.store, controlDir: runsDir, queueDir });
    await client.submit('hi'); // short prompt → simple route (no `planned` event)
    const draining = server.cycle(); // background; ingests the queue file, blocks on the worker

    const id = await waitFor(async () => {
      for (const i of await server.store.list()) {
        const r = await server.store.load(i);
        if (r?.plan.tasks.some((t) => t.status === 'running')) return i;
      }
      return undefined;
    });
    // The bug: with no `planned` event, folding events alone yields no tasks.
    const rec = await server.store.load(id);
    expect(rec?.routeDecision?.kind).toBe('simple'); // exercise the simple path
    const view = await client.snapshot(id);
    expect(view?.tasks.length).toBeGreaterThan(0); // NOT empty
    expect(view?.tasks.some((t) => t.status === 'running')).toBe(true);
    expect(view?.phases.length).toBeGreaterThan(0); // NOT "no plan yet"
    const summary = (await client.list()).find((s) => s.id === id);
    expect(summary?.status).toBe('running');
    expect(summary?.total).toBeGreaterThan(0); // list uses the same plan snapshot as detail

    await client.stop(id); // cleanup: cancel the blocked worker
    await draining;
  });

  it('submit encodes an @agent header when an agent is given', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-client-agent-'));
    const queueDir = path.join(cwd, '.omakase', 'queue');
    const client = new RunControllerClient({
      store: scriptedServer(cwd).store,
      controlDir: path.join(cwd, '.omakase', 'runs'),
      queueDir,
    });
    const token = await client.submit('do it', 'codex');
    expect(readFileSync(path.join(queueDir, token), 'utf8')).toBe('@agent codex\ndo it');
    const plain = await client.submit('no agent');
    expect(readFileSync(path.join(queueDir, plain), 'utf8')).toBe('no agent');
  });

  it('writes control files with a monotonic seq', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-client-ctl-'));
    const runsDir = path.join(cwd, '.omakase', 'runs');
    const client = new RunControllerClient({
      store: scriptedServer(cwd).store,
      controlDir: runsDir,
      queueDir: path.join(cwd, '.omakase', 'queue'),
    });
    const src = new FileControlSource(runsDir);

    await client.pause('run-x');
    expect(await src.read('run-x')).toEqual({ seq: 1, command: 'pause' });
    await client.resume('run-x');
    expect(await src.read('run-x')).toEqual({ seq: 2, command: 'resume' });
    await client.stop('run-x');
    expect(await src.read('run-x')).toMatchObject({ seq: 3, command: 'stop' });
  });

  it('writes gate answers and criteria edits as monotonic control commands', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-client-gates-'));
    const runsDir = path.join(cwd, '.omakase', 'runs');
    const client = new RunControllerClient({
      store: scriptedServer(cwd).store,
      controlDir: runsDir,
      queueDir: path.join(cwd, '.omakase', 'queue'),
    });
    const src = new FileControlSource(runsDir);

    await client.answerGate('run-x', 'gate-1', 'continue', ['works']);
    expect(await src.read('run-x')).toEqual({
      seq: 1,
      command: 'answer-gate',
      gateId: 'gate-1',
      answer: 'continue',
      criteria: ['works'],
    });
    await client.editCriteria('run-x', ['works', 'has tests']);
    expect(await src.read('run-x')).toEqual({
      seq: 2,
      command: 'edit-criteria',
      criteria: ['works', 'has tests'],
    });
  });

  it('transcript() folds the record events into transcript items', async () => {
    const store = new MemoryRunStore();
    const events = [
      { type: 'run-started', runId: 'r1', mode: 'normal', request: { prompt: 'do X' } },
      { type: 'run-finished', status: 'succeeded', summary: 'ok' },
    ];
    await store.save({
      id: 'r1', request: { prompt: 'do X' }, mode: 'normal', status: 'succeeded',
      plan: { tasks: [] }, wiki: { entries: [] }, inbox: [], events,
      summary: 'ok', createdAt: 1, updatedAt: 2, heartbeatAt: 2, checkpointSeq: 1,
    } as never);
    const client = new RunControllerClient({ store, controlDir: '/tmp/x', queueDir: '/tmp/x', pollMs: 5 });
    const items = await client.transcript('r1');
    expect(items).toEqual(reduceTranscript(events as never));
  });

  it('tailRun emits both the view and transcript and stops on dispose', async () => {
    const store = new MemoryRunStore();
    await store.save({
      id: 'r1', request: { prompt: 'do X' }, mode: 'normal', status: 'running',
      plan: { tasks: [] }, wiki: { entries: [] }, inbox: [],
      events: [{ type: 'run-started', runId: 'r1', mode: 'normal', request: { prompt: 'do X' } }],
      summary: '', createdAt: 1, updatedAt: 2, heartbeatAt: 2, checkpointSeq: 1,
    } as never);
    const client = new RunControllerClient({ store, controlDir: '/tmp/x', queueDir: '/tmp/x', pollMs: 5 });
    const seen: Array<{ viewRunId: string | null; itemKinds: string[] }> = [];
    const dispose = client.tailRun('r1', (u) => seen.push({ viewRunId: u.view.runId, itemKinds: u.transcript.map((i) => i.kind) }));
    await new Promise((r) => setTimeout(r, 30));
    dispose();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toEqual({ viewRunId: 'r1', itemKinds: ['user-message'] });
  });

  it('submitToSession writes a queue file with @agent header and injected context', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-client-ses-'));
    const queueDir = path.join(cwd, '.omakase', 'queue');
    const store = new MemoryRunStore();
    const client = new RunControllerClient({ store, controlDir: queueDir, queueDir, pollMs: 5 });
    const token = await client.submitToSession(
      { rollingSummary: 'we built Y' },
      { prompt: 'now do X', agentOverride: 'codex', files: ['a.ts'] },
    );
    expect(token).toMatch(/\.prompt$/);
    const files = readdirSync(queueDir);
    const body = readFileSync(path.join(queueDir, files.find((f) => f.endsWith('.prompt'))!), 'utf8');
    expect(body.startsWith('@agent codex\n')).toBe(true);
    expect(body).toContain('Session context so far:');
    expect(body).toContain('we built Y');
    expect(body).toContain('now do X');
    expect(body).toContain('- a.ts');
  });

  it('tail does not deliver a view after it is disposed mid-load', async () => {
    let resolveLoad!: (rec: unknown) => void;
    const store = {
      load: () => new Promise((r) => (resolveLoad = r)),
      list: async () => [],
      save: async () => {},
      delete: async () => {},
    } as unknown as RunStore;
    const client = new RunControllerClient({ store, controlDir: '/r', queueDir: '/q' });
    const views: RunView[] = [];
    const stop = client.tail('r1', (v) => views.push(v));
    stop(); // dispose while the first load is in flight
    resolveLoad({ id: 'r1', events: [], status: 'running', mode: 'normal' });
    await new Promise((r) => setTimeout(r, 10));
    expect(views).toHaveLength(0); // the stale view was suppressed
  });
});
