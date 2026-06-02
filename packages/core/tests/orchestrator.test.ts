import { describe, expect, it } from 'vitest';
import {
  createAgentRuntime,
  createScriptedAgent,
  type AgentRunInput,
} from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { createModelPolicy } from '../src/modes/policy.js';
import { RulePlanner, type Planner } from '../src/plan/planner.js';
import { PlanGraph } from '../src/plan/plan-graph.js';
import { createIdGenerator } from '../src/ids.js';
import type { Router } from '../src/router/router.js';
import type { OrchestratorEvent } from '../src/run-events.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 'test', confidence: 1, signals: [], suggestedRole: 'worker' }),
};
const customPolicy = createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } });
const detectionOptions = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;

function scriptedRuntime(
  handler: (input: AgentRunInput, role: string) => string,
  counts?: Map<string, number>,
) {
  const exec = createScriptedAgent((input) => {
    const role = String(input.metadata?.role ?? 'worker');
    if (counts) {
      const id = String(input.metadata?.taskId ?? '');
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [{ type: 'text_delta', delta: handler(input, role) }];
  });
  return createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
}

async function collect(handle: { events: AsyncIterable<OrchestratorEvent> }): Promise<OrchestratorEvent[]> {
  const out: OrchestratorEvent[] = [];
  for await (const event of handle.events) out.push(event);
  return out;
}

function baseOptions(runtime: ReturnType<typeof scriptedRuntime>, planner: Planner) {
  return {
    runtime,
    router: complexRouter,
    planner,
    policy: customPolicy,
    store: new MemoryRunStore(),
    idGenerator: createIdGenerator(),
    clock: () => 0,
    detectionOptions,
  };
}

describe('Orchestrator (Ralph loop)', () => {
  it('runs router → planner → workers → reviewer → replan → finish', async () => {
    let reviewerCalls = 0;
    const runtime = scriptedRuntime((_input, role) => {
      if (role === 'reviewer') {
        reviewerCalls += 1;
        return reviewerCalls === 1 ? 'REJECT: please add error handling' : 'APPROVE: looks good';
      }
      return 'Implemented the task.';
    });
    const orch = new Orchestrator(baseOptions(runtime, new RulePlanner()));
    const handle = orch.start({ prompt: '- add a parser\n- add a CLI' });
    const events = await collect(handle);
    const result = await handle.result;

    const types = events.map((e) => e.type);
    expect(types).toContain('run-started');
    expect(events.find((e) => e.type === 'routed')).toMatchObject({ decision: { kind: 'complex' } });
    expect(types).toContain('planned');
    expect(events.some((e) => e.type === 'task-finished' && e.role === 'worker')).toBe(true);

    const reviews = events.filter((e): e is Extract<OrchestratorEvent, { type: 'review' }> => e.type === 'review');
    expect(reviews.map((r) => r.approved)).toEqual([false, true]);
    expect(events.some((e) => e.type === 'replanned' && e.reason === 'review-rejected')).toBe(true);

    expect(events.at(-1)).toMatchObject({ type: 'run-finished', status: 'succeeded' });
    expect(result.status).toBe('succeeded');
    expect(reviewerCalls).toBe(2);
  });

  it('routes a simple request straight to a single worker (no planner)', async () => {
    const runtime = scriptedRuntime(() => 'done');
    const simpleRouter: Router = {
      route: () => ({ kind: 'simple', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
    };
    const orch = new Orchestrator({
      ...baseOptions(runtime, new RulePlanner()),
      router: simpleRouter,
    });
    const events = await collect(orch.start({ prompt: 'summarize' }));
    expect(events.some((e) => e.type === 'planned')).toBe(false);
    expect(events.filter((e) => e.type === 'task-finished')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'run-finished', status: 'succeeded' });
  });

  it('accepts mid-run user input and replans', async () => {
    const runtime = scriptedRuntime((_i, role) => (role === 'reviewer' ? 'APPROVE' : 'done'));
    const orch = new Orchestrator(baseOptions(runtime, new RulePlanner()));
    const handle = orch.start({ prompt: '- task one\n- task two' });
    handle.appendUserInput('also add request logging');
    const events = await collect(handle);
    const result = await handle.result;

    expect(events.some((e) => e.type === 'user-input')).toBe(true);
    expect(events.some((e) => e.type === 'replanned' && e.reason === 'user-input')).toBe(true);
    expect(result.plan.tasks.some((t) => t.tags.includes('user-input'))).toBe(true);
    expect(result.status).toBe('succeeded');
  });

  it('checkpoints and resumes a partially-run plan without redoing work', async () => {
    const counts = new Map<string, number>();
    const runtime = scriptedRuntime((_i, role) => (role === 'reviewer' ? 'APPROVE' : 'done'), counts);
    const store = new MemoryRunStore();
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

    // Run A stops after one iteration (one task), simulating a crash mid-plan.
    const a = new Orchestrator({
      ...baseOptions(runtime, chained),
      store,
      router: complexRouter,
      maxIterations: 1,
    });
    const handleA = a.start({ prompt: 'do work' });
    await collect(handleA);
    const resultA = await handleA.result;
    expect(resultA.status).not.toBe('succeeded');
    const firstWorkerId = resultA.plan.tasks.find((t) => t.status === 'succeeded')?.id;
    expect(firstWorkerId).toBeTruthy();
    expect(counts.get(firstWorkerId!)).toBe(1);

    // Run B resumes from the same store and finishes the remaining tasks.
    const b = new Orchestrator({ ...baseOptions(runtime, chained), store });
    const handleB = await b.resume(resultA.id);
    expect(handleB).not.toBeNull();
    await collect(handleB!);
    const resultB = await handleB!.result;

    expect(resultB.status).toBe('succeeded');
    // The already-completed worker was NOT executed again.
    expect(counts.get(firstWorkerId!)).toBe(1);
    expect(resultB.plan.tasks.every((t) => t.status === 'succeeded')).toBe(true);
  });

  it('supports cancel', async () => {
    const runtime = scriptedRuntime(() => 'done');
    const orch = new Orchestrator(baseOptions(runtime, new RulePlanner()));
    const handle = orch.start({ prompt: '- a\n- b' });
    handle.cancel();
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
  });

  it('supports pause then resume', async () => {
    const runtime = scriptedRuntime((_i, role) => (role === 'reviewer' ? 'APPROVE' : 'done'));
    const orch = new Orchestrator(baseOptions(runtime, new RulePlanner()));
    const handle = orch.start({ prompt: '- a\n- b' });
    handle.pause();
    setTimeout(() => handle.resume(), 20);
    const events = await collect(handle);
    const result = await handle.result;
    expect(events.some((e) => e.type === 'paused')).toBe(true);
    expect(events.some((e) => e.type === 'resumed')).toBe(true);
    expect(result.status).toBe('succeeded');
  });
});
