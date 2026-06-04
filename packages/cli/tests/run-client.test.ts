import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { FileControlSource } from '@omakase/core';
import { createServer, type ServeConfig } from '../src/serve.js';
import { RunControllerClient } from '../src/run-client.js';

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
});
