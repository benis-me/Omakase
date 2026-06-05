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

  it('uses task-status timestamps for live task elapsed before the next heartbeat', () => {
    let view = initialRunView('normal');
    view = reduceRunView(view, {
      type: 'task-status',
      taskId: 'task-1',
      title: 'stream work',
      from: 'ready',
      to: 'running',
      at: 123,
    } as any);
    expect(view.tasks[0]?.startedAt).toBe(123);
  });

  it('collects planner phrases from streamed agent events', () => {
    let view = initialRunView('normal');
    view = reduceRunView(view, {
      type: 'agent-event',
      role: 'planner',
      taskId: null,
      assignment: { role: 'planner', agentId: 'codex', model: null, reasoning: null, rationale: 'test' },
      event: { type: 'thinking_delta', delta: 'Inspecting project structure' },
    } as any);
    view = reduceRunView(view, {
      type: 'agent-event',
      role: 'planner',
      taskId: null,
      assignment: { role: 'planner', agentId: 'codex', model: null, reasoning: null, rationale: 'test' },
      event: { type: 'text_delta', delta: 'Plan: add tests first' },
    } as any);
    expect((view as any).phrases).toEqual([
      'planner/codex thinking: Inspecting project structure',
      'planner/codex: Plan: add tests first',
    ]);
  });

  it('keeps a single chronological activity stream for route, planner, and worker progress', () => {
    let view = initialRunView('normal');
    view = reduceRunView(view, {
      type: 'run-started',
      runId: 'run-1',
      request: { prompt: 'build real observability' },
      mode: 'normal',
    } as any);
    view = reduceRunView(view, {
      type: 'routed',
      decision: { kind: 'complex', reason: 'needs multiple agents', confidence: 1, signals: [], suggestedRole: 'worker' },
    } as any);
    view = reduceRunView(view, {
      type: 'agent-event',
      role: 'planner',
      taskId: null,
      assignment: { role: 'planner', agentId: 'codex', model: null, reasoning: null, rationale: 'test' },
      event: { type: 'status', label: 'planning' },
    } as any);
    view = reduceRunView(view, {
      type: 'planned',
      snapshot: { seq: 1, tasks: [] },
    } as any);

    expect(view.activity).toEqual([
      '▶ run run-1 started (normal)',
      expect.stringContaining('routed: complex'),
      'planner/codex status: planning',
      '▤ planned 0 task(s)',
    ]);
  });

  it('sanitizes raw command tool names in phrases while keeping tool counts', () => {
    let view = initialRunView('normal');
    view = reduceRunView(view, {
      type: 'planned',
      snapshot: {
        seq: 1,
        tasks: [
          {
            id: 'task-1',
            title: 'work',
            description: 'work',
            role: 'worker',
            status: 'running',
            dependsOn: [],
            attempts: 0,
            tags: ['implementation'],
            createdAt: 0,
            metadata: {},
          },
        ],
      },
    } as any);
    view = reduceRunView(view, {
      type: 'agent-event',
      role: 'worker',
      taskId: 'task-1',
      assignment: { role: 'worker', agentId: 'codex', model: null, reasoning: null, rationale: 'test' },
      event: { type: 'tool_use', id: 'tool-1', name: '/bin/zsh -lc "sed -n 1,260p file"', input: {} },
    } as any);

    expect(view.tasks[0]?.toolCount).toBe(1);
    expect(view.phrases.at(-1)).toBe('worker/codex tool: tool');
    expect(view.phrases.join('\n')).not.toContain('/bin/zsh');
    expect(view.phrases.join('\n')).not.toContain('sed -n');
  });

  it('formats event lines for humans', () => {
    expect(formatEventLine({ type: 'paused' })).toBe('⏸ paused');
    expect(
      formatEventLine({ type: 'routed', decision: { kind: 'simple', reason: 'short', confidence: 1, signals: [], suggestedRole: 'worker' } }),
    ).toContain('simple');
  });
});
