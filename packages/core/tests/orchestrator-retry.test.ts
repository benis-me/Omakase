import { describe, expect, it } from 'vitest';
import {
  collectAgentResult,
  createAgentRuntime,
  createNodeTransport,
  createScriptedAgent,
  type AgentEvent,
  type AgentRuntime,
  type AgentRunInput,
  type DetectedAgent,
} from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { createModelPolicy } from '../src/modes/policy.js';
import type { Router } from '../src/router/router.js';

const simpleRouter: Router = {
  route: () => ({ kind: 'simple', reason: 'simple', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

function makeOrch(
  exec: ReturnType<typeof createScriptedAgent>,
  store: MemoryRunStore = new MemoryRunStore(),
): Orchestrator {
  return new Orchestrator({
    runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
    router: simpleRouter,
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
    store,
    clock: () => 0,
    detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
  });
}

function detected(id: string): DetectedAgent {
  return {
    id,
    name: id,
    bin: id,
    streamFormat: 'plain-text',
    promptViaStdin: true,
    supportsImagePaths: false,
    supportsCustomModel: true,
    reasoningOptions: [],
    externalMcpInjection: undefined,
    installUrl: undefined,
    docsUrl: undefined,
    available: true,
    path: `/tmp/${id}`,
    version: 'test',
    models: [{ id: 'default', label: 'Default' }],
    modelsSource: 'live',
    capabilities: {},
    authStatus: 'ok',
    authMessage: undefined,
  };
}

function runtimeWithAgents(
  available: DetectedAgent[],
  handler: (input: AgentRunInput) => AgentEvent[],
): AgentRuntime {
  const runtime = {
    registry: createAgentRuntime().registry,
    transport: createNodeTransport(),
    detect: async () => available,
    detectOne: async (id: string) => available.find((a) => a.id === id),
    streamAgentEvents(input: AgentRunInput): AsyncIterable<AgentEvent> {
      async function* stream(): AsyncIterable<AgentEvent> {
        yield* handler(input);
      }
      return stream();
    },
    runAgent(input: AgentRunInput) {
      return collectAgentResult(this.streamAgentEvents(input));
    },
    registerExecutor() {},
    refreshDetection() {},
  } satisfies AgentRuntime;
  return runtime;
}

/** The worker agent-assigned events, in order, with the fields we assert on. */
function workerAssignments(events: { type: string }[]): Array<{ agentRunId?: string; attempts?: number }> {
  return events.filter(
    (e): e is { type: string; role?: string; agentRunId?: string; attempts?: number } =>
      e.type === 'agent-assigned' && (e as { role?: string }).role === 'worker',
  );
}

describe('agent identity across retries (#5)', () => {
  it('reuses ONE agent-run id across a task retry and bumps attempts', async () => {
    let workerCalls = 0;
    const exec = createScriptedAgent((input) => {
      if (String(input.metadata?.role) === 'worker') {
        workerCalls += 1;
        // Transient, non-rate-limit failure on the first attempt → a normal retry.
        return workerCalls === 1
          ? [{ type: 'error', message: 'transient boom' }]
          : [{ type: 'text_delta', delta: 'done' }];
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });

    const result = await makeOrch(exec).start({ prompt: 'build a thing' }).result;

    expect(result.status).toBe('succeeded');
    const assigned = workerAssignments(result.events);
    expect(assigned.length).toBe(2); // two attempts on the SAME task
    expect(assigned[0]?.agentRunId).toBeDefined();
    expect(assigned[0]?.agentRunId).toBe(assigned[1]?.agentRunId); // not a fresh clone
    expect(assigned[1]?.attempts).toBe(2);
  });
});

describe('rate-limit parking (#4)', () => {
  it('parks (incomplete + rateLimitedUntil) instead of burning retries', async () => {
    let workerCalls = 0;
    const exec = createScriptedAgent((input) => {
      if (String(input.metadata?.role) === 'worker') {
        workerCalls += 1;
        return [{ type: 'error', message: 'Claude usage limit reached. Your limit will reset at 1800000000' }];
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });

    const result = await makeOrch(exec).start({ prompt: 'build a thing' }).result;

    expect(result.status).toBe('incomplete'); // resumable, not failed
    expect(result.rateLimitedUntil).toBe(1_800_000_000 * 1000); // parsed from the message
    expect(workerCalls).toBe(1); // attempt refunded — did NOT retry into the wall
  });

  it('routes around a rate-limited pinned agent before parking the run', async () => {
    const calls: string[] = [];
    const runtime = runtimeWithAgents([detected('codex'), detected('claude')], (input) => {
      const role = String(input.metadata?.role);
      if (role === 'worker') calls.push(input.agentId);
      if (role === 'worker' && input.agentId === 'codex') {
        return [
          {
            type: 'error',
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:42 PM.",
          },
        ];
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const orch = new Orchestrator({
      runtime,
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'codex' } } }),
      store: new MemoryRunStore(),
      clock: () => 1_700_000_000_000,
      maxAttemptsPerTask: 3,
    });

    const result = await orch.start({ prompt: 'build a thing' }).result;

    expect(result.status).toBe('succeeded');
    expect(result.rateLimitedUntil).toBeUndefined();
    expect(calls).toEqual(['codex', 'claude']);
  });
});

describe('retry a failed run (#6)', () => {
  it('resets failed tasks to pending and re-runs them to success', async () => {
    let outcome: 'fail' | 'pass' = 'fail';
    let workerCalls = 0;
    const exec = createScriptedAgent((input) => {
      if (String(input.metadata?.role) === 'worker') {
        workerCalls += 1;
        return outcome === 'fail'
          ? [{ type: 'error', message: 'boom' }]
          : [{ type: 'text_delta', delta: 'done' }];
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const store = new MemoryRunStore();
    const orch = makeOrch(exec, store);

    const first = await orch.start({ prompt: 'build a thing' }).result;
    expect(first.status).toBe('failed');
    const callsWhenFailed = workerCalls; // exhausted maxAttempts

    outcome = 'pass';
    const handle = await orch.retry(first.id);
    expect(handle).not.toBeNull();
    const second = await handle!.result;

    expect(second.status).toBe('succeeded');
    expect(workerCalls).toBeGreaterThan(callsWhenFailed); // the failed task actually re-ran
  });

  it('retry() returns null for an unknown run id', async () => {
    expect(await makeOrch(createScriptedAgent(() => [{ type: 'text_delta', delta: 'done' }])).retry('nope')).toBeNull();
  });
});

describe('budget accounting — real incremental tokens', () => {
  it('excludes cached re-reads so codex-style inflation does not trip the budget early', async () => {
    const exec = createScriptedAgent((input) => {
      if (String(input.metadata?.role) === 'worker') {
        return [
          // codex folds re-read context into input/total; only ~4k is new this run.
          { type: 'usage', usage: { inputTokens: 100_000, outputTokens: 2_000, cachedReadTokens: 98_000, totalTokens: 102_000 } },
          { type: 'text_delta', delta: 'done' },
        ];
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });

    const result = await makeOrch(exec).start({ prompt: 'build a thing' }).result;

    expect(result.status).toBe('succeeded');
    expect(result.spentTokens).toBe(4000); // 102000 total − 98000 cached, not the inflated 102000
  });
});
