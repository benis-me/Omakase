import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { Orchestrator, parseStructuredReview } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { createModelPolicy } from '../src/modes/policy.js';
import { SpecWorkflow } from '../src/workflows/spec.js';
import type { Router } from '../src/router/router.js';
import type { OrchestratorEvent } from '../src/run-events.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

describe('parseStructuredReview', () => {
  it('marks each criterion from a JSON verdict and approves only when all met', () => {
    const criteria = ['parses input', 'has tests'];
    const rejected = parseStructuredReview(
      JSON.stringify([{ met: true }, { met: false, note: 'no tests' }]),
      criteria,
    );
    expect(rejected.approved).toBe(false);
    expect(rejected.criteria).toEqual([
      { criterion: 'parses input', met: true },
      { criterion: 'has tests', met: false, note: 'no tests' },
    ]);

    const approved = parseStructuredReview(JSON.stringify([{ met: true }, { met: true }]), criteria);
    expect(approved.approved).toBe(true);
  });

  it('falls back to overall verdict when the JSON is unparseable', () => {
    const r = parseStructuredReview('REJECT — not done', ['a', 'b']);
    expect(r.approved).toBe(false);
    expect(r.criteria.every((c) => c.met === false)).toBe(true);
  });

  it('accepts a JSON object wrapper with reviewer-requested reports', () => {
    const review = parseStructuredReview(
      JSON.stringify({
        criteria: [{ met: true, note: 'verified' }],
        reportRequests: [
          {
            title: 'Reviewer checkpoint',
            reason: 'post-review-checkpoint',
            summary: 'Reviewer wants a separate status report after verification.',
          },
        ],
      }),
      ['feature works'],
    );

    expect(review.approved).toBe(true);
    expect(review.criteria).toEqual([{ criterion: 'feature works', met: true, note: 'verified' }]);
    expect(review.reportRequests).toEqual([
      {
        title: 'Reviewer checkpoint',
        reason: 'post-review-checkpoint',
        summary: 'Reviewer wants a separate status report after verification.',
      },
    ]);
  });
});

describe('orchestrator structured review against SpecWorkflow criteria', () => {
  it('rejects per-criterion, replans, then approves when all criteria are met', async () => {
    // Derive acceptance criteria from a spec workflow.
    const spec = new SpecWorkflow('build a parser', { clock: () => 0 });
    spec.advance(); // idea → spec
    spec.setSpec('a CSV parser').advance(); // spec → acceptance
    spec.addAcceptanceCriterion('parses valid input');
    spec.addAcceptanceCriterion('has unit tests');
    const acceptanceCriteria = spec.snapshot().acceptanceCriteria;

    let reviews = 0;
    const exec = createScriptedAgent((input) => {
      if (String(input.metadata?.role) === 'reviewer') {
        reviews += 1;
        const verdict =
          reviews === 1
            ? [{ met: true }, { met: false, note: 'no tests yet' }]
            : [{ met: true }, { met: true }];
        return [{ type: 'text_delta', delta: JSON.stringify(verdict) }];
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
    const orch = new Orchestrator({
      runtime,
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const result = await orch.start({ prompt: 'build a parser', acceptanceCriteria }).result;
    const reviewEvents = result.events.filter(
      (e): e is Extract<OrchestratorEvent, { type: 'review' }> => e.type === 'review',
    );
    expect(reviewEvents).toHaveLength(2);
    expect(reviewEvents[0]?.approved).toBe(false);
    expect(reviewEvents[0]?.criteria).toHaveLength(2);
    expect(reviewEvents[0]?.criteria?.find((c) => !c.met)?.criterion).toBe('has unit tests');
    expect(reviewEvents.at(-1)?.approved).toBe(true);
    expect(result.status).toBe('succeeded');
  });
});
