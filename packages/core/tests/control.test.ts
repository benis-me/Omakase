import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAgentRuntime,
  type AgentEvent,
  type AgentExecutor,
} from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import {
  FakeControlSource,
  FileControlSource,
  writeControl,
  type ControlPoll,
} from '../src/supervisor/control.js';
import { createModelPolicy } from '../src/modes/policy.js';
import { createIdGenerator } from '../src/ids.js';
import type { Router } from '../src/router/router.js';
import type { OrchestratorEvent } from '../src/run-events.js';

const simpleRouter: Router = {
  route: () => ({ kind: 'simple', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
};
const OFFLINE = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;

/**
 * A worker that blocks until either externally released or its run is aborted —
 * so a control command can land while it is genuinely in-flight.
 */
function controllableRuntime() {
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const releaseP = new Promise<void>((r) => (release = r));
  let aborted = false;

  const exec: AgentExecutor = (ctx) => {
    const signal = ctx.input.signal;
    async function* gen(): AsyncGenerator<AgentEvent> {
      started();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          aborted = true;
          return resolve();
        }
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
        void releaseP.then(() => resolve());
      });
      yield { type: 'text_delta', delta: 'done' };
    }
    return gen();
  };

  return {
    runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
    startedP,
    release,
    aborted: () => aborted,
  };
}

function harness(control: FakeControlSource) {
  const ticks: Array<() => void> = [];
  const controlPoll: ControlPoll = (tick) => {
    ticks.push(tick);
    return () => {};
  };
  const pump = async (): Promise<void> => {
    for (const t of ticks) t();
    await new Promise((r) => setTimeout(r, 0));
  };
  const { runtime, startedP, release, aborted } = controllableRuntime();
  const orch = new Orchestrator({
    runtime,
    router: simpleRouter,
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
    store: new MemoryRunStore(),
    idGenerator: createIdGenerator(),
    clock: () => 0,
    detectionOptions: OFFLINE,
    control,
    controlPoll,
  });
  return { orch, pump, startedP, release, aborted };
}

describe('cross-process run control', () => {
  it('a stop command cancels a mid-flight run (aborting the in-flight agent)', async () => {
    const control = new FakeControlSource();
    const { orch, pump, startedP, aborted } = harness(control);
    const handle = orch.start({ prompt: 'do work' });
    control.set(handle.id, { seq: 1, command: 'stop' });
    await startedP; // the worker agent is now in-flight
    await pump(); // poll tick → applyControl → cancel()
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
    expect(aborted()).toBe(true); // the agent's stream was aborted mid-flight
  });

  it('pause emits paused, resume emits resumed', async () => {
    const control = new FakeControlSource();
    const { orch, pump, startedP, release } = harness(control);
    const handle = orch.start({ prompt: 'do work' });
    await startedP;
    control.set(handle.id, { seq: 1, command: 'pause' });
    await pump();
    control.set(handle.id, { seq: 2, command: 'resume' });
    await pump();
    release(); // let the worker finish so the run can complete
    const result = await handle.result;
    const types = result.events.map((e: OrchestratorEvent) => e.type);
    expect(types).toContain('paused');
    expect(types).toContain('resumed');
    expect(result.status).toBe('succeeded');
  });

  it('ignores a command whose seq did not advance (idempotent)', async () => {
    const control = new FakeControlSource();
    const { orch, pump, startedP, release } = harness(control);
    const handle = orch.start({ prompt: 'do work' });
    await startedP;
    control.set(handle.id, { seq: 1, command: 'pause' });
    await pump();
    // A resume at the SAME seq must be ignored (seq not advanced).
    control.set(handle.id, { seq: 1, command: 'resume' });
    await pump();
    // Only a higher seq applies.
    control.set(handle.id, { seq: 2, command: 'resume' });
    await pump();
    release();
    const result = await handle.result;
    const types = result.events.map((e: OrchestratorEvent) => e.type);
    const pausedCount = types.filter((t) => t === 'paused').length;
    const resumedCount = types.filter((t) => t === 'resumed').length;
    expect(pausedCount).toBe(1);
    expect(resumedCount).toBe(1); // the same-seq resume did not double-apply
    expect(result.status).toBe('succeeded');
  });
});

describe('FileControlSource', () => {
  it('round-trips a command written atomically and tolerates missing/torn files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-control-'));
    const src = new FileControlSource(dir);
    expect(await src.read('run-1')).toBeNull(); // no file yet
    await writeControl(dir, 'run-1', { seq: 3, command: 'stop' });
    expect(await src.read('run-1')).toEqual({ seq: 3, command: 'stop' });
    // A torn / not-yet-renamed write reads as null, never throws.
    writeFileSync(path.join(dir, 'run-2.control.json'), '{ not json');
    expect(await src.read('run-2')).toBeNull();
  });
});
