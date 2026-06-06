import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { createModelPolicy } from '../src/modes/policy.js';
import type { Router } from '../src/router/router.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 'complex', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

function orchForReview(verdicts: unknown[]) {
  let reviewIndex = 0;
  const exec = createScriptedAgent((input) => {
    if (String(input.metadata?.role) === 'reviewer') {
      const verdict = verdicts[Math.min(reviewIndex, verdicts.length - 1)];
      reviewIndex += 1;
      return [{ type: 'text_delta', delta: JSON.stringify(verdict) }];
    }
    return [{ type: 'text_delta', delta: 'worker done' }];
  });
  return new Orchestrator({
    runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
    router: complexRouter,
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
    store: new MemoryRunStore(),
    clock: () => 0,
    detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
  });
}

describe('orchestrator long-running acceptance loop', () => {
  it('emits acceptance and iteration state and only succeeds when all criteria pass', async () => {
    const orch = orchForReview([
      [
        { met: true, note: 'feature works' },
        { met: false, note: 'tests missing' },
      ],
      [
        { met: true, note: 'feature works' },
        { met: true, note: 'tests now pass' },
      ],
    ]);

    const result = await orch.start({
      prompt: '- build feature',
      acceptanceCriteria: ['feature works', 'tests pass'],
    }).result;

    expect(result.status).toBe('succeeded');
    expect(result.acceptance.criteria.map((c) => c.status)).toEqual(['pass', 'pass']);
    expect(result.acceptance.progress).toEqual({ passed: 2, total: 2, complete: true });
    expect(result.iterations.length).toBeGreaterThanOrEqual(1);
    expect(result.events.some((e) => e.type === 'acceptance-updated')).toBe(true);
    expect(result.events.some((e) => e.type === 'iteration-updated')).toBe(true);
  });

  it('persists acceptance and iteration state in run records', async () => {
    const store = new MemoryRunStore();
    const exec = createScriptedAgent((input) =>
      String(input.metadata?.role) === 'reviewer'
        ? [{ type: 'text_delta', delta: JSON.stringify([{ met: true, note: 'ok' }]) }]
        : [{ type: 'text_delta', delta: 'done' }],
    );
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store,
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const result = await orch.start({ prompt: '- build feature', acceptanceCriteria: ['ok'] }).result;
    const record = await store.load(result.id);

    expect(record?.acceptance?.criteria[0]?.title).toBe('ok');
    expect(record?.acceptance?.progress.complete).toBe(true);
    expect(record?.iterations?.length).toBeGreaterThan(0);
  });

  it('creates planning and review reports without mutating the task graph', async () => {
    const orch = orchForReview([[{ met: true, note: 'ok' }]]);
    const result = await orch.start({ prompt: '- build feature', acceptanceCriteria: ['ok'] }).result;

    expect(result.reports.map((report) => report.kind)).toEqual(expect.arrayContaining(['planning', 'review']));
    expect(result.events.some((event) => event.type === 'report-created')).toBe(true);
    expect(result.events.some((event) => event.type === 'knowledge-event-created')).toBe(true);
    expect(result.plan.tasks.every((task) => task.role !== ('reporter' as any))).toBe(true);
    expect(result.acceptance.progress.complete).toBe(true);
  });
});
