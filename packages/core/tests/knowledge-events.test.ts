import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKnowledgeEvent, knowledgeEventToWikiEntry, renderKnowledgeEventsMarkdown } from '../src/knowledge/events.js';
import { buildWikiPages, renderWikiPagesMarkdown } from '../src/knowledge/pages.js';
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

  it('builds durable wiki pages from agent-authored knowledge instead of raw run logs', () => {
    const synthesis = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'synthesis',
      title: 'Project architecture',
      body: 'The daemon owns execution. The TUI replays durable run state.',
      authorAgentId: 'codex',
      clock: () => 10,
      nextId: (prefix) => `${prefix}-1`,
    });
    const decision = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'decision',
      title: 'Keep reports out of the plan graph',
      body: 'Reporter output is display knowledge, not a worker dependency.',
      authorAgentId: 'codex',
      clock: () => 11,
      nextId: (prefix) => `${prefix}-2`,
    });
    const risk = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'risk',
      title: 'Agent auth false positives',
      body: 'A detected CLI can still be unusable if auth probes are too broad.',
      authorAgentId: 'codex',
      clock: () => 12,
      nextId: (prefix) => `${prefix}-3`,
    });
    const progress = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'progress',
      title: 'Verified wiki pages',
      body: 'knowledge-events and read-only-server tests pass.',
      authorAgentId: 'codex',
      clock: () => 13,
      nextId: (prefix) => `${prefix}-4`,
    });
    const rawLog = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'report',
      title: 'Fallback planning report',
      body: 'running: 0/4 tasks succeeded',
      clock: () => 14,
      nextId: (prefix) => `${prefix}-5`,
    });

    const pages = buildWikiPages([synthesis, decision, risk, progress, rawLog]);

    expect(pages.map((page) => page.id)).toEqual(['overview', 'decisions', 'risks', 'verification']);
    expect(pages.find((page) => page.id === 'overview')?.body).toContain('The daemon owns execution');
    expect(pages.find((page) => page.id === 'decisions')?.body).toContain('Keep reports out of the plan graph');
    expect(pages.find((page) => page.id === 'risks')?.body).toContain('Agent auth false positives');
    expect(pages.find((page) => page.id === 'verification')?.body).toContain('Verified wiki pages');
    expect(pages.flatMap((page) => page.sourceEventIds)).toEqual(
      expect.arrayContaining(['knowledge-1', 'knowledge-2', 'knowledge-3', 'knowledge-4']),
    );
    expect(pages.map((page) => page.body).join('\n')).not.toContain('running: 0/4 tasks succeeded');

    const markdown = renderWikiPagesMarkdown(pages);
    expect(markdown).toContain('# Project Knowledge Base');
    expect(markdown).toContain('source events: knowledge-1');
    expect(markdown).toContain('agents: codex');
  });

  it('keeps wiki pages durable by excluding reports and collapsing repeated synthesis updates', () => {
    const older = createKnowledgeEvent({
      runId: 'run-1',
      kind: 'synthesis',
      title: 'Wiki synthesis: Planner boundary',
      body: 'Old run-local description that should be replaced.',
      authorAgentId: 'codex',
      clock: () => 10,
      nextId: (prefix) => `${prefix}-1`,
    });
    const newer = createKnowledgeEvent({
      runId: 'run-2',
      kind: 'synthesis',
      title: 'Wiki synthesis: Planner boundary',
      body: 'I’ll inspect recent run state first.**Planner boundary**\n\nPlanner creates worker tasks only; Omakase injects reviewer/support roles out of band.',
      authorAgentId: 'codex',
      clock: () => 20,
      nextId: (prefix) => `${prefix}-2`,
    });
    const report = createKnowledgeEvent({
      runId: 'run-2',
      kind: 'report',
      title: 'Planning report',
      body: 'running: 0/4 tasks succeeded',
      authorAgentId: 'codex',
      clock: () => 21,
      nextId: (prefix) => `${prefix}-3`,
    });

    const pages = buildWikiPages([older, newer, report]);
    const overview = pages.find((page) => page.id === 'overview');

    expect(overview?.sourceEventIds).toEqual(['knowledge-2']);
    expect(overview?.sourceRunIds).toEqual(['run-2']);
    expect(overview?.body).toContain('## Planner boundary');
    expect(overview?.body).toContain('Omakase injects reviewer/support roles out of band');
    expect(overview?.body).not.toContain('Old run-local description');
    expect(overview?.body).not.toContain('Wiki synthesis:');
    expect(overview?.body).not.toContain('Planning report');
    expect(overview?.body).not.toContain('I’ll inspect recent run state first');
    expect(pages.map((page) => page.body).join('\n')).not.toContain('running: 0/4 tasks succeeded');
  });
});
