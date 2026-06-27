import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { createModelPolicy } from '../src/modes/policy.js';
import type { Router } from '../src/router/router.js';

const simpleRouter: Router = {
  route: () => ({ kind: 'simple', reason: 'simple', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

describe('orchestrator validation gate', () => {
  it('rejects, injects fix-tasks, re-loops, then passes', async () => {
    let validatorCalls = 0;
    const exec = createScriptedAgent((input) => {
      const role = String(input.metadata?.role ?? 'worker');
      if (role === 'validator') {
        validatorCalls += 1;
        const verdict =
          validatorCalls === 1
            ? { passed: false, gaps: ['add tests'], notes: 'no tests yet' }
            : { passed: true, gaps: [], notes: 'looks complete' };
        return [{ type: 'text_delta', delta: JSON.stringify(verdict) }];
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });

    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      validate: true,
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    // supportAgents:true lets the scripted validator actually run (support agents
    // are otherwise skipped for builtin/scripted agents).
    const handle = orch.start({ prompt: 'build a thing', metadata: { supportAgents: true } });
    const result = await handle.result;

    expect(result.status).toBe('succeeded');
    expect(validatorCalls).toBe(2);
    expect(result.plan.tasks.some((t) => t.tags.includes('validator-fix'))).toBe(true);
    expect(
      result.events.some(
        (e) => e.type === 'replanned' && (e as { reason?: string }).reason === 'validation-rejected',
      ),
    ).toBe(true);
  });

  it('is a no-op when validation is disabled', async () => {
    let validatorCalls = 0;
    const exec = createScriptedAgent((input) => {
      if (String(input.metadata?.role) === 'validator') validatorCalls += 1;
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });
    const result = await orch.start({ prompt: 'build', metadata: { supportAgents: true } }).result;
    expect(result.status).toBe('succeeded');
    expect(validatorCalls).toBe(0);
  });

  it('runs a closed-loop verifier as a hard gate: fail → fix → pass', async () => {
    let verifyCalls = 0;
    const exec = createScriptedAgent(() => [{ type: 'text_delta', delta: 'done' }]);
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      // First check fails (tests red), second passes — an objective gate, no LLM.
      verifier: async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { passed: false, summary: '2 tests failing' }
          : { passed: true, summary: 'all green' };
      },
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const result = await orch.start({ prompt: 'build a thing' }).result;

    expect(result.status).toBe('succeeded');
    expect(verifyCalls).toBe(2);
    expect(result.plan.tasks.some((t) => t.tags.includes('verify-fix'))).toBe(true);
  });

  it('marks the run incomplete (not succeeded) when verification never passes', async () => {
    let verifyCalls = 0;
    const exec = createScriptedAgent(() => [{ type: 'text_delta', delta: 'done' }]);
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      verifier: async () => {
        verifyCalls += 1;
        return { passed: false, summary: 'still red' };
      },
      maxValidationRounds: 2,
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const result = await orch.start({ prompt: 'build a thing' }).result;

    // Tasks all ran, but the objective check never went green — not a true success.
    expect(result.status).toBe('incomplete');
    expect(verifyCalls).toBe(2); // bounded by maxValidationRounds
  });
});

describe('agent capability briefing (autonomous .omks authoring)', () => {
  function makeOrch(prompts: string[]) {
    const exec = createScriptedAgent((input) => {
      prompts.push(String(input.prompt));
      return [{ type: 'text_delta', delta: 'done' }];
    });
    return new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });
  }

  it('tells agents they can author specs / commands / workflows / automations when a cwd is set', async () => {
    const prompts: string[] = [];
    await makeOrch(prompts).start({ prompt: 'do a thing', cwd: '/tmp/omks-cap' }).result;
    const briefed = prompts.find((p) => p.includes('.omks/specs/'));
    expect(briefed).toBeDefined();
    expect(briefed).toContain('.omks/commands/');
    expect(briefed).toContain('.omks/workflows/');
    expect(briefed).toContain('.omks/triggers.json');
  });

  it('omits the authoring briefing when there is no cwd', async () => {
    const prompts: string[] = [];
    await makeOrch(prompts).start({ prompt: 'do a thing' }).result;
    expect(prompts.some((p) => p.includes('.omks/specs/'))).toBe(false);
  });
});
