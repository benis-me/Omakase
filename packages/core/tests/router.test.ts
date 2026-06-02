import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '@omakase/daemon';
import { RuleRouter, createAgentRouter, parseRouteText } from '../src/router/router.js';

function result(text: string, status: AgentRunResult['status'] = 'completed'): AgentRunResult {
  return { text, thinking: '', toolCalls: [], usage: null, costUsd: null, status, error: null, model: null };
}

describe('RuleRouter', () => {
  const router = new RuleRouter();

  it('routes short lookups as simple', () => {
    expect(router.route({ prompt: 'summarize this project' }).kind).toBe('simple');
    expect(router.route({ prompt: 'what does the parser do?' }).kind).toBe('simple');
    expect(router.route({ prompt: 'fix a typo in the README' }).kind).toBe('simple');
  });

  it('routes multi-step build requests as complex', () => {
    const decision = router.route({
      prompt:
        'Build a REST API with auth, then add a database layer, write tests for every endpoint, and refactor the router across the codebase.',
    });
    expect(decision.kind).toBe('complex');
    expect(decision.signals.length).toBeGreaterThan(0);
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it('routes bulleted lists as complex', () => {
    const decision = router.route({
      prompt: ['Please do:', '- set up the project', '- add a CLI', '- write docs'].join('\n'),
    });
    expect(decision.kind).toBe('complex');
  });

  it('honours a custom threshold', () => {
    const strict = new RuleRouter({ complexityThreshold: 99 });
    expect(strict.route({ prompt: 'build and implement and refactor everything' }).kind).toBe('simple');
  });
});

describe('parseRouteText', () => {
  it('extracts the classification', () => {
    expect(parseRouteText('COMPLEX')).toBe('complex');
    expect(parseRouteText('This looks SIMPLE to me')).toBe('simple');
    expect(parseRouteText('nothing here')).toBeNull();
  });
});

describe('createAgentRouter', () => {
  it('uses the agent classification when parseable', async () => {
    const router = createAgentRouter({ runAgent: async () => result('COMPLEX') }, { agentId: 'x' });
    const decision = await router.route({ prompt: 'do a thing' });
    expect(decision.kind).toBe('complex');
    expect(decision.signals).toContain('agent:x');
  });

  it('falls back to the rule router on unparseable output', async () => {
    const router = createAgentRouter({ runAgent: async () => result('uhh not sure') }, { agentId: 'x' });
    const decision = await router.route({ prompt: 'summarize this project' });
    expect(decision.kind).toBe('simple');
  });
});
