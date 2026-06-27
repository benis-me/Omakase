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
      validate: true,
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
      validate: true,
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

describe('spec-first nudge (spec-driven development for spec-less runs)', () => {
  const SPEC_FIRST = 'make your FIRST worker task author a spec';
  // The nudge lives in the planner prompt, which only runs for non-simple routes.
  const complexRouter: Router = {
    route: () => ({ kind: 'complex', reason: 'complex', confidence: 1, signals: [], suggestedRole: 'worker' }),
  };
  function makeOrch(prompts: string[]) {
    const exec = createScriptedAgent((input) => {
      prompts.push(String(input.prompt));
      return [{ type: 'text_delta', delta: 'done' }];
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

  it('asks the planner to author a spec first when no spec seeded the run', async () => {
    const prompts: string[] = [];
    await makeOrch(prompts).start({ prompt: 'build a feature', cwd: '/tmp/omks-spec' }).result;
    expect(prompts.some((p) => p.includes(SPEC_FIRST))).toBe(true);
  });

  it('stays silent when a spec already drives the run (acceptance criteria seeded)', async () => {
    const prompts: string[] = [];
    await makeOrch(prompts).start({
      prompt: 'build a feature',
      cwd: '/tmp/omks-spec',
      acceptanceCriteria: ['The feature works end to end'],
    }).result;
    // The capability briefing still appears (cwd is set), but not the spec-first nudge.
    expect(prompts.some((p) => p.includes('.omks/specs/'))).toBe(true);
    expect(prompts.some((p) => p.includes(SPEC_FIRST))).toBe(false);
  });

  it('stays silent when there is no writable workspace', async () => {
    const prompts: string[] = [];
    await makeOrch(prompts).start({ prompt: 'build a feature' }).result;
    expect(prompts.some((p) => p.includes(SPEC_FIRST))).toBe(false);
  });
});

describe('adopting agent-authored spec criteria (closing the verification loop)', () => {
  function makeOrch(opts: {
    validatorText: string;
    provider?: (cwd: string) => string[];
  }) {
    const exec = createScriptedAgent((input) => {
      const p = String(input.prompt);
      if (p.includes('independent VALIDATOR')) return [{ type: 'text_delta', delta: opts.validatorText }];
      return [{ type: 'text_delta', delta: 'done' }];
    });
    return new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      ...(opts.provider ? { authoredSpecCriteria: opts.provider } : {}),
    });
  }

  it('adopts the authored criteria and succeeds when the validator confirms them', async () => {
    const result = await makeOrch({
      validatorText: '{"passed": true, "gaps": [], "notes": "all criteria met"}',
      provider: () => ['slugify lowercases input', 'empty input returns empty string'],
    }).start({ prompt: 'build slugify', cwd: '/tmp/omks-adopt', metadata: { supportAgents: true } }).result;

    expect(result.status).toBe('succeeded');
    const spec = result.acceptance.criteria.filter((c) => c.source === 'spec');
    expect(spec.map((c) => c.title)).toEqual([
      'slugify lowercases input',
      'empty input returns empty string',
    ]);
    // Explicitly verified (marked pass), NOT implicitly passed.
    expect(spec.every((c) => c.status === 'pass')).toBe(true);
  });

  it('does not rubber-stamp: a validator gap keeps the run from a false success', async () => {
    const result = await makeOrch({
      validatorText: '{"passed": false, "gaps": ["empty input is not handled"], "notes": "incomplete"}',
      provider: () => ['empty input returns empty string'],
    }).start({ prompt: 'build slugify', cwd: '/tmp/omks-adopt', metadata: { supportAgents: true } }).result;

    // The worker reported done, but the loop held it to the agent's own spec.
    expect(result.status).not.toBe('succeeded');
    expect(result.plan.tasks.some((t) => t.tags?.includes('validator-fix'))).toBe(true);
  });

  it('still verifies an adopted spec after the worker phase exhausts the budget', async () => {
    // The worker blows a 1-token budget; the validator (budget-exempt support work,
    // like the wiki-curator that already runs post-budget) must still get to verify.
    const exec = createScriptedAgent((input) => {
      const p = String(input.prompt);
      if (p.includes('independent VALIDATOR')) {
        return [{ type: 'text_delta', delta: '{"passed": true, "gaps": []}' }];
      }
      return [
        { type: 'usage', usage: { inputTokens: 50, outputTokens: 50 } },
        { type: 'text_delta', delta: 'done' },
      ];
    });
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      budget: { maxTokens: 1 },
      authoredSpecCriteria: () => ['titleCase capitalizes each word'],
    });
    const result = await orch.start({
      prompt: 'build titlecase',
      cwd: '/tmp/omks-adopt',
      metadata: { supportAgents: true },
    }).result;

    expect(result.status).toBe('succeeded');
    const spec = result.acceptance.criteria.filter((c) => c.source === 'spec');
    expect(spec.length).toBe(1);
    expect(spec[0].status).toBe('pass');
  });

  it('runs the workspace tests (verifier) as the objective gate for an adopted spec', async () => {
    let verifyCalls = 0;
    const exec = createScriptedAgent((input) => {
      if (String(input.prompt).includes('independent VALIDATOR')) {
        return [{ type: 'text_delta', delta: '{"passed": true, "gaps": []}' }];
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      clock: () => 0,
      authoredSpecCriteria: () => ['wordCount handles empty input'],
      // The agent's own tests: red first, green after the fix-loop.
      verifier: async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { passed: false, summary: '1 test failing' }
          : { passed: true, summary: 'all green' };
      },
    });
    const result = await orch.start({ prompt: 'build wordcount', cwd: '/tmp/omks-adopt', metadata: { supportAgents: true } }).result;

    expect(verifyCalls).toBe(2); // ran the tests, failed, fixed, re-ran green
    expect(result.plan.tasks.some((t) => t.tags.includes('verify-fix'))).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.acceptance.criteria.find((c) => c.source === 'spec')?.status).toBe('pass');
  });

  it('leaves the run unchanged when no authored-spec provider is wired', async () => {
    const result = await makeOrch({
      validatorText: '{"passed": true, "gaps": []}',
      // no provider
    }).start({ prompt: 'do a thing', cwd: '/tmp/omks-adopt', metadata: { supportAgents: true } }).result;

    expect(result.status).toBe('succeeded');
    expect(result.acceptance.criteria.some((c) => c.source === 'spec')).toBe(false);
  });
});

describe('command curation (/learn-style, post-run)', () => {
  const CURATION = 'Command curation:';
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

  it('invites the post-run curator to distill a reusable command when cwd is writable', async () => {
    const prompts: string[] = [];
    // supportAgents:true forces the wiki curator to run with the scripted agent.
    await makeOrch(prompts).start({
      prompt: 'do a thing',
      cwd: '/tmp/omks-cmd',
      metadata: { supportAgents: true },
    }).result;
    const curator = prompts.find((p) => p.includes('Omakase Wiki Curator'));
    expect(curator).toBeDefined();
    expect(curator).toContain(CURATION);
  });

  it('omits command curation when there is no writable workspace', async () => {
    const prompts: string[] = [];
    await makeOrch(prompts).start({
      prompt: 'do a thing',
      metadata: { supportAgents: true },
    }).result;
    const curator = prompts.find((p) => p.includes('Omakase Wiki Curator'));
    expect(curator).toBeDefined();
    expect(curator).not.toContain(CURATION);
  });
});
