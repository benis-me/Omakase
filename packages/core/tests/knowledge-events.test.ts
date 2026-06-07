import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKnowledgeEvent, knowledgeEventToWikiEntry, renderKnowledgeEventsMarkdown } from '../src/knowledge/events.js';
import { FileKnowledgeStore } from '../src/knowledge/store.js';

describe('structured knowledge events', () => {
  it('creates structured events and renders them as wiki-compatible markdown', () => {
    const event = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'progress',
      title: 'Parser implemented',
      body: 'The worker completed parser scaffolding.',
      taskId: 'task-1',
      criterionId: 'criterion-1',
      reportId: 'report-1',
      clock: () => 42,
      nextId: (prefix) => `${prefix}-1`,
    });

    expect(event).toMatchObject({
      id: 'knowledge-1',
      runId: 'run-1',
      kind: 'progress',
      taskId: 'task-1',
      criterionId: 'criterion-1',
      reportId: 'report-1',
      createdAt: 42,
    });
    expect(knowledgeEventToWikiEntry(event)).toMatchObject({
      id: 'knowledge-1',
      kind: 'note',
      title: 'Parser implemented',
      source: 'knowledge:run-1:knowledge-1',
    });
    expect(renderKnowledgeEventsMarkdown([event])).toContain('Parser implemented');
  });

  it('round-trips structured knowledge events in FileKnowledgeStore', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-knowledge-events-'));
    const store = new FileKnowledgeStore(dir);
    const event = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'decision',
      title: 'Use structured reports',
      body: 'Reports stay outside the main task graph.',
      clock: () => 0,
      nextId: (prefix) => `${prefix}-1`,
    });

    await store.saveKnowledgeEvents([event]);
    expect(await store.loadKnowledgeEvents()).toEqual([event]);
  });

  it('represents agent-authored synthesis distinctly from run logs', () => {
    const event = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'synthesis',
      title: 'Project architecture',
      body: 'Agent-authored project wiki: the daemon owns execution and the TUI replays persisted run events.',
      authorAgentId: 'codex',
      clock: () => 12,
      nextId: (prefix) => `${prefix}-1`,
    });

    expect(event).toMatchObject({
      kind: 'synthesis',
      authorAgentId: 'codex',
    });
    expect(knowledgeEventToWikiEntry(event)).toMatchObject({
      kind: 'fact',
      title: 'Project architecture',
      source: 'knowledge:run-1:knowledge-1',
    });
  });
});
