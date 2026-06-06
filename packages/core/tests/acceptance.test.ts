import { describe, expect, it } from 'vitest';
import {
  acceptanceProgress,
  applyStructuredReview,
  createAcceptanceCriteria,
} from '../src/acceptance.js';

describe('acceptance criteria', () => {
  it('creates durable editable criteria from explicit request criteria', () => {
    let seq = 0;
    const criteria = createAcceptanceCriteria({
      prompt: 'build a parser',
      rawCriteria: ['parses CSV input', 'has tests'],
      clock: () => 123,
      nextId: (prefix) => `${prefix}-${++seq}`,
    });

    expect(criteria).toEqual([
      {
        id: 'criterion-1',
        title: 'parses CSV input',
        description: 'parses CSV input',
        status: 'pending',
        evidence: [],
        source: 'planner',
        createdAt: 123,
        updatedAt: 123,
      },
      {
        id: 'criterion-2',
        title: 'has tests',
        description: 'has tests',
        status: 'pending',
        evidence: [],
        source: 'planner',
        createdAt: 123,
        updatedAt: 123,
      },
    ]);
  });

  it('falls back to a single product-completion criterion when none are provided', () => {
    const criteria = createAcceptanceCriteria({
      prompt: 'ship the feature',
      rawCriteria: [],
      clock: () => 5,
      nextId: (prefix) => `${prefix}-fallback`,
    });

    expect(criteria).toHaveLength(1);
    expect(criteria[0]).toMatchObject({
      id: 'criterion-fallback',
      title: 'Complete requested work',
      description: 'ship the feature',
      status: 'pending',
      source: 'planner',
    });
  });

  it('updates criterion status and progress from reviewer verdicts', () => {
    let seq = 0;
    const base = createAcceptanceCriteria({
      prompt: 'build',
      rawCriteria: ['works', 'tested'],
      clock: () => 0,
      nextId: (prefix) => `${prefix}-${++seq}`,
    });
    const updated = applyStructuredReview(
      base,
      [
        { criterion: 'works', met: true, note: 'manual smoke passed' },
        { criterion: 'tested', met: false, note: 'missing regression test' },
      ],
      { clock: () => 10, taskId: 'review-1' },
    );

    expect(updated.map((c) => c.status)).toEqual(['pass', 'fail']);
    expect(updated[0]?.evidence[0]).toMatchObject({
      text: 'manual smoke passed',
      taskId: 'review-1',
      createdAt: 10,
    });
    expect(acceptanceProgress(updated)).toEqual({ passed: 1, total: 2, complete: false });
  });
});
