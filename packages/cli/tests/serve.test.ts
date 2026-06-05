import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { FileRunStore, Orchestrator, PlanGraph, createModelPolicy, writeControl, type Router } from '@omakase/core';
import { createServer, type ServeConfig } from '../src/serve.js';

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const OFFLINE = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;

function config(cwd: string, extra: Partial<ServeConfig> = {}): ServeConfig {
  return {
    cwd,
    runsDir: path.join(cwd, '.omakase', 'runs'),
    queueDir: path.join(cwd, '.omakase', 'queue'),
    concurrency: 1,
    mode: 'normal',
    agentOverride: 'builtin',
    detectionOptions: OFFLINE,
    ...extra,
  };
}

describe('createServer', () => {
  it('drains enqueued tasks and persists runs + knowledge', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-serve-'));
    const server = createServer(config(cwd), { write: () => {}, now: () => 7 });
    server.supervisor.enqueue({ prompt: 'summarize the project', cwd });
    const health = await server.cycle();

    expect(health.completed).toBe(1);
    expect(health.runs[0]?.status).toBe('succeeded');
    expect(readdirSync(path.join(cwd, '.omakase', 'runs')).some((f) => f.endsWith('.json'))).toBe(true);
    expect(existsSync(path.join(cwd, '.omakase', 'wiki.json'))).toBe(true);
  });

  it('ingests task files dropped in the queue dir and moves them to processed/', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-serve-q-'));
    const queue = path.join(cwd, '.omakase', 'queue');
    mkdirSync(queue, { recursive: true });
    writeFileSync(path.join(queue, 't1.txt'), 'summarize the project');
    writeFileSync(path.join(queue, 'notes.json'), 'ignored: wrong extension');

    const server = createServer(config(cwd), { write: () => {} });
    const enqueued = await server.scanQueue();
    expect(enqueued).toEqual(['t1.txt']);
    const health = await server.supervisor.drain();
    expect(health.completed).toBe(1);
    expect(existsSync(path.join(queue, 'processed', 't1.txt'))).toBe(true);
    expect(existsSync(path.join(queue, 't1.txt'))).toBe(false);
  });

  it('parses an @agent header from a queue file into the run request', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-serve-agent-'));
    const queue = path.join(cwd, '.omakase', 'queue');
    mkdirSync(queue, { recursive: true });
    writeFileSync(path.join(queue, 't.txt'), '@agent builtin\nsummarize the project');
    const server = createServer(config(cwd), { write: () => {} });
    await server.cycle();
    const ids = await server.store.list();
    const rec = await server.store.load(ids[0]!);
    expect(rec?.request.metadata?.agentOverride).toBe('builtin');
    expect(rec?.request.prompt).toBe('summarize the project'); // header stripped
  });

  it('a stop control file cancels a mid-flight detached run', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-serve-control-'));
    const runsDir = path.join(cwd, '.omakase', 'runs');
    // A worker that blocks until its run is aborted (the stop path interrupts it).
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
    const server = createServer(config(cwd, { agentOverride: 'scripted' }), {
      write: () => {},
      createRuntime: () => createAgentRuntime({ executors: { scripted: exec }, detection: OFFLINE }),
    });
    server.supervisor.enqueue({ prompt: 'do work', cwd });
    const draining = server.supervisor.drain(); // background — blocks on the run
    const id = await waitFor(async () => {
      for (const i of await server.store.list()) {
        if ((await server.store.load(i))?.status === 'running') return i;
      }
      return undefined;
    });
    await writeControl(runsDir, id, { seq: 1, command: 'stop' });
    await draining; // the 250ms control poll applies the stop → cancel → settles
    expect((await server.store.load(id))?.status).toBe('cancelled');
  });

  it('does not re-ingest a legacy processed queue file without a claim marker', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-serve-recover-'));
    const processed = path.join(cwd, '.omakase', 'queue', 'processed');
    mkdirSync(processed, { recursive: true });
    writeFileSync(path.join(processed, 'legacy.prompt'), 'old task that already belonged to another daemon');

    const server = createServer(config(cwd), { write: () => {} });
    const health = await server.cycle();
    expect(health.completed).toBe(0);
    expect(await server.store.list()).toEqual([]);
  });

  it('re-ingests a claimed queue file that never produced a run record', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-serve-recover-'));
    const processed = path.join(cwd, '.omakase', 'queue', 'processed');
    mkdirSync(processed, { recursive: true });
    // Simulate a crash AFTER the claim-rename but BEFORE the first checkpoint:
    // the file sits in processed/ with a claim marker and no corresponding run record.
    writeFileSync(path.join(processed, 'orphan.prompt'), 'summarize the project');
    writeFileSync(
      path.join(processed, 'orphan.prompt.claim.json'),
      JSON.stringify({ version: 1, sourceQueueFile: 'orphan.prompt', state: 'claimed', claimedAt: 1 }),
    );

    const server = createServer(config(cwd), { write: () => {}, now: () => 2 });
    const health = await server.cycle();
    expect(health.completed).toBe(1); // recovered and ran the orphaned task

    const claim = JSON.parse(readFileSync(path.join(processed, 'orphan.prompt.claim.json'), 'utf8')) as {
      state?: string;
      startedAt?: number;
    };
    expect(claim.state).toBe('started');
    expect(claim.startedAt).toBe(2);

    // A second cycle must NOT re-run it (a run record now correlates the file).
    const health2 = await server.cycle();
    expect(health2.completed).toBe(1);
  });

  it('resumes a run a previous process left unfinished', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-serve-resume-'));
    const runsDir = path.join(cwd, '.omakase', 'runs');
    const complexRouter: Router = {
      route: () => ({ kind: 'complex', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
    };
    const exec = createScriptedAgent((input) =>
      String(input.metadata?.role) === 'reviewer'
        ? [{ type: 'text_delta', delta: 'APPROVE' }]
        : [{ type: 'text_delta', delta: 'done' }],
    );
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const chained = {
      plan: (ctx: { idGenerator?: import('@omakase/core').IdGenerator; clock?: () => number }) => {
        const g = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
        const w1 = g.addTask({ title: 'w1', role: 'worker' as const });
        const w2 = g.addTask({ title: 'w2', role: 'worker' as const, dependsOn: [w1.id] });
        g.addTask({ title: 'r', role: 'reviewer' as const, dependsOn: [w2.id] });
        g.refreshReadiness();
        return g;
      },
    };
    const crashed = new Orchestrator({
      runtime,
      router: complexRouter,
      planner: chained,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new FileRunStore(runsDir),
      clock: () => 0,
      detectionOptions: OFFLINE,
      maxIterations: 1,
    });
    const crashedResult = await crashed.start({ prompt: 'work' }).result;
    expect(crashedResult.status).toBe('incomplete');

    // A server over the same runs dir resumes and finishes it via the builtin agent.
    const server = createServer(config(cwd), { write: () => {} });
    const resumed = await server.supervisor.resumeInterrupted();
    expect(resumed).toEqual([crashedResult.id]);
    const health = await server.supervisor.drain();
    expect(health.completed).toBe(1);
    expect(health.runs[0]?.status).toBe('succeeded');
  });
});
