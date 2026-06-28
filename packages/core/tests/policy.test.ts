import { describe, expect, it } from 'vitest';
import type { DetectedAgent, RuntimeModelOption } from '@omakase/daemon';
import { createModelPolicy } from '../src/modes/policy.js';

function agent(
  id: string,
  opts: {
    available?: boolean;
    authStatus?: DetectedAgent['authStatus'];
    models?: RuntimeModelOption[];
    reasoning?: RuntimeModelOption[];
  } = {},
): DetectedAgent {
  return {
    id,
    name: id,
    bin: id,
    streamFormat: 'plain-text',
    promptViaStdin: true,
    supportsImagePaths: false,
    supportsCustomModel: true,
    reasoningOptions: opts.reasoning ?? [],
    externalMcpInjection: undefined,
    installUrl: undefined,
    docsUrl: undefined,
    available: opts.available ?? true,
    path: '/bin/' + id,
    version: '1.0',
    models: opts.models ?? [{ id: 'default', label: 'Default' }],
    modelsSource: 'fallback',
    capabilities: {},
    authStatus: opts.authStatus ?? 'ok',
    authMessage: undefined,
  };
}

const claude = agent('claude', {
  models: [
    { id: 'default', label: 'Default' },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' },
  ],
  reasoning: [
    { id: 'default', label: 'Default' },
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'XHigh' },
  ],
});
const gemini = agent('gemini');

describe('createModelPolicy', () => {
  it('max-power picks the strongest available agent at peak reasoning', () => {
    const policy = createModelPolicy('max-power');
    const a = policy.select('worker', { available: [gemini, claude] });
    expect(a.agentId).toBe('claude');
    expect(a.model).toBe('opus');
    expect(a.reasoning).toBe('xhigh');
  });

  it('normal varies reasoning by role and prefers a cheap model for routing', () => {
    const policy = createModelPolicy('normal');
    const router = policy.select('router', { available: [claude] });
    expect(router.agentId).toBe('claude');
    expect(router.model).toBe('haiku');
    expect(router.reasoning).toBe('low');

    const planner = policy.select('planner', { available: [claude] });
    expect(planner.reasoning).toBe('high');

    const worker = policy.select('worker', { available: [claude] });
    expect(worker.reasoning).toBeNull();
  });

  it('normal distributes worker tasks across available agents by task id', () => {
    const policy = createModelPolicy('normal');
    const first = policy.select('worker', { available: [claude, agent('codex'), gemini], taskId: 'task-1' });
    const second = policy.select('worker', { available: [claude, agent('codex'), gemini], taskId: 'task-2' });
    const third = policy.select('worker', { available: [claude, agent('codex'), gemini], taskId: 'task-3' });

    expect([first.agentId, second.agentId, third.agentId]).toEqual(['claude', 'codex', 'gemini']);
  });

  it('does not select an installed agent whose auth is missing', () => {
    const policy = createModelPolicy('normal');
    const selected = policy.select('worker', {
      available: [agent('claude', { authStatus: 'missing' }), agent('codex')],
      taskId: 'task-1',
    });

    expect(selected.agentId).toBe('codex');
  });

  it('falls back to the builtin agent when nothing is installed', () => {
    const policy = createModelPolicy('max-power');
    const a = policy.select('worker', { available: [agent('claude', { available: false })] });
    expect(a.agentId).toBe('builtin');
  });

  it('custom mode honours the configured role assignments', () => {
    const policy = createModelPolicy('custom', {
      custom: {
        roles: {
          worker: { agentId: 'codex', model: 'gpt-5', reasoning: 'high' },
        },
        default: { agentId: 'gemini' },
      },
    });
    const worker = policy.select('worker', { available: [] });
    expect(worker).toMatchObject({ agentId: 'codex', model: 'gpt-5', reasoning: 'high' });
    // No explicit reviewer config → falls back to the default assignment.
    const reviewer = policy.select('reviewer', { available: [] });
    expect(reviewer.agentId).toBe('gemini');
  });
});

describe('select with exclude (reassignment / 改派)', () => {
  it('routes a worker away from an excluded agent', () => {
    const policy = createModelPolicy('normal');
    const available = [agent('codex'), agent('gemini')];
    const first = policy.select('worker', { available });
    const second = policy.select('worker', { available, exclude: [first.agentId] });
    expect(second.agentId).not.toBe(first.agentId);
    expect(available.some((a) => a.id === second.agentId)).toBe(true);
  });

  it('falls back to the built-in agent when every available agent is excluded', () => {
    const policy = createModelPolicy('normal');
    const available = [agent('codex'), agent('gemini')];
    const result = policy.select('worker', { available, exclude: ['codex', 'gemini'] });
    expect(result.rationale).toContain('built-in');
  });
});

describe('agent health — prefer live-probed over fallback-models agents', () => {
  it('routes to the live agent and drops the fallback one when both are present', () => {
    const policy = createModelPolicy('normal');
    const live = { ...agent('codex'), modelsSource: 'live' as const };
    const fallback = { ...agent('gemini'), modelsSource: 'fallback' as const };
    // Distribute several worker tasks — none should land on the fallback (likely-broken) agent.
    for (const taskId of ['t1', 't2', 't3', 't4']) {
      expect(policy.select('worker', { available: [live, fallback], taskId }).agentId).toBe('codex');
    }
  });

  it('still uses a fallback agent when no live agent is available', () => {
    const policy = createModelPolicy('normal');
    const fallback = { ...agent('gemini'), modelsSource: 'fallback' as const };
    expect(policy.select('worker', { available: [fallback] }).agentId).toBe('gemini');
  });
});
