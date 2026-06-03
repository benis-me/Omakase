import { describe, expect, it } from 'vitest';
import type { AgentRunResult, SkillInfo } from '@omakase/daemon';
import {
  RulePlanner,
  createAgentPlanner,
  extractJsonArray,
  splitGoals,
} from '../src/plan/planner.js';
import { createIdGenerator } from '../src/ids.js';

function result(text: string): AgentRunResult {
  return { text, thinking: '', toolCalls: [], usage: null, costUsd: null, status: 'completed', error: null, model: null };
}

describe('splitGoals', () => {
  it('splits bulleted lists', () => {
    expect(splitGoals('- one\n- two\n- three')).toEqual(['one', 'two', 'three']);
  });
  it('splits on connectors', () => {
    expect(splitGoals('build the API and then write tests')).toEqual([
      'build the API',
      'write tests',
    ]);
  });
  it('keeps a single goal when there is no split', () => {
    expect(splitGoals('summarize the project')).toEqual(['summarize the project']);
  });
});

describe('RulePlanner', () => {
  it('produces worker tasks gated by a review task', () => {
    const planner = new RulePlanner();
    const graph = planner.plan({
      request: { prompt: '- add a parser\n- add a CLI\n- write docs' },
      idGenerator: createIdGenerator(),
      clock: () => 0,
    });
    const tasks = graph.tasks();
    const workers = tasks.filter((t) => t.role === 'worker');
    const reviewers = tasks.filter((t) => t.role === 'reviewer');
    expect(workers).toHaveLength(3);
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]?.dependsOn).toEqual(workers.map((w) => w.id));
    // Workers are immediately ready; the reviewer waits.
    expect(graph.readyTasks().every((t) => t.role === 'worker')).toBe(true);
  });
});

describe('extractJsonArray', () => {
  it('extracts a balanced array from noisy text', () => {
    const arr = extractJsonArray('Here is the plan: [{"title":"a"},{"title":"b"}] done');
    expect(arr).toEqual([{ title: 'a' }, { title: 'b' }]);
  });
  it('returns null when there is no array', () => {
    expect(extractJsonArray('no json here')).toBeNull();
  });
});

describe('createAgentPlanner', () => {
  it('builds a graph from the agent JSON plan with dependency wiring', async () => {
    const planner = createAgentPlanner(
      {
        runAgent: async () =>
          result(
            JSON.stringify([
              { title: 'scaffold', description: 'set up' },
              { title: 'implement', description: 'do it', dependsOn: [0] },
            ]),
          ),
      },
      { agentId: 'planner-agent' },
    );
    const graph = await planner.plan({
      request: { prompt: 'build a thing' },
      idGenerator: createIdGenerator(),
      clock: () => 0,
    });
    const workers = graph.tasks().filter((t) => t.role === 'worker');
    expect(workers.map((w) => w.title)).toEqual(['scaffold', 'implement']);
    expect(workers[1]?.dependsOn).toEqual([workers[0]?.id]);
  });

  it('falls back to the rule planner when the agent output is unusable', async () => {
    const planner = createAgentPlanner({ runAgent: async () => result('no plan') }, { agentId: 'x' });
    const graph = await planner.plan({
      request: { prompt: 'implement the cache layer and then document it' },
      idGenerator: createIdGenerator(),
      clock: () => 0,
    });
    expect(graph.tasks().filter((t) => t.role === 'worker')).toHaveLength(2);
  });

  it('injects planner-role skills into the agent prompt', async () => {
    const skill: SkillInfo = {
      id: 'tdd',
      name: 'tdd',
      description: 'red-green-refactor',
      body: 'Always write a failing test first.',
      triggers: [],
      roles: ['planner'],
      source: 'builtin',
      root: '/x',
      dir: '/x/tdd',
      frontmatter: {},
    };
    let captured = '';
    const planner = createAgentPlanner(
      {
        runAgent: async (input) => {
          captured = input.prompt;
          return result(JSON.stringify([{ title: 'a', description: 'b' }]));
        },
      },
      { agentId: 'planner-agent' },
    );
    await planner.plan({
      request: { prompt: 'build a thing' },
      idGenerator: createIdGenerator(),
      clock: () => 0,
      skills: [skill],
    });
    expect(captured).toContain('Always write a failing test first.');
  });
});
