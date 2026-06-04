import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import {
  MemoryRunStore,
  Orchestrator,
  RulePlanner,
  createModelPolicy,
  type Router,
} from '@omakase/core';
import { buildRunView, formatEventLine, initialRunView, reduceRunView } from '../src/view-model.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 'test', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

async function runScripted() {
  let reviewerCalls = 0;
  const exec = createScriptedAgent((input) => {
    const role = String(input.metadata?.role ?? 'worker');
    if (role === 'reviewer') {
      reviewerCalls += 1;
      return [{ type: 'text_delta', delta: reviewerCalls === 1 ? 'REJECT: more needed' : 'APPROVE' }];
    }
    return [{ type: 'text_delta', delta: 'done' }];
  });
  const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
  const orch = new Orchestrator({
    runtime,
    router: complexRouter,
    planner: new RulePlanner(),
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
    store: new MemoryRunStore(),
    clock: () => 0,
    detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
  });
  const handle = orch.start({ prompt: '- add a parser\n- add a CLI' });
  const result = await handle.result;
  return result;
}

describe('view-model', () => {
  it('folds a full run into a render-ready view', async () => {
    const result = await runScripted();
    const view = buildRunView(result.events, 'normal');
    expect(view.status).toBe('succeeded');
    expect(view.route?.kind).toBe('complex');
    expect(view.tasks.length).toBeGreaterThan(0);
    expect(view.tasks.every((t) => t.status === 'succeeded')).toBe(true);
    expect(view.wikiEntries).toBeGreaterThan(0);
    expect(view.lastReview?.approved).toBe(true);
    expect(view.summary).toMatch(/succeeded/);
  });

  it('reduces incrementally and matches a full fold', async () => {
    const result = await runScripted();
    let view = initialRunView('normal');
    for (const event of result.events) view = reduceRunView(view, event);
    expect(view).toEqual(buildRunView(result.events, 'normal'));
  });

  it('accumulates per-task token/tool/agent stats, phases, and header — surviving replan', async () => {
    let reviewerCalls = 0;
    const exec = createScriptedAgent((input) => {
      if (String(input.metadata?.role) === 'reviewer') {
        reviewerCalls += 1;
        return [{ type: 'text_delta', delta: reviewerCalls === 1 ? 'REJECT: more needed' : 'APPROVE' }];
      }
      return [
        { type: 'text_delta', delta: 'done' },
        { type: 'tool_use', id: 'a', name: 'read', input: {} },
        { type: 'tool_use', id: 'b', name: 'write', input: {} },
        { type: 'usage', usage: { inputTokens: 80, outputTokens: 40 } },
      ];
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 5 });
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      planner: new RulePlanner(),
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 5,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });
    const result = await orch.start({ prompt: '- add a parser\n- add a CLI' }).result;
    expect(result.status).toBe('succeeded');
    const view = buildRunView(result.events, 'normal');

    const workers = view.tasks.filter((t) => t.role === 'worker');
    expect(workers.length).toBeGreaterThan(0);
    for (const w of workers) {
      // 120 tokens + 2 tools accumulated, and SURVIVED the rejection→replan
      // (upsert merges by id rather than replacing — which would zero them).
      expect(w.tokens).toBe(120);
      expect(w.toolCount).toBe(2);
      expect(w.agentId).toBe('scripted');
      expect(w.finishedAt).toBe(5);
    }
    expect(view.totalTokens).toBeGreaterThanOrEqual(120 * workers.length);
    expect(view.phases.length).toBeGreaterThan(0);
    expect(view.phases.reduce((s, p) => s + p.total, 0)).toBe(view.tasks.length);
    expect(view.totalAgents).toBe(view.tasks.length);
    expect(view.title).toContain('add a parser');
  });

  it('formats event lines for humans', () => {
    expect(formatEventLine({ type: 'paused' })).toBe('⏸ paused');
    expect(
      formatEventLine({ type: 'routed', decision: { kind: 'simple', reason: 'short', confidence: 1, signals: [], suggestedRole: 'worker' } }),
    ).toContain('simple');
  });
});
