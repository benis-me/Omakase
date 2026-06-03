import { describe, expect, it } from 'vitest';
import {
  createAgentRuntime,
  createScriptedAgent,
  type AgentEvent,
  type AgentExecutor,
  type AgentRunInput,
} from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore, type RunRecord } from '../src/supervisor/run-store.js';
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
    // Hitting the iteration cap with work still pending is 'incomplete', not 'failed'.
    expect(resultA.status).toBe('incomplete');
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

  it('does not treat a crashed/empty reviewer as an approval', async () => {
    // The reviewer agent errors (no verdict text); workers succeed.
    const exec = createScriptedAgent((input) =>
      String(input.metadata?.role) === 'reviewer'
        ? [{ type: 'error', message: 'reviewer crashed' }]
        : [{ type: 'text_delta', delta: 'done' }],
    );
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({ ...baseOptions(runtime, new RulePlanner()), maxAttemptsPerTask: 2 });
    const result = await orch.start({ prompt: '- a\n- b' }).result;
    // The reviewer never produced a verdict → it must NOT be reported succeeded.
    expect(result.status).not.toBe('succeeded');
    const reviewer = result.plan.tasks.find((t) => t.role === 'reviewer');
    expect(reviewer?.status === 'failed' || reviewer?.status === 'blocked').toBe(true);
  });

  it('runs independent ready tasks concurrently (bounded by maxConcurrency)', async () => {
    // Workers block on a gate that only releases once BOTH have started — so
    // the run can only complete if the two independent workers run in parallel.
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exec = createScriptedAgent(async (input) => {
      if (String(input.metadata?.role) === 'reviewer') return [{ type: 'text_delta', delta: 'APPROVE' }];
      started += 1;
      if (started >= 2) release();
      await gate;
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({ ...baseOptions(runtime, new RulePlanner()), maxConcurrency: 2 });
    const result = await orch.start({ prompt: '- task a\n- task b' }).result;
    expect(started).toBe(2);
    expect(result.status).toBe('succeeded');
  });

  it('still completes with maxConcurrency=1 (sequential)', async () => {
    const runtime = scriptedRuntime((_i, role) => (role === 'reviewer' ? 'APPROVE' : 'done'));
    const orch = new Orchestrator({ ...baseOptions(runtime, new RulePlanner()), maxConcurrency: 1 });
    const result = await orch.start({ prompt: '- task a\n- task b' }).result;
    expect(result.status).toBe('succeeded');
  });

  it('stops scheduling new tasks when the token budget is exhausted', async () => {
    const exec = createScriptedAgent(() => [
      { type: 'text_delta', delta: 'done' },
      { type: 'usage', usage: { inputTokens: 50, outputTokens: 50 } },
    ]);
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({
      ...baseOptions(runtime, new RulePlanner()),
      maxConcurrency: 1,
      budget: { maxTokens: 150 },
    });
    const result = await orch.start({ prompt: '- task a\n- task b' }).result;
    expect(result.events.some((e) => e.type === 'budget-exhausted')).toBe(true);
    expect(result.spentTokens).toBeGreaterThanOrEqual(150);
    expect(result.status).toBe('incomplete');
    expect(result.plan.tasks.find((t) => t.role === 'reviewer')?.status).not.toBe('succeeded');
  });

  it('carries budget spend across resume so the ceiling is not reset', async () => {
    const store = new MemoryRunStore();
    let workerRuns = 0;
    const exec = createScriptedAgent((input) => {
      if (String(input.metadata?.role) !== 'reviewer') workerRuns += 1;
      return [
        { type: 'text_delta', delta: 'done' },
        { type: 'usage', usage: { inputTokens: 50, outputTokens: 50 } },
      ];
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const opts = {
      runtime,
      router: complexRouter,
      planner: new RulePlanner(),
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store,
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      maxConcurrency: 1,
      budget: { maxTokens: 150 },
    };
    const first = await new Orchestrator(opts).start({ prompt: '- task a\n- task b' }).result;
    expect(first.status).toBe('incomplete');
    expect(first.spentTokens).toBeGreaterThanOrEqual(150);
    const runsAfterFirst = workerRuns;

    const handle = await new Orchestrator(opts).resume(first.id);
    const second = await handle!.result;
    expect(second.spentTokens).toBeGreaterThanOrEqual(150);
    expect(workerRuns).toBe(runsAfterFirst); // resume spent nothing more
    expect(second.status).toBe('incomplete');
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

  it('keeps a succeeded outcome when the terminal save fails (no flip to failed)', async () => {
    class TerminalFailStore extends MemoryRunStore {
      override async save(rec: RunRecord): Promise<void> {
        // Running checkpoints succeed; only the terminal (non-running) save fails.
        if (rec.status !== 'running') throw new Error('ENOSPC on terminal save');
        return super.save(rec);
      }
    }
    const runtime = scriptedRuntime(() => 'done');
    const simpleRouter: Router = {
      route: () => ({ kind: 'simple', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
    };
    const orch = new Orchestrator({
      ...baseOptions(runtime, new RulePlanner()),
      router: simpleRouter,
      store: new TerminalFailStore(),
    });
    const handle = orch.start({ prompt: 'summarize' });
    const events = await collect(handle);
    const result = await handle.result;
    expect(result.status).toBe('succeeded'); // not flipped to 'failed'
    const finals = events.filter((e) => e.type === 'run-finished');
    expect(finals).toHaveLength(1); // no contradictory second run-finished
    expect(finals[0]).toMatchObject({ status: 'succeeded' });
  });

  it('resume yields a single coherent event log (one run-started, one run-finished)', async () => {
    const runtime = scriptedRuntime((_i, role) => (role === 'reviewer' ? 'APPROVE' : 'done'));
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
    const a = new Orchestrator({ ...baseOptions(runtime, chained), store, maxIterations: 1 });
    const resA = await a.start({ prompt: 'do work' }).result;
    expect(resA.status).toBe('incomplete');

    const b = new Orchestrator({ ...baseOptions(runtime, chained), store });
    const hb = await b.resume(resA.id);
    const resB = await hb!.result;
    expect(resB.status).toBe('succeeded');
    expect(resB.events.filter((e) => e.type === 'run-started')).toHaveLength(1);
    expect(resB.events.filter((e) => e.type === 'run-finished')).toHaveLength(1);
    expect(resB.events.at(-1)?.type).toBe('run-finished');
  });

  it('resumed wiki uses the injected clock, not Date.now()', async () => {
    const runtime = scriptedRuntime((_i, role) => (role === 'reviewer' ? 'APPROVE' : 'done'));
    const store = new MemoryRunStore();
    const chained: Planner = {
      plan: (ctx) => {
        const g = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
        const w1 = g.addTask({ title: 'w1', role: 'worker' });
        g.addTask({ title: 'review', role: 'reviewer', dependsOn: [w1.id] });
        g.refreshReadiness();
        return g;
      },
    };
    const a = new Orchestrator({ ...baseOptions(runtime, chained), store, maxIterations: 1 });
    const resA = await a.start({ prompt: 'do work' }).result;
    expect(resA.status).toBe('incomplete');

    const RESUME_CLOCK = 777;
    const b = new Orchestrator({ ...baseOptions(runtime, chained), store, clock: () => RESUME_CLOCK });
    const resB = await (await b.resume(resA.id))!.result;
    expect(resB.status).toBe('succeeded');
    // The run-outcome note added at finish must carry the injected clock value.
    const note = resB.wiki.entries.find((e) => e.title.includes('succeeded'));
    expect(note?.createdAt).toBe(RESUME_CLOCK);
  });

  it('treats a sibling-aborted task as cancelled, not a failed verdict', async () => {
    // Raw executor (createScriptedAgent would swallow a throw): the second worker
    // to start rejects its stream → runBatch aborts the first, in-flight worker.
    // The aborted sibling must end 'cancelled' with no verdict event/attempt.
    let gateWorkerStarted = false;
    let workerSeq = 0;
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      const signal = ctx.input.signal;
      async function* thrower(): AsyncGenerator<AgentEvent> {
        await new Promise((r) => setTimeout(r, 15)); // let the gate worker start
        throw new Error('lane blew up');
      }
      async function* gate(): AsyncGenerator<AgentEvent> {
        gateWorkerStarted = true;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        // Aborted: end with no events (the stream just closes).
      }
      async function* reviewer(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', delta: 'APPROVE' };
      }
      if (role === 'reviewer') return reviewer();
      // First worker gates (will be aborted); second worker throws (aborts it).
      return workerSeq++ === 0 ? gate() : thrower();
    };
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({
      ...baseOptions(runtime, new RulePlanner()),
      maxConcurrency: 2,
    });
    const handle = orch.start({ prompt: '- task one\n- task two' });
    const events = await collect(handle);
    const result = await handle.result;

    expect(gateWorkerStarted).toBe(true);
    expect(result.status).toBe('failed'); // the lane error fails the run
    const cancelled = result.plan.tasks.filter(
      (t) => t.role === 'worker' && t.status === 'cancelled',
    );
    expect(cancelled).toHaveLength(1); // the aborted sibling, marked cancelled
    expect(cancelled[0]!.attempts).toBe(0); // the consumed attempt was refunded
    // No contradictory task-finished verdict was emitted for the aborted sibling.
    expect(
      events.some((e) => e.type === 'task-finished' && e.taskId === cancelled[0]!.id),
    ).toBe(false);
  });
});
