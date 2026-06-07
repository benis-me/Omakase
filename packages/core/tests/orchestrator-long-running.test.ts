import { describe, expect, it } from 'vitest';
import {
  createAgentRuntime,
  createScriptedAgent,
  type AgentEvent,
  type AgentExecutor,
  type DetectedAgent,
} from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { PlanGraph } from '../src/plan/plan-graph.js';
import type { Planner } from '../src/plan/planner.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { createModelPolicy } from '../src/modes/policy.js';
import type { Router } from '../src/router/router.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 'complex', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  it('turns mid-run requirement input into user acceptance criteria and review work', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const releaseP = new Promise<void>((resolve) => (release = resolve));
    let workerCalls = 0;

    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        if (role === 'reviewer') {
          yield {
            type: 'text_delta',
            delta: JSON.stringify([
              { met: true, note: 'Original request completed.' },
              { met: true, note: 'Live worker metrics are now visible.' },
            ]),
          };
          return;
        }

        workerCalls += 1;
        if (workerCalls === 1) {
          started();
          await releaseP;
        }
        yield { type: 'text_delta', delta: `worker ${workerCalls} done` };
      }
      return gen();
    };
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: { route: () => ({ kind: 'simple', reason: 'test', confidence: 1, signals: [], suggestedRole: 'worker' }) },
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      maxIterations: 5,
    });

    const handle = orch.start({ prompt: 'make the run visible' });
    await startedP;
    handle.appendUserInput('Show live worker tokens, tools, and elapsed time in the TUI.');
    release();
    const result = await handle.result;

    expect(result.status).toBe('succeeded');
    expect(result.acceptance.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Show live worker tokens, tools, and elapsed time in the TUI.',
          source: 'user',
          status: 'pass',
        }),
      ]),
    );
    expect(result.plan.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'worker', tags: ['user-input'] }),
        expect.objectContaining({ role: 'reviewer' }),
      ]),
    );
    expect(result.events.some((event) => event.type === 'user-input')).toBe(true);
    expect(result.events.some((event) => event.type === 'replanned' && event.reason === 'user-input')).toBe(true);
  });

  it('normal mode visibly distributes parallel worker tasks across authenticated agents', async () => {
    const detected = (id: string): DetectedAgent =>
      ({
        id,
        name: id,
        bin: id,
        streamFormat: 'jsonl',
        promptViaStdin: true,
        supportsImagePaths: false,
        supportsCustomModel: true,
        reasoningOptions: [{ id: 'high', label: 'High' }],
        externalMcpInjection: undefined,
        installUrl: undefined,
        docsUrl: undefined,
        available: true,
        path: `/bin/${id}`,
        version: 'test',
        models: [{ id: 'default', label: 'Default' }],
        modelsSource: 'fallback',
        capabilities: {},
        authStatus: 'ok',
        authMessage: undefined,
      }) as DetectedAgent;
    const planner: Planner = {
      plan: (ctx) => {
        const graph = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
        const a = graph.addTask({ title: 'Collect package evidence', role: 'worker', tags: ['implementation'] });
        const b = graph.addTask({ title: 'Collect docs evidence', role: 'worker', tags: ['implementation'] });
        graph.addTask({
          title: 'Review distributed evidence',
          role: 'reviewer',
          dependsOn: [a.id, b.id],
          tags: ['Review'],
        });
        graph.refreshReadiness();
        return graph;
      },
    };
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        yield { type: 'status', label: 'working' };
        if (role === 'reviewer') {
          yield {
            type: 'text_delta',
            delta: JSON.stringify([
              { met: true, note: 'Package evidence was collected.' },
              { met: true, note: 'Docs evidence was collected.' },
            ]),
          };
        } else {
          yield { type: 'text_delta', delta: `${ctx.input.agentId} completed ${ctx.input.metadata?.taskId}` };
          yield { type: 'usage', usage: { totalTokens: 7 } };
        }
      }
      return gen();
    };
    const runtime = createAgentRuntime({ executors: { codex: exec, gemini: exec }, now: () => 0 });
    (runtime as any).detect = async () => [detected('codex'), detected('gemini')];
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      planner,
      policy: createModelPolicy('normal', { ranking: ['codex', 'gemini'] }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      maxConcurrency: 2,
    });

    const result = await orch.start({
      prompt: 'collect independent evidence with multiple workers',
      acceptanceCriteria: ['Package evidence was collected.', 'Docs evidence was collected.'],
      metadata: { supportAgents: false },
    }).result;

    expect(result.status).toBe('succeeded');
    const workerAssigned = result.events.flatMap((event) =>
      event.type === 'agent-assigned' && event.role === 'worker' ? [event.assignment.agentId] : [],
    );
    expect(new Set(workerAssigned)).toEqual(new Set(['codex', 'gemini']));
    expect(workerAssigned).not.toContain('builtin');
    expect(workerAssigned).not.toContain('scripted');
  });

  it('normal mode gives concurrent workers distinct run identities even on one authenticated runtime', async () => {
    const detected = (id: string): DetectedAgent =>
      ({
        id,
        name: id,
        bin: id,
        streamFormat: 'jsonl',
        promptViaStdin: true,
        supportsImagePaths: false,
        supportsCustomModel: true,
        reasoningOptions: [{ id: 'high', label: 'High' }],
        externalMcpInjection: undefined,
        installUrl: undefined,
        docsUrl: undefined,
        available: true,
        path: `/bin/${id}`,
        version: 'test',
        models: [{ id: 'default', label: 'Default' }],
        modelsSource: 'fallback',
        capabilities: {},
        authStatus: 'ok',
        authMessage: undefined,
      }) as DetectedAgent;
    const planner: Planner = {
      plan: (ctx) => {
        const graph = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
        const a = graph.addTask({ title: 'Collect package evidence', role: 'worker', tags: ['implementation'] });
        const b = graph.addTask({ title: 'Collect docs evidence', role: 'worker', tags: ['implementation'] });
        graph.addTask({
          title: 'Review distributed evidence',
          role: 'reviewer',
          dependsOn: [a.id, b.id],
          tags: ['Review'],
        });
        graph.refreshReadiness();
        return graph;
      },
    };
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        yield { type: 'status', label: 'working' };
        if (role === 'reviewer') {
          yield {
            type: 'text_delta',
            delta: JSON.stringify([
              { met: true, note: 'Package evidence was collected.' },
              { met: true, note: 'Docs evidence was collected.' },
            ]),
          };
        } else {
          yield { type: 'text_delta', delta: `${ctx.input.agentId} completed ${ctx.input.metadata?.taskId}` };
          yield { type: 'usage', usage: { totalTokens: 7 } };
        }
      }
      return gen();
    };
    const runtime = createAgentRuntime({ executors: { codex: exec }, now: () => 0 });
    (runtime as any).detect = async () => [detected('codex')];
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      planner,
      policy: createModelPolicy('normal', { ranking: ['codex'] }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      maxConcurrency: 2,
    });

    const result = await orch.start({
      prompt: 'collect independent evidence with multiple workers',
      acceptanceCriteria: ['Package evidence was collected.', 'Docs evidence was collected.'],
      metadata: { supportAgents: false },
    }).result;

    expect(result.status).toBe('succeeded');
    const workerAssignments = result.events.flatMap((event) =>
      event.type === 'agent-assigned' && event.role === 'worker' ? [event as any] : [],
    );
    expect(workerAssignments.map((event) => event.assignment.agentId)).toEqual(['codex', 'codex']);
    expect(new Set(workerAssignments.map((event) => event.agentRunId)).size).toBe(2);
    expect(workerAssignments.map((event) => event.agentLabel)).toEqual(
      expect.arrayContaining([expect.stringContaining('codex#'), expect.stringContaining('codex#')]),
    );
  });

  it('filters review-like tasks from agent planner output because the system adds the reviewer', async () => {
    const detected = (id: string): DetectedAgent =>
      ({
        id,
        name: id,
        bin: id,
        streamFormat: 'jsonl',
        promptViaStdin: true,
        supportsImagePaths: false,
        supportsCustomModel: true,
        reasoningOptions: [{ id: 'high', label: 'High' }],
        externalMcpInjection: undefined,
        installUrl: undefined,
        docsUrl: undefined,
        available: true,
        path: `/bin/${id}`,
        version: 'test',
        models: [{ id: 'default', label: 'Default' }],
        modelsSource: 'fallback',
        capabilities: {},
        authStatus: 'ok',
        authMessage: undefined,
      }) as DetectedAgent;
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        yield { type: 'status', label: 'working' };
        if (role === 'planner') {
          yield {
            type: 'text_delta',
            delta: JSON.stringify({
              acceptanceCriteria: ['Package evidence was collected.'],
              tasks: [
                { title: 'Collect package evidence', description: 'Inspect package.json.', phase: 'Discovery', dependsOn: [] },
                { title: 'Collect docs evidence', description: 'Inspect README.md.', phase: 'Discovery', dependsOn: [] },
                {
                  title: 'Review normal-mode smoke evidence',
                  description: 'Use a reviewer task to verify that both worker results contain the required evidence markers.',
                  phase: 'Verification',
                  dependsOn: [0, 1],
                },
              ],
            }),
          };
        } else if (role === 'reviewer') {
          yield { type: 'text_delta', delta: JSON.stringify([{ met: true, note: 'Package evidence was collected.' }]) };
        } else {
          yield { type: 'text_delta', delta: 'Package evidence was collected.' };
        }
      }
      return gen();
    };
    const runtime = createAgentRuntime({ executors: { codex: exec }, now: () => 0 });
    (runtime as any).detect = async () => [detected('codex')];
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      policy: createModelPolicy('normal', { ranking: ['codex'] }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      maxConcurrency: 2,
    });

    const result = await orch.start({
      prompt: 'collect package and docs evidence, then review',
      metadata: { supportAgents: false },
    }).result;

    expect(result.status).toBe('succeeded');
    const workerTitles = result.plan.tasks.filter((task) => task.role === 'worker').map((task) => task.title);
    expect(workerTitles).toEqual(['Collect package evidence', 'Collect docs evidence']);
    expect(result.plan.tasks.filter((task) => task.role === 'reviewer')).toHaveLength(1);
  });

  it('keeps worker tasks that use verify language without reviewer intent', async () => {
    const detected = (id: string): DetectedAgent =>
      ({
        id,
        name: id,
        bin: id,
        streamFormat: 'jsonl',
        promptViaStdin: true,
        supportsImagePaths: false,
        supportsCustomModel: true,
        reasoningOptions: [{ id: 'high', label: 'High' }],
        externalMcpInjection: undefined,
        installUrl: undefined,
        docsUrl: undefined,
        available: true,
        path: `/bin/${id}`,
        version: 'test',
        models: [{ id: 'default', label: 'Default' }],
        modelsSource: 'fallback',
        capabilities: {},
        authStatus: 'ok',
        authMessage: undefined,
      }) as DetectedAgent;
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        if (role === 'planner') {
          yield {
            type: 'text_delta',
            delta: JSON.stringify({
              acceptanceCriteria: ['Package evidence marker was emitted.'],
              tasks: [
                {
                  title: 'Verify package evidence marker',
                  description: 'Inspect package.json and emit the exact package evidence marker.',
                  phase: 'Discovery',
                  dependsOn: [],
                },
              ],
            }),
          };
        } else if (role === 'reviewer') {
          yield { type: 'text_delta', delta: JSON.stringify([{ met: true, note: 'Package evidence marker was emitted.' }]) };
        } else {
          yield { type: 'text_delta', delta: 'Package evidence marker was emitted.' };
        }
      }
      return gen();
    };
    const runtime = createAgentRuntime({ executors: { codex: exec }, now: () => 0 });
    (runtime as any).detect = async () => [detected('codex')];
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      policy: createModelPolicy('normal', { ranking: ['codex'] }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      maxConcurrency: 2,
    });

    const result = await orch.start({
      prompt: 'verify package evidence marker',
      metadata: { supportAgents: false },
    }).result;

    expect(result.status).toBe('succeeded');
    expect(result.plan.tasks.filter((task) => task.role === 'worker').map((task) => task.title)).toEqual([
      'Verify package evidence marker',
    ]);
    expect(result.plan.tasks.filter((task) => task.role === 'reviewer')).toHaveLength(1);
  });

  it('filters planner-generated process criteria that belong to the harness, not completion', async () => {
    const detected = (id: string): DetectedAgent =>
      ({
        id,
        name: id,
        bin: id,
        streamFormat: 'jsonl',
        promptViaStdin: true,
        supportsImagePaths: false,
        supportsCustomModel: true,
        reasoningOptions: [{ id: 'high', label: 'High' }],
        externalMcpInjection: undefined,
        installUrl: undefined,
        docsUrl: undefined,
        available: true,
        path: `/bin/${id}`,
        version: 'test',
        models: [{ id: 'default', label: 'Default' }],
        modelsSource: 'fallback',
        capabilities: {},
        authStatus: 'ok',
        authMessage: undefined,
      }) as DetectedAgent;
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        if (role === 'planner') {
          yield {
            type: 'text_delta',
            delta: JSON.stringify({
              acceptanceCriteria: [
                'The normal-mode user-facing task graph contains exactly two dependency-free worker tasks.',
                'Worker execution uses real normal-mode agent distribution with no offline, builtin, or scripted-agent fallback.',
                'Package evidence was collected.',
              ],
              tasks: [{ title: 'Collect package evidence', description: 'Inspect package.json.', phase: 'Discovery', dependsOn: [] }],
            }),
          };
        } else if (role === 'reviewer') {
          yield { type: 'text_delta', delta: JSON.stringify([{ met: true, note: 'Package evidence was collected.' }]) };
        } else {
          yield { type: 'text_delta', delta: 'Package evidence was collected.' };
        }
      }
      return gen();
    };
    const runtime = createAgentRuntime({ executors: { codex: exec }, now: () => 0 });
    (runtime as any).detect = async () => [detected('codex')];
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      policy: createModelPolicy('normal', { ranking: ['codex'] }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const result = await orch.start({ prompt: 'collect package evidence', metadata: { supportAgents: false } }).result;

    expect(result.status).toBe('succeeded');
    expect(result.acceptance.criteria.map((criterion) => criterion.title)).toEqual(['Package evidence was collected.']);
  });

  it('gives reviewers full worker output excerpts instead of truncated summaries', async () => {
    const detected = (id: string): DetectedAgent =>
      ({
        id,
        name: id,
        bin: id,
        streamFormat: 'jsonl',
        promptViaStdin: true,
        supportsImagePaths: false,
        supportsCustomModel: true,
        reasoningOptions: [{ id: 'high', label: 'High' }],
        externalMcpInjection: undefined,
        installUrl: undefined,
        docsUrl: undefined,
        available: true,
        path: `/bin/${id}`,
        version: 'test',
        models: [{ id: 'default', label: 'Default' }],
        modelsSource: 'fallback',
        capabilities: {},
        authStatus: 'ok',
        authMessage: undefined,
      }) as DetectedAgent;
    let reviewerPrompt = '';
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        if (role === 'reviewer') {
          reviewerPrompt = ctx.input.prompt;
          yield { type: 'text_delta', delta: 'APPROVE: full evidence visible' };
        } else {
          yield { type: 'text_delta', delta: `${'x'.repeat(600)} NO_EDIT_EVIDENCE no nested omakase commands` };
        }
      }
      return gen();
    };
    const runtime = createAgentRuntime({ executors: { codex: exec }, now: () => 0 });
    (runtime as any).detect = async () => [detected('codex')];
    const planner: Planner = {
      plan: (ctx) => {
        const graph = new PlanGraph({ idGenerator: ctx.idGenerator!, clock: ctx.clock! });
        const worker = graph.addTask({ title: 'Collect long evidence', role: 'worker', tags: ['Discovery'] });
        graph.addTask({ title: 'Review evidence', role: 'reviewer', dependsOn: [worker.id], tags: ['Review'] });
        graph.refreshReadiness();
        return graph;
      },
    };
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      planner,
      policy: createModelPolicy('normal', { ranking: ['codex'] }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    await orch.start({ prompt: 'review long worker evidence', metadata: { supportAgents: false } }).result;

    expect(reviewerPrompt).toContain('NO_EDIT_EVIDENCE');
    expect(reviewerPrompt).toContain('no nested omakase commands');
  });

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
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'strategy-updated',
        failedCriteria: ['tests pass'],
        nextAction: 'replan',
        reason: 'criteria-failed',
      }),
    );
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

    const result = await orch.start({
      prompt: '- build feature',
      acceptanceCriteria: ['ok'],
    }).result;
    const record = await store.load(result.id);

    expect(record?.acceptance?.criteria[0]?.title).toBe('ok');
    expect(record?.acceptance?.progress.complete).toBe(true);
    expect(record?.iterations?.length).toBeGreaterThan(0);
  });

  it('uses acceptance criteria generated by the planner agent', async () => {
    const roleCalls: string[] = [];
    const exec = createScriptedAgent((input) => {
      const role = String(input.metadata?.role ?? 'worker');
      roleCalls.push(role);
      if (role === 'planner') {
        return [
          {
            type: 'text_delta',
            delta: JSON.stringify({
              acceptanceCriteria: [
                'Planner criterion: UI updates live',
                'Planner criterion: reviewer verifies evidence',
                'Reviewer approval is given only when both required evidence markers are present.',
              ],
              tasks: [
                {
                  title: 'Implement live UI updates',
                  description: 'Make the UI reflect real run state.',
                  phase: 'TUI',
                  dependsOn: [],
                },
                {
                  title: 'Reporter Sidecar Synthesis',
                  description: 'Out-of-main-graph reporter task. Summarize progress without gating approval.',
                  phase: 'Docs',
                  dependsOn: [],
                },
                {
                  title: 'Wiki Curator Sidecar Synthesis',
                  description: 'Out-of-main-graph wiki curator task. Update durable project knowledge outside the main graph.',
                  phase: 'Docs',
                  dependsOn: [],
                },
              ],
            }),
          },
        ];
      }
      if (role === 'reviewer') {
        return [
          {
            type: 'text_delta',
            delta: JSON.stringify([
              { met: true, note: 'UI updates live' },
              { met: true, note: 'review evidence exists' },
            ]),
          },
        ];
      }
      return [{ type: 'text_delta', delta: 'worker done' }];
    });
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const result = await orch.start({ prompt: 'make the TUI trustworthy' }).result;

    expect(roleCalls).toContain('planner');
    expect(result.acceptance.criteria.map((criterion) => criterion.title)).toEqual([
      'Planner criterion: UI updates live',
      'Planner criterion: reviewer verifies evidence',
    ]);
    expect(result.plan.tasks.map((task) => task.title)).not.toEqual(
      expect.arrayContaining(['Reporter Sidecar Synthesis', 'Wiki Curator Sidecar Synthesis']),
    );
    expect(result.acceptance.progress).toEqual({ passed: 2, total: 2, complete: true });
    expect(result.events.some((event) => event.type === 'acceptance-updated' && event.acceptance.progress.total === 2)).toBe(true);
  });

  it('creates planning and review reports without mutating the task graph', async () => {
    const orch = orchForReview([[{ met: true, note: 'ok' }]]);
    const result = await orch.start({
      prompt: '- build feature',
      acceptanceCriteria: ['ok'],
      metadata: { supportAgents: true },
    }).result;

    expect(result.reports.map((report) => report.kind)).toEqual(expect.arrayContaining(['planning', 'review']));
    expect(result.events.some((event) => event.type === 'report-created')).toBe(true);
    expect(result.events.some((event) => event.type === 'knowledge-event-created')).toBe(true);
    expect(result.plan.tasks.every((task) => task.role !== ('reporter' as any))).toBe(true);
    expect(result.acceptance.progress.complete).toBe(true);
  });

  it('uses out-of-band reporter and wiki-curator agents without adding them to the plan', async () => {
    const roleCalls: string[] = [];
    const exec = createScriptedAgent((input) => {
      const role = String(input.metadata?.role ?? 'worker');
      roleCalls.push(role);
      if (role === 'reviewer') return [{ type: 'text_delta', delta: JSON.stringify([{ met: true, note: 'ok' }]) }];
      if (role === 'reporter') {
        return [{ type: 'text_delta', delta: '# Agent Report\n\nReporter-authored milestone with risks and next actions.' }];
      }
      if (role === 'wiki-curator') {
        return [{ type: 'text_delta', delta: 'Agent-authored project wiki: stable facts, decisions, risks, and next useful checks.' }];
      }
      return [{ type: 'text_delta', delta: 'worker done' }];
    });
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const result = await orch.start({
      prompt: '- build feature',
      acceptanceCriteria: ['ok'],
      metadata: { supportAgents: true },
    }).result;
    const eventRoles = result.events
      .filter((event) => event.type === 'agent-event')
      .map((event) => (event as any).role);

    expect(roleCalls).toEqual(expect.arrayContaining(['reporter', 'wiki-curator']));
    expect(eventRoles).toEqual(expect.arrayContaining(['reporter', 'wiki-curator']));
    expect(result.plan.tasks.map((task) => task.role)).not.toContain('reporter' as any);
    expect(result.plan.tasks.map((task) => task.role)).not.toContain('wiki-curator' as any);
    expect(result.reports[0]).toMatchObject({
      authorAgentId: 'scripted',
      markdown: expect.stringContaining('Reporter-authored milestone'),
    });
    expect(result.knowledgeEvents.some((event) => event.kind === 'synthesis')).toBe(true);
    expect(result.knowledgeEvents.some((event) => event.body.includes('Agent-authored project wiki'))).toBe(true);
  });

  it('does not let planning support agents block the first worker dispatch', async () => {
    let reporterStarted!: () => void;
    let releaseReporter!: () => void;
    let workerStarted!: () => void;
    const reporterStartedP = new Promise<void>((resolve) => (reporterStarted = resolve));
    const releaseReporterP = new Promise<void>((resolve) => (releaseReporter = resolve));
    const workerStartedP = new Promise<void>((resolve) => (workerStarted = resolve));
    const roleCalls: string[] = [];
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        roleCalls.push(role);
        if (role === 'reporter') {
          reporterStarted();
          await releaseReporterP;
          yield { type: 'text_delta', delta: '# Planning report\n\nReporter output.' };
          return;
        }
        if (role === 'wiki-curator') {
          yield { type: 'text_delta', delta: 'Wiki output.' };
          return;
        }
        workerStarted();
        yield { type: 'text_delta', delta: 'worker done' };
      }
      return gen();
    };
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: { route: () => ({ kind: 'simple', reason: 'test', confidence: 1, signals: [], suggestedRole: 'worker' }) },
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const handle = orch.start({ prompt: 'complete the main worker', metadata: { supportAgents: true } });
    await reporterStartedP;
    const workerStartedBeforeReporterReleased = await Promise.race([
      workerStartedP.then(() => true),
      delay(100).then(() => false),
    ]);
    releaseReporter();
    const result = await handle.result;

    expect(result.status).toBe('succeeded');
    expect(roleCalls).toContain('worker');
    expect(workerStartedBeforeReporterReleased).toBe(true);
  });

  it('emits terminal status before final wiki-curator support work finishes', async () => {
    let releaseFinalWiki!: () => void;
    let finalWikiStarted!: () => void;
    const releaseFinalWikiP = new Promise<void>((resolve) => (releaseFinalWiki = resolve));
    const finalWikiStartedP = new Promise<void>((resolve) => (finalWikiStarted = resolve));
    let wikiCalls = 0;
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        if (role === 'reporter') {
          yield { type: 'text_delta', delta: '# Planning report\n\nReporter output.' };
          return;
        }
        if (role === 'wiki-curator') {
          wikiCalls += 1;
          if (wikiCalls >= 2) {
            finalWikiStarted();
            await releaseFinalWikiP;
          }
          yield { type: 'text_delta', delta: 'Wiki output.' };
          return;
        }
        yield { type: 'text_delta', delta: 'worker done' };
      }
      return gen();
    };
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: { route: () => ({ kind: 'simple', reason: 'test', confidence: 1, signals: [], suggestedRole: 'worker' }) },
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const handle = orch.start({ prompt: 'complete the main worker', metadata: { supportAgents: true } });
    const sawRunFinishedP = (async () => {
      for await (const event of handle.events) {
        if (event.type === 'run-finished') return true;
      }
      return false;
    })();

    const finalWikiStartedBeforeTimeout = await Promise.race([
      finalWikiStartedP.then(() => true),
      delay(500).then(() => false),
    ]);
    const finishedBeforeFinalWikiReleased = await Promise.race([
      sawRunFinishedP,
      delay(100).then(() => false),
    ]);
    releaseFinalWiki();
    const result = await handle.result;

    expect(result.status).toBe('succeeded');
    expect(finalWikiStartedBeforeTimeout).toBe(true);
    expect(finishedBeforeFinalWikiReleased).toBe(true);
  });
});
