import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { FileControlSource } from '@omakase/core';
import type { RunStore } from '@omakase/core';
import { createServer, type ServeConfig } from '../src/serve.js';
import { RunControllerClient } from '../src/run-client.js';
import type { RunView } from '../src/view-model.js';

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
