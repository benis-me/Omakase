import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileKnowledgeStore, MemoryRunStore, createKnowledgeEvent, type RunRecord, type WikiPage } from '@omakase/core';
import { startReadOnlyServer } from '../src/read-only-server.js';

function record(id: string): RunRecord {
  return {
    id,
    request: { prompt: 'build a parser' },
    mode: 'normal',
    status: 'succeeded',
    plan: {
      tasks: [
        {
          id: 'task-1',
          title: 'Implement parser',
          description: 'Implement parser',
          role: 'worker',
          status: 'succeeded',
          dependsOn: [],
          attempts: 1,
          result: { success: true, summary: 'ok', output: 'ok', agentId: 'codex' },
          tags: ['Core'],
          createdAt: 0,
          metadata: {},
        },
      ],
      seq: 1,
    },
    wiki: { entries: [] },
    acceptance: {
      criteria: [
        {
          id: 'criterion-1',
          title: 'parser accepts valid input',
          description: 'parser accepts valid input',
          status: 'pass',
          evidence: [{ text: 'verified by reviewer', taskId: 'task-1', createdAt: 0 }],
          source: 'planner',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      progress: { passed: 1, total: 1, complete: true },
    },
    iterations: [
      {
        id: 'iteration-1',
        index: 1,
        status: 'complete',
        reason: 'initial-plan',
        taskIds: ['task-1'],
        reviewSummary: 'passed',
        failedCriteria: [],
        nextStrategy: 'finish',
        startedAt: 0,
        finishedAt: 0,
      },
    ],
    riskGates: [],
    reports: [
      {
        id: 'report-1',
        runId: id,
        kind: 'planning',
        title: 'Planning report',
        summary: 'planned',
        markdown: '# Planning report',
        taskId: null,
        authorAgentId: 'codex',
        authorRole: 'reporter',
        source: 'agent',
        createdAt: 0,
      },
    ],
    knowledgeEvents: [],
    inbox: [],
    events: [
      {
        type: 'report-created',
        report: {
          id: 'report-1',
          runId: id,
          kind: 'planning',
          title: 'Planning report',
          summary: 'planned',
          markdown: '# Planning report',
          taskId: null,
          authorAgentId: 'codex',
          authorRole: 'reporter',
          source: 'agent',
          createdAt: 0,
        },
        reports: [],
      },
    ],
    summary: 'done',
    createdAt: 0,
    updatedAt: 0,
    heartbeatAt: 0,
    checkpointSeq: 1,
  };
}

describe('read-only report/wiki server', () => {
  it('serves runs, reports, wiki, and rejects writes', async () => {
    const store = new MemoryRunStore();
    await store.save(record('run-1'));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-readonly-'));
    const knowledgeStore = new FileKnowledgeStore(dir);
    await knowledgeStore.saveWiki({
      entries: [
        {
          id: 'wiki-1',
          kind: 'fact',
          title: 'Uses TypeScript',
          body: '',
          tags: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    await knowledgeStore.saveKnowledgeEvents([
      createKnowledgeEvent({
        runId: 'run-1',
        kind: 'synthesis',
        title: 'Live project knowledge',
        body: 'Agent-authored knowledge pages summarize stable project facts.',
        authorAgentId: 'codex',
        clock: () => 0,
        nextId: (prefix) => `${prefix}-1`,
      }),
    ]);
    await knowledgeStore.saveCodegraph({
      root: dir,
      nodes: [
        {
          path: 'src/parser.ts',
          language: 'typescript',
          loc: 42,
          imports: [],
          exports: ['parse'],
          symbols: [{ name: 'parse', kind: 'function', exported: true, line: 1 }],
        },
      ],
    });

    const server = await startReadOnlyServer({ store, knowledgeStore });
    try {
      const run = await fetch(`${server.url}/api/run/run-1`).then((res) => res.json() as Promise<RunRecord>);
      expect(run.id).toBe('run-1');
      const reports = await fetch(`${server.url}/api/reports`).then((res) => res.json() as Promise<unknown[]>);
      expect(reports).toHaveLength(1);
      const wiki = await fetch(`${server.url}/api/wiki`).then((res) => res.text());
      expect(wiki).toContain('Live project knowledge');
      const wikiPages = await fetch(`${server.url}/api/wiki/pages`).then((res) => res.json() as Promise<WikiPage[]>);
      expect(wikiPages[0]?.id).toBe('overview');
      expect(wikiPages[0]?.body).toContain('Agent-authored knowledge pages');
      expect(wikiPages.find((page) => page.id === 'codegraph')?.sourceKind).toBe('codegraph');
      const home = await fetch(server.url).then((res) => res.text());
      expect(home).toContain('Planning report');
      expect(home).toContain('Project Knowledge');
      expect(home).toContain('Live project knowledge');
      expect(home).toContain('source: codegraph');
      expect(home).toContain('Omakase Mission Control');
      expect(home).toContain('data-region="reports"');
      expect(home).toContain('data-region="wiki-pages"');
      expect(home).toContain('data-region="acceptance"');
      expect(home).toContain('data-region="iterations"');
      expect(home).toContain('data-region="agents"');
      expect(home).toContain('data-region="codegraph"');
      expect(home).toContain('data-region="events"');
      expect(home).toContain('fetch("/api/reports"');
      expect(home).toContain('fetch("/api/wiki/pages"');
      expect(home).toContain('setInterval(refreshDashboard');
      expect(home).not.toContain('http-equiv="refresh"');
      const runs = await fetch(`${server.url}/api/runs`).then((res) => res.json() as Promise<unknown[]>);
      expect(runs).toHaveLength(1);
      const activity = await fetch(`${server.url}/api/activity`).then((res) => res.json() as Promise<unknown[]>);
      expect(activity).toHaveLength(1);
      const acceptance = await fetch(`${server.url}/api/acceptance`).then((res) => res.json() as Promise<Array<{ criteria: unknown[] }>>);
      expect(acceptance[0]?.criteria).toHaveLength(1);
      const iterations = await fetch(`${server.url}/api/iterations`).then((res) => res.json() as Promise<unknown[]>);
      expect(iterations).toHaveLength(1);
      const agents = await fetch(`${server.url}/api/agents`).then((res) => res.json() as Promise<Array<{ agentId: string | null }>>);
      expect(agents[0]?.agentId).toBe('codex');
      const codegraph = await fetch(`${server.url}/api/codegraph`).then((res) => res.json() as Promise<{ files: number }>);
      expect(codegraph.files).toBe(1);
      const events = await fetch(`${server.url}/api/events`).then((res) => res.json() as Promise<unknown[]>);
      expect(events).toHaveLength(1);
      const post = await fetch(`${server.url}/api/run/run-1`, { method: 'POST' });
      expect(post.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it('skips legacy records without acceptance snapshots', async () => {
    const store = new MemoryRunStore();
    const legacy = record('legacy-run') as RunRecord & { acceptance?: RunRecord['acceptance'] };
    delete legacy.acceptance;
    await store.save(legacy);

    const server = await startReadOnlyServer({ store });
    try {
      const home = await fetch(server.url).then((res) => res.text());
      expect(home).toContain('Omakase Mission Control');
      const acceptance = await fetch(`${server.url}/api/acceptance`).then((res) => res.json() as Promise<unknown[]>);
      expect(acceptance).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
