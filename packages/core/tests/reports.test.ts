import { describe, expect, it } from 'vitest';
import { cleanAgentArtifactText, createReportArtifact } from '../src/reports.js';

describe('report artifacts', () => {
  it('creates a durable read-only report artifact', () => {
    const report = createReportArtifact({
      runId: 'run-1',
      kind: 'planning',
      title: 'Planning report',
      summary: 'Planner produced two tasks.',
      markdown: '# Planning report\n\nPlanner produced two tasks.',
      authorAgentId: 'codex',
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
      authorAgentId: 'codex',
      authorRole: 'reporter',
      source: 'agent',
      taskId: null,
      createdAt: 10,
    });
  });

  it('drops process chatter before the first markdown heading', () => {
    expect(
      cleanAgentArtifactText(
        'Using memory lightly before drafting.## Planning report\n\nThe reporter synthesized current state.',
      ),
    ).toBe('## Planning report\n\nThe reporter synthesized current state.');
    expect(cleanAgentArtifactText('Plain durable wiki fact.')).toBe('Plain durable wiki fact.');
  });
});
