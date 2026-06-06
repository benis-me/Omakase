import { describe, expect, it } from 'vitest';
import {
  createAgentRuntime,
  createScriptedAgent,
} from '@omakase/daemon';
import { createRiskGate, answerRiskGate } from '../src/risk-gates.js';
import { Orchestrator } from '../src/orchestrator.js';
import { PlanGraph } from '../src/plan/plan-graph.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { FakeControlSource, type ControlPoll } from '../src/supervisor/control.js';
import { createModelPolicy } from '../src/modes/policy.js';
import type { Planner } from '../src/plan/planner.js';
import type { Router } from '../src/router/router.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 'test', confidence: 1, signals: [], suggestedRole: 'worker' }),
};
const oneWorkerThenReview: Planner = {
  plan: (ctx) => {
    const graph = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
    const worker = graph.addTask({ title: 'implement', role: 'worker' });
    graph.addTask({ title: 'review', role: 'reviewer', dependsOn: [worker.id] });
    graph.refreshReadiness();
    return graph;
  },
};

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function gatedHarness() {
  const control = new FakeControlSource();
  const ticks: Array<() => void> = [];
  const controlPoll: ControlPoll = (tick) => {
    ticks.push(tick);
    return () => {};
  };
  const pump = async (): Promise<void> => {
    for (const tick of ticks) tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  let reviewerCalls = 0;
  const exec = createScriptedAgent((input) => {
    if (String(input.metadata?.role) === 'reviewer') {
      reviewerCalls += 1;
      return [
        {
          type: 'text_delta',
          delta: reviewerCalls <= 2 ? 'I cannot verify this safely yet.' : 'APPROVE',
        },
      ];
    }
    return [{ type: 'text_delta', delta: 'done' }];
  });
  const store = new MemoryRunStore();
  const orch = new Orchestrator({
    runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
    router: complexRouter,
    planner: oneWorkerThenReview,
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
    store,
    clock: () => 0,
    detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    control,
    controlPoll,
  });
  return { control, orch, pump, store };
}

describe('risk gates', () => {
  it('creates an open gate and closes it with an answer', () => {
    const gate = createRiskGate({
      reason: 'review-uncertain',
      question: 'Reviewer cannot determine whether the work is safe. Continue?',
      taskId: 'review-1',
      clock: () => 10,
      nextId: (prefix) => `${prefix}-1`,
    });

    expect(gate).toMatchObject({
      id: 'gate-1',
      status: 'open',
      reason: 'review-uncertain',
      taskId: 'review-1',
      createdAt: 10,
      updatedAt: 10,
    });

    expect(answerRiskGate(gate, { answer: 'continue with a smaller change', clock: () => 20 })).toMatchObject({
      id: 'gate-1',
      status: 'answered',
      answer: 'continue with a smaller change',
      updatedAt: 20,
    });
  });

  it('opens a gate and waits for control input after repeated uncertain review output', async () => {
    const { control, orch, pump, store } = gatedHarness();
    const handle = orch.start({ prompt: '- build feature', acceptanceCriteria: ['feature is safe'] });
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });

    const opened = await waitFor(async () => {
      const record = await store.load(handle.id);
      return record?.riskGates?.find((gate) => gate.status === 'open');
    });
    expect(opened.reason).toBe('review-uncertain');
    expect(settled).toBe(false);

    control.set(handle.id, {
      seq: 1,
      command: 'answer-gate',
      gateId: opened.id,
      answer: 'continue with a safer revision',
    });
    await pump();

    const result = await handle.result;
    expect(result.status).toBe('succeeded');
    expect(result.riskGates[0]).toMatchObject({ id: opened.id, status: 'answered' });
    expect(result.events.some((event) => event.type === 'risk-gate-opened')).toBe(true);
    expect(result.events.some((event) => event.type === 'risk-gate-answered')).toBe(true);
  });
});
