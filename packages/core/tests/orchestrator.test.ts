import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAgentRuntime,
  createScriptedAgent,
  type AgentEvent,
  type AgentExecutor,
  type AgentRunInput,
} from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { FileRunStore, MemoryRunStore, type RunRecord } from '../src/supervisor/run-store.js';
import { FileControlSource, writeControl } from '../src/supervisor/control.js';
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

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
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
  it('allocates distinct run ids across fresh orchestrator instances by default', async () => {
    const store = new MemoryRunStore();
    const simpleRouter: Router = {
      route: () => ({ kind: 'simple', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
    };
    const options = {
      runtime: scriptedRuntime(() => 'done'),
      router: simpleRouter,
      planner: new RulePlanner(),
      policy: customPolicy,
      store,
      clock: () => 0,
      detectionOptions,
    };

    const first = await new Orchestrator(options).start({ prompt: 'first task' }).result;
    const second = await new Orchestrator(options).start({ prompt: 'second task' }).result;

    expect(first.id).not.toBe(second.id);
    expect(await store.list()).toHaveLength(2);
    expect(await store.load(first.id)).not.toBeNull();
    expect(await store.load(second.id)).not.toBeNull();
  });

  it('does not apply a stale control file from a previous run id generation', async () => {
    const runsDir = mkdtempSync(path.join(os.tmpdir(), 'omakase-stale-control-'));
    const store = new FileRunStore(runsDir);
    await writeControl(runsDir, 'run-1', { seq: 9, command: 'stop' });
    const simpleRouter: Router = {
      route: () => ({ kind: 'simple', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
    };

    const result = await new Orchestrator({
      runtime: scriptedRuntime(() => 'done'),
      router: simpleRouter,
      planner: new RulePlanner(),
      policy: customPolicy,
      store,
      control: new FileControlSource(runsDir),
      clock: () => 0,
      detectionOptions,
    }).start({ prompt: 'fresh task' }).result;

    expect(result.status).toBe('succeeded');
    expect(result.id).not.toBe('run-1');
  });

  it('persists a run record immediately after run-started before routing completes', async () => {
    const store = new MemoryRunStore();
    let releaseRoute!: () => void;
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    const blockingRouter: Router = {
      route: async () => {
        await routeGate;
        return { kind: 'simple', reason: 'released', confidence: 1, signals: [], suggestedRole: 'worker' };
      },
    };
    const orch = new Orchestrator({
      runtime: scriptedRuntime(() => 'done'),
      router: blockingRouter,
      planner: new RulePlanner(),
      policy: customPolicy,
      store,
      clock: () => 0,
      detectionOptions,
    });

    const handle = orch.start({
      prompt: 'queued task',
      metadata: { sourceQueueFile: 'queued-task.prompt' },
    });
    const first = await handle.events[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ type: 'run-started', runId: handle.id });

    const rec = await store.load(handle.id);
    expect(rec?.request.metadata?.sourceQueueFile).toBe('queued-task.prompt');
    expect(rec?.events.some((e) => e.type === 'run-started')).toBe(true);

    releaseRoute();
    await handle.result;
  });

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

  it('routes a simple request to a single worker and still emits a planned snapshot for live clients', async () => {
    const runtime = scriptedRuntime(() => 'done');
    const simpleRouter: Router = {
      route: () => ({ kind: 'simple', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
    };
    const orch = new Orchestrator({
      ...baseOptions(runtime, new RulePlanner()),
      router: simpleRouter,
    });
    const events = await collect(orch.start({ prompt: 'summarize' }));
    const planned = events.find((e) => e.type === 'planned');
    expect(planned).toMatchObject({
      type: 'planned',
      snapshot: {
        tasks: [expect.objectContaining({ title: 'Handle request', role: 'worker', tags: ['simple'] })],
      },
    });
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

  it('marks not-yet-run dependent tasks cancelled when a run is stopped', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    async function* blockingWorker(input: AgentRunInput): AsyncGenerator<AgentEvent> {
      started();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'text_delta', delta: 'aborted' };
    }
    const exec = createScriptedAgent((input) => blockingWorker(input));
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const planner: Planner = {
      plan(ctx) {
        const g = new PlanGraph({ idGenerator: ctx.idGenerator, clock: ctx.clock });
        const first = g.addTask({ title: 'first', role: 'worker' });
        const second = g.addTask({ title: 'second', role: 'worker', dependsOn: [first.id] });
        g.addTask({ title: 'review', role: 'reviewer', dependsOn: [first.id, second.id] });
        g.refreshReadiness();
        return g;
      },
    };
    const orch = new Orchestrator(baseOptions(runtime, planner));
    const handle = orch.start({ prompt: 'two-step workflow' });
    await startedP;
    handle.cancel();
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
    expect(result.plan.tasks.map((t) => t.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
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

  it('routes via an agent by default (agent classification overrides the rule heuristic)', async () => {
    // The rule router would score "just do a thing" SIMPLE; the agent says COMPLEX.
    const exec = createScriptedAgent((input) => {
      if (input.prompt.includes('Classify the following request')) {
        return [{ type: 'text_delta', delta: 'COMPLEX' }];
      }
      if (String(input.metadata?.role) === 'reviewer') return [{ type: 'text_delta', delta: 'APPROVE' }];
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({
      runtime, // NO router injected → default agent router
      planner: new RulePlanner(),
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      idGenerator: createIdGenerator(),
      clock: () => 0,
      detectionOptions,
    });
    const events = await collect(orch.start({ prompt: 'just do a thing' }));
    const routed = events.find((e) => e.type === 'routed');
    expect(routed).toMatchObject({ decision: { kind: 'complex' } });
    expect((routed as Extract<OrchestratorEvent, { type: 'routed' }>).decision.reason).toMatch(/classified/i);
    expect(events.some((e) => e.type === 'planned')).toBe(true); // complex → planner ran
  });

  it('falls back to the rule router when the agent answer is unparseable', async () => {
    const exec = createScriptedAgent((input) => {
      if (input.prompt.includes('Classify the following request')) {
        return [{ type: 'text_delta', delta: 'uhh, not sure' }]; // no SIMPLE/COMPLEX
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({
      runtime,
      planner: new RulePlanner(),
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      idGenerator: createIdGenerator(),
      clock: () => 0,
      detectionOptions,
    });
    const events = await collect(orch.start({ prompt: 'summarize the project' }));
    const routed = events.find((e) => e.type === 'routed');
    // Unparseable → rule fallback decided (its reason cites the complexity score).
    expect((routed as Extract<OrchestratorEvent, { type: 'routed' }>).decision.reason).toMatch(/score/i);
    expect(events.some((e) => e.type === 'planned')).toBe(true); // simple still emits a replayable plan snapshot
  });

  it('checkpoints streaming agent events while a task is still running', async () => {
    const store = new MemoryRunStore();
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const exec = createScriptedAgent(async function* (input) {
      if (String(input.metadata?.role) === 'reviewer') {
        yield { type: 'text_delta', delta: 'APPROVE' };
        return;
      }
      yield { type: 'text_delta', delta: 'working' };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } };
      await blocker;
      yield { type: 'text_delta', delta: 'done' };
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({
      ...baseOptions(runtime, new RulePlanner()),
      store,
      maxConcurrency: 1,
    });
    const handle = orch.start({ prompt: '- long task' });
    try {
      const id = await waitFor(async () => (await store.list())[0]);
      await waitFor(async () => {
        const rec = await store.load(id);
        return rec?.plan.tasks.some((t) => t.status === 'running') ? rec : undefined;
      });
      await new Promise((r) => setTimeout(r, 30));
      const mid = await store.load(id);
      expect(mid?.events.some((e) => e.type === 'agent-event')).toBe(true);
    } finally {
      release();
      await handle.result.catch(() => undefined);
    }
  });

  it('uses an agent-backed planner by default and streams planner events before planned', async () => {
    const exec = createScriptedAgent((input) => {
      const role = String(input.metadata?.role ?? 'worker');
      if (role === 'planner') {
        return [
          {
            type: 'text_delta',
            delta:
              '[{"title":"Agent planned implementation","description":"Implement from the agent plan","dependsOn":[]}]',
          },
        ];
      }
      if (role === 'reviewer') return [{ type: 'text_delta', delta: 'APPROVE' }];
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      policy: customPolicy,
      store: new MemoryRunStore(),
      idGenerator: createIdGenerator(),
      clock: () => 0,
      detectionOptions,
    });
    const events = await collect(orch.start({ prompt: 'build a real feature' }));
    const plannerIdx = events.findIndex((e) => e.type === 'agent-event' && e.role === 'planner');
    const plannedIdx = events.findIndex((e) => e.type === 'planned');
    expect(plannerIdx).toBeGreaterThan(-1);
    expect(plannerIdx).toBeLessThan(plannedIdx);
    const planned = events.find((e): e is Extract<OrchestratorEvent, { type: 'planned' }> => e.type === 'planned');
    expect(planned?.snapshot.tasks.some((t) => t.title === 'Agent planned implementation')).toBe(true);
  });

  it('turns agent-planned phase fields into dynamic task phases', async () => {
    const exec = createScriptedAgent((input) => {
      const role = String(input.metadata?.role ?? 'worker');
      if (role === 'planner') {
        return [
          {
            type: 'text_delta',
            delta: JSON.stringify([
              {
                title: 'Inspect runtime state',
                description: 'Read the daemon and TUI state before changing code.',
                phase: 'Discovery',
                dependsOn: [],
              },
              {
                title: 'Repair TUI activity stream',
                description: 'Make the run detail show live planner and worker progress.',
                phase: 'TUI',
                dependsOn: [0],
              },
              {
                title: 'Verify with real agents',
                description: 'Run a live agent smoke test against the daemon-backed path.',
                phase: 'Verification',
                dependsOn: [1],
              },
            ]),
          },
        ];
      }
      if (role === 'reviewer') return [{ type: 'text_delta', delta: 'APPROVE' }];
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      policy: customPolicy,
      store: new MemoryRunStore(),
      idGenerator: createIdGenerator(),
      clock: () => 0,
      detectionOptions,
    });

    const events = await collect(orch.start({ prompt: 'fix a broad multi-agent product workflow' }));
    const planned = events.find((e): e is Extract<OrchestratorEvent, { type: 'planned' }> => e.type === 'planned');
    const workers = planned?.snapshot.tasks.filter((t) => t.role === 'worker') ?? [];

    expect(workers.map((t) => t.tags[0])).toEqual(['Discovery', 'TUI', 'Verification']);
    expect(workers.map((t) => t.tags[0])).not.toContain('implementation');
  });

  it('passes task identity into worker policy selection', async () => {
    const seen: Array<{ id?: string; title?: string; type?: string }> = [];
    const runtime = scriptedRuntime((_input, role) => (role === 'reviewer' ? 'APPROVE' : 'done'));
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      planner: new RulePlanner(),
      policy: {
        mode: 'normal',
        select(role, ctx) {
          if (role === 'worker') {
            seen.push({ id: ctx.taskId, title: ctx.taskTitle, type: ctx.taskType });
          }
          return { role, agentId: 'scripted', model: null, reasoning: null, rationale: 'test' };
        },
      },
      store: new MemoryRunStore(),
      idGenerator: createIdGenerator(),
      clock: () => 0,
      detectionOptions,
    });

    await orch.start({ prompt: '- inspect TUI\n- verify daemon' }).result;

    expect(seen.map((s) => s.title)).toEqual(['inspect TUI', 'verify daemon']);
    expect(seen.map((s) => s.type)).toEqual(['inspect TUI', 'verify daemon']);
    expect(seen.map((s) => s.id)).toEqual([expect.stringMatching(/^task-\d+$/), expect.stringMatching(/^task-\d+$/)]);
  });

  it('honors a per-request agent override (metadata.agentOverride)', async () => {
    const labeled = (label: string) => createScriptedAgent(() => [{ type: 'text_delta', delta: label }]);
    const runtime = createAgentRuntime({ executors: { a: labeled('AAA'), b: labeled('BBB') }, now: () => 0 });
    const simpleRouter: Router = {
      route: () => ({ kind: 'simple', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
    };
    const orch = new Orchestrator({
      runtime,
      router: simpleRouter,
      planner: new RulePlanner(),
      // The configured default is agent 'a' — the per-request override picks 'b'.
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'a' } } }),
      store: new MemoryRunStore(),
      idGenerator: createIdGenerator(),
      clock: () => 0,
      detectionOptions,
    });
    const result = await orch.start({ prompt: 'do it', metadata: { agentOverride: 'b' } }).result;
    expect(result.status).toBe('succeeded');
    const worker = result.plan.tasks.find((t) => t.role === 'worker');
    expect(worker?.result?.agentId).toBe('b'); // ran the overridden agent, not default 'a'
    expect(worker?.result?.output).toContain('BBB');
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
