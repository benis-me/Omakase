import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { FileRunStore, Orchestrator, PlanGraph, createModelPolicy, type Router } from '@omakase/core';
import { createServer, type ServeConfig } from '../src/serve.js';

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
