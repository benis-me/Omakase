import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileKnowledgeStore, MemoryRunStore, type RunRecord } from '@omakase/core';
import { startReadOnlyServer } from '../src/read-only-server.js';

function record(id: string): RunRecord {
  return {
    id,
    request: { prompt: 'build a parser' },
    mode: 'normal',
    status: 'succeeded',
    plan: { tasks: [], seq: 0 },
    wiki: { entries: [] },
    acceptance: { criteria: [], progress: { passed: 0, total: 0, complete: false } },
    iterations: [],
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

    const server = await startReadOnlyServer({ store, knowledgeStore });
    try {
      const run = await fetch(`${server.url}/api/run/run-1`).then((res) => res.json() as Promise<RunRecord>);
      expect(run.id).toBe('run-1');
      const reports = await fetch(`${server.url}/api/reports`).then((res) => res.json() as Promise<unknown[]>);
      expect(reports).toHaveLength(1);
      const wiki = await fetch(`${server.url}/api/wiki`).then((res) => res.text());
      expect(wiki).toContain('Uses TypeScript');
      const home = await fetch(server.url).then((res) => res.text());
      expect(home).toContain('Planning report');
      expect(home).toContain('Project Wiki');
      expect(home).toContain('Uses TypeScript');
      expect(home).toContain('Omakase Mission Control');
      expect(home).toContain('data-region="reports"');
      expect(home).toContain('fetch("/api/reports"');
      expect(home).toContain('setInterval(refreshDashboard');
      expect(home).not.toContain('http-equiv="refresh"');
      const runs = await fetch(`${server.url}/api/runs`).then((res) => res.json() as Promise<unknown[]>);
      expect(runs).toHaveLength(1);
      const activity = await fetch(`${server.url}/api/activity`).then((res) => res.json() as Promise<unknown[]>);
      expect(activity).toHaveLength(1);
      const post = await fetch(`${server.url}/api/run/run-1`, { method: 'POST' });
      expect(post.status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
