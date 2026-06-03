import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent, type AgentRuntime } from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { createModelPolicy } from '../src/modes/policy.js';
import { PlanGraph } from '../src/plan/plan-graph.js';
import { RulePlanner, type Planner } from '../src/plan/planner.js';
import type { Router } from '../src/router/router.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
};
const OFFLINE = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;

function scriptedRuntime(): AgentRuntime {
  const exec = createScriptedAgent((input) =>
    String(input.metadata?.role) === 'reviewer'
      ? [{ type: 'text_delta', delta: 'APPROVE' }]
      : [{ type: 'text_delta', delta: 'done' }],
  );
  return createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
}

function orchestrator(runtime: AgentRuntime, store: MemoryRunStore, planner: Planner, extra = {}) {
  return new Orchestrator({
    runtime,
    router: complexRouter,
    planner,
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
    store,
    clock: () => 42,
    detectionOptions: OFFLINE,
    ...extra,
  });
}

describe('Supervisor', () => {
  it('processes a queue, giving each run a distinct id', async () => {
    const store = new MemoryRunStore();
    const sup = new Supervisor({
      orchestrator: orchestrator(scriptedRuntime(), store, new RulePlanner()),
      store,
      clock: () => 42,
    });
    sup.enqueue({ prompt: '- a\n- b' }).enqueue({ prompt: '- c\n- d' });
    const health = await sup.drain();

    expect(health.completed).toBe(2);
    expect(health.state).toBe('idle');
    expect(health.lastHeartbeatAt).toBe(42);
    const ids = health.runs.map((r) => r.id);
    expect(new Set(ids).size).toBe(2); // distinct run ids
    expect(health.runs.every((r) => r.status === 'succeeded')).toBe(true);
  });

  it('resumes runs a crash left non-terminal', async () => {
    const store = new MemoryRunStore();
    const runtime = scriptedRuntime();
    const chained: Planner = {
      plan: (ctx) => {
        const g = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
        const w1 = g.addTask({ title: 'w1', role: 'worker' });
        const w2 = g.addTask({ title: 'w2', role: 'worker', dependsOn: [w1.id] });
        g.addTask({ title: 'review', role: 'reviewer', dependsOn: [w2.id] });
        g.refreshReadiness();
        return g;
      },
    };
    // Interrupt: cap iterations so the run is persisted non-terminal.
    const crashed = orchestrator(runtime, store, chained, { maxIterations: 1 });
    const result = await crashed.start({ prompt: 'do work' }).result;
    expect(result.status).toBe('incomplete');

    // A fresh supervisor over the same store picks it up and finishes it.
    const sup = new Supervisor({
      orchestrator: orchestrator(runtime, store, chained),
      store,
      clock: () => 42,
    });
    const resumed = await sup.resumeInterrupted();
    expect(resumed).toEqual([result.id]);
    const health = await sup.drain();
    expect(health.completed).toBe(1);
    expect(health.runs[0]?.status).toBe('succeeded');
  });

  it('does not re-resume a run it has already handled (no double-resume / livelock)', async () => {
    const store = new MemoryRunStore();
    const runtime = scriptedRuntime();
    const chained: Planner = {
      plan: (ctx) => {
        const g = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
        const w1 = g.addTask({ title: 'w1', role: 'worker' });
        const w2 = g.addTask({ title: 'w2', role: 'worker', dependsOn: [w1.id] });
        g.addTask({ title: 'review', role: 'reviewer', dependsOn: [w2.id] });
        g.refreshReadiness();
        return g;
      },
    };
    const crashed = orchestrator(runtime, store, chained, { maxIterations: 1 });
    const result = await crashed.start({ prompt: 'do work' }).result;
    expect(result.status).toBe('incomplete');

    const sup = new Supervisor({ orchestrator: orchestrator(runtime, store, chained), store, clock: () => 42 });
    expect(await sup.resumeInterrupted()).toEqual([result.id]);
    // A second scan (e.g. the next --watch cycle) must NOT re-queue the same id.
    expect(await sup.resumeInterrupted()).toEqual([]);
  });

  it('re-resumes a run that advanced since it was last handled', async () => {
    const store = new MemoryRunStore();
    const runtime = scriptedRuntime();
    const chained: Planner = {
      plan: (ctx) => {
        const g = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
        const w1 = g.addTask({ title: 'w1', role: 'worker' });
        const w2 = g.addTask({ title: 'w2', role: 'worker', dependsOn: [w1.id] });
        g.addTask({ title: 'review', role: 'reviewer', dependsOn: [w2.id] });
        g.refreshReadiness();
        return g;
      },
    };
    // Crash leaves it incomplete at some checkpointSeq.
    const crashed = orchestrator(runtime, store, chained, { maxIterations: 1 });
    const result = await crashed.start({ prompt: 'do work' }).result;
    expect(result.status).toBe('incomplete');
    const seqAfterCrash = (await store.load(result.id))!.checkpointSeq;

    // The supervisor's orchestrator is ALSO capped, so the resume makes progress
    // (advancing checkpointSeq) yet leaves the run incomplete.
    const sup = new Supervisor({
      orchestrator: orchestrator(runtime, store, chained, { maxIterations: 1 }),
      store,
      clock: () => 42,
    });
    expect(await sup.resumeInterrupted()).toEqual([result.id]);
    await sup.drain();
    const after = await store.load(result.id);
    expect(after!.status).toBe('incomplete');
    expect(after!.checkpointSeq).toBeGreaterThan(seqAfterCrash);

    // Because the run advanced, the next scan re-resumes it (progress, not a
    // livelock on a stuck run).
    expect(await sup.resumeInterrupted()).toEqual([result.id]);
  });

  it('reports the true completed total even past the recent-runs cap', async () => {
    const store = new MemoryRunStore();
    const sup = new Supervisor({
      orchestrator: orchestrator(scriptedRuntime(), store, new RulePlanner()),
      store,
      concurrency: 8,
      clock: () => 1,
    });
    const N = 205;
    for (let i = 0; i < N; i += 1) sup.enqueue({ prompt: `- task ${i}` });
    const health = await sup.drain();
    expect(health.completed).toBe(N); // counter is not capped
    expect(health.runs.length).toBeLessThanOrEqual(200); // recent-runs log is bounded
  });

  it('does not process work while paused, and resumes after', async () => {
    const store = new MemoryRunStore();
    const sup = new Supervisor({
      orchestrator: orchestrator(scriptedRuntime(), store, new RulePlanner()),
      store,
      clock: () => 1,
    });
    sup.enqueue({ prompt: '- a' });
    sup.pause();
    expect((await sup.drain()).completed).toBe(0);
    sup.resume();
    expect((await sup.drain()).completed).toBe(1);
  });

  it('stop() refuses further work', async () => {
    const store = new MemoryRunStore();
    const sup = new Supervisor({
      orchestrator: orchestrator(scriptedRuntime(), store, new RulePlanner()),
      store,
      clock: () => 1,
    });
    sup.enqueue({ prompt: '- a' });
    sup.stop();
    const health = await sup.drain();
    expect(health.state).toBe('stopped');
    expect(health.completed).toBe(0);
  });

  it('processes concurrently with a higher lane count', async () => {
    const store = new MemoryRunStore();
    const sup = new Supervisor({
      orchestrator: orchestrator(scriptedRuntime(), store, new RulePlanner()),
      store,
      concurrency: 3,
      clock: () => 1,
    });
    for (let i = 0; i < 5; i += 1) sup.enqueue({ prompt: `- task ${i}` });
    const health = await sup.drain();
    expect(health.completed).toBe(5);
    expect(new Set(health.runs.map((r) => r.id)).size).toBe(5);
  });
});
