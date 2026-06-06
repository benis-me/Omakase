import { describe, expect, it } from 'vitest';
import { createReportArtifact } from '../src/reports.js';

describe('report artifacts', () => {
  it('creates a durable read-only report artifact', () => {
    const report = createReportArtifact({
      runId: 'run-1',
      kind: 'planning',
      title: 'Planning report',
      summary: 'Planner produced two tasks.',
      markdown: '# Planning report\n\nPlanner produced two tasks.',
      clock: () => 10,
      nextId: (prefix) => `${prefix}-1`,
    });

    expect(report).toEqual({
      id: 'report-1',
      runId: 'run-1',
      kind: 'planning',
      title: 'Planning report',
      summary: 'Planner produced two tasks.',
      markdown: '# Planning report\n\nPlanner produced two tasks.',
      taskId: null,
      createdAt: 10,
    });
  });
});
