import { describe, expect, it } from 'vitest';
import { createIteration, finishIteration } from '../src/iterations.js';

describe('iterations', () => {
  it('creates and finishes durable iteration snapshots', () => {
    const iteration = createIteration({
      index: 1,
      reason: 'initial-plan',
      taskIds: ['task-1', 'task-2'],
      clock: () => 10,
      nextId: (prefix) => `${prefix}-1`,
    });

    expect(iteration).toMatchObject({
      id: 'iteration-1',
      index: 1,
      status: 'running',
      reason: 'initial-plan',
      taskIds: ['task-1', 'task-2'],
      startedAt: 10,
      finishedAt: null,
    });

    expect(
      finishIteration(iteration, {
        status: 'complete',
        reviewSummary: 'all criteria passed',
        failedCriteria: [],
        nextStrategy: 'finish',
        clock: () => 20,
      }),
    ).toMatchObject({
      status: 'complete',
      reviewSummary: 'all criteria passed',
      nextStrategy: 'finish',
      finishedAt: 20,
    });
  });
});
