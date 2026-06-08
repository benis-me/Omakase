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
    workflow: {
      id: 'workflow-1',
      script: {
        id: 'workflow-script-1',
        path: '/tmp/workflow.js',
        source: 'export default async function workflow() {}',
        runtime: 'bun',
        createdAt: 0,
      },
      request: { prompt: 'build a parser' },
      status: 'succeeded',
      phases: [
        {
          id: 'workflow-phase-1',
          name: 'Implementation',
          status: 'succeeded',
          startedAt: 0,
          finishedAt: 0,
          agentRunIds: ['agent-run-1'],
          error: null,
        },
      ],
      agents: [
        {
          taskId: 'task-1',
          agentRunId: 'agent-run-1',
          agentLabel: 'codex#task-1',
          agentId: 'codex',
          role: 'worker',
          title: 'Implement parser',
          prompt: 'Implement parser',
          phaseId: 'workflow-phase-1',
          phaseName: 'Implementation',
          status: 'succeeded',
          startedAt: 0,
          finishedAt: 0,
          tokens: 10,
          toolCount: 1,
          model: null,
          error: null,
        },
      ],
      checkpoints: [],
      maxConcurrency: 16,
      maxAgents: 1000,
      startedAt: 0,
      updatedAt: 0,
      finishedAt: 0,
      error: null,
    },
    inbox: [],
    events: [
      {
        type: 'report-requested',
        kind: 'planning',
        title: 'Planning report',
        reason: 'planner:planned',
        taskId: null,
        source: 'planner',
      },
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
          tags: ['manual'],
          source: 'manual:test',
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
          imports: [
            {
              specifier: './runtime.js',
              to: 'src/runtime.ts',
              external: false,
              specifiers: ['runParser'],
              line: 1,
            },
          ],
          exports: ['parse'],
          symbols: [{ name: 'parse', kind: 'function', exported: true, line: 2 }],
          references: [
            {
              from: 'src/parser.ts',
              to: 'src/runtime.ts',
              imported: 'runParser',
              local: 'runParser',
              count: 2,
              lines: [4, 5],
            },
          ],
        },
        {
          path: 'src/runtime.ts',
          language: 'typescript',
          loc: 8,
          imports: [],
          exports: ['runParser'],
          symbols: [{ name: 'runParser', kind: 'function', exported: true, line: 1 }],
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
      const governance = await fetch(`${server.url}/api/wiki/governance`).then(
        (res) =>
          res.json() as Promise<{
            pages: number;
            wikiEntries: number;
            editableEntries: number;
            agentPages: number;
            codegraphPages: number;
            sources: Array<{ kind: string; count: number }>;
          }>,
      );
      expect(governance).toMatchObject({
        pages: 2,
        wikiEntries: 1,
        editableEntries: 1,
        agentPages: 1,
        codegraphPages: 1,
      });
      expect(governance.sources).toEqual(
        expect.arrayContaining([
          { kind: 'agent', count: 1 },
          { kind: 'codegraph', count: 1 },
          { kind: 'manual', count: 1 },
        ]),
      );
      const home = await fetch(server.url).then((res) => res.text());
      expect(home).toContain('Planning report');
      expect(home).toContain('Project Knowledge');
      expect(home).toContain('Wiki Governance');
      expect(home).toContain('Live project knowledge');
      expect(home).toContain('source: codegraph');
      expect(home).toContain('data-region="wiki-governance"');
      expect(home).toContain('Omakase Mission Control');
      expect(home).toContain('data-region="reports"');
      expect(home).toContain('data-region="support-activity"');
      expect(home).toContain('data-region="wiki-pages"');
      expect(home).toContain('data-region="acceptance"');
      expect(home).toContain('data-region="iterations"');
      expect(home).toContain('data-region="agents"');
      expect(home).toContain('data-region="workflows"');
      expect(home).toContain('data-region="codegraph"');
      expect(home).toContain('data-region="events"');
      expect(home).toContain('const jsonOr = async (url)');
      expect(home).toContain('jsonOr("/api/reports")');
      expect(home).toContain('jsonOr("/api/support-activity")');
      expect(home).toContain('jsonOr("/api/wiki/pages")');
      expect(home).toContain('jsonOr("/api/wiki/governance")');
      expect(home).toContain('jsonOr("/api/workflows")');
      expect(home).toContain('textOr("/api/wiki")');
      expect(home).toContain('Read-only · reconnecting');
      expect(home).not.toContain('fetch("/api/reports").then');
      expect(home).not.toContain('fetch("/api/wiki/pages").then');
      expect(home).toContain('setInterval(refreshDashboard');
      expect(home).not.toContain('http-equiv="refresh"');
      const runs = await fetch(`${server.url}/api/runs`).then((res) => res.json() as Promise<unknown[]>);
      expect(runs).toHaveLength(1);
      const activity = await fetch(`${server.url}/api/activity`).then((res) => res.json() as Promise<unknown[]>);
      expect(activity).toHaveLength(0);
      const supportActivity = await fetch(`${server.url}/api/support-activity`).then((res) => res.json() as Promise<unknown[]>);
      expect(supportActivity).toHaveLength(2);
      expect(supportActivity).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'report requested · Planning report · planner:planned' })]),
      );
      const acceptance = await fetch(`${server.url}/api/acceptance`).then((res) => res.json() as Promise<Array<{ criteria: unknown[] }>>);
      expect(acceptance[0]?.criteria).toHaveLength(1);
      const workflows = await fetch(`${server.url}/api/workflows`).then(
        (res) => res.json() as Promise<Array<{ runId: string; phases: number; agents: number }>>,
      );
      expect(workflows[0]).toMatchObject({ runId: 'run-1', phases: 1, agents: 1 });
      const iterations = await fetch(`${server.url}/api/iterations`).then((res) => res.json() as Promise<unknown[]>);
      expect(iterations).toHaveLength(1);
      const agents = await fetch(`${server.url}/api/agents`).then((res) => res.json() as Promise<Array<{ agentId: string | null }>>);
      expect(agents[0]?.agentId).toBe('codex');
      const codegraph = await fetch(`${server.url}/api/codegraph`).then(
        (res) => res.json() as Promise<{ files: number; symbolReferences: Array<{ local: string; to: string }> }>,
      );
      expect(codegraph.files).toBe(2);
      expect(codegraph.symbolReferences[0]).toMatchObject({ local: 'runParser', to: 'src/runtime.ts' });
      const events = await fetch(`${server.url}/api/events`).then((res) => res.json() as Promise<unknown[]>);
      expect(events).toHaveLength(2);
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

  it('derives wiki pages from current knowledge instead of stale page artifacts', async () => {
    const store = new MemoryRunStore();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-readonly-stale-wiki-'));
    const knowledgeStore = new FileKnowledgeStore(dir);
    await knowledgeStore.saveKnowledgeEvents([
      createKnowledgeEvent({
        runId: 'run-1',
        kind: 'synthesis',
        title: 'Wiki synthesis: Planner boundary',
        body: 'Outdated planner note.',
        authorAgentId: 'codex',
        clock: () => 1,
        nextId: (prefix) => `${prefix}-1`,
      }),
      createKnowledgeEvent({
        runId: 'run-2',
        kind: 'synthesis',
        title: 'Wiki synthesis: Planner boundary',
        body: '## Planner boundary\n\nPlanner creates worker tasks only; reports stay out of the wiki pages.',
        authorAgentId: 'codex',
        clock: () => 2,
        nextId: (prefix) => `${prefix}-2`,
      }),
      createKnowledgeEvent({
        runId: 'run-2',
        kind: 'report',
        title: 'Planning report',
        body: 'running: 0/4 tasks succeeded',
        authorAgentId: 'codex',
        clock: () => 3,
        nextId: (prefix) => `${prefix}-3`,
      }),
    ]);
    await knowledgeStore.saveWikiPages([
      {
        id: 'overview',
        title: 'Project Overview',
        body: 'stale report log that should not be served',
        sourceKind: 'agent',
        sourceEventIds: ['stale'],
        sourceRunIds: ['stale-run'],
        authorAgentIds: ['codex'],
        updatedAt: 0,
      },
    ]);

    const server = await startReadOnlyServer({ store, knowledgeStore });
    try {
      const pages = await fetch(`${server.url}/api/wiki/pages`).then((res) => res.json() as Promise<WikiPage[]>);
      expect(pages[0]?.sourceEventIds).toEqual(['knowledge-2']);
      expect(pages[0]?.body).toContain('Planner creates worker tasks only');
      expect(pages[0]?.body).not.toContain('stale report log');
      expect(pages[0]?.body).not.toContain('running: 0/4 tasks succeeded');
    } finally {
      await server.close();
    }
  });

  it('serves a run inspector with task, agent, report, knowledge, and event detail', async () => {
    const store = new MemoryRunStore();
    const rich = record('run-detail');
    rich.knowledgeEvents = [
      createKnowledgeEvent({
        runId: 'run-detail',
        kind: 'synthesis',
        title: 'Run detail knowledge',
        body: 'The run inspector shows task and agent evidence without opening raw JSON.',
        authorAgentId: 'codex',
        clock: () => 5,
        nextId: (prefix) => `${prefix}-1`,
      }),
    ];
    (rich.knowledgeEvents[0] as { authorAgentId?: string }).authorAgentId = undefined;
    rich.events = [
      ...rich.events,
      {
        type: 'agent-assigned',
        role: 'worker',
        taskId: 'task-1',
        title: 'Implement parser',
        assignment: { role: 'worker', agentId: 'codex', model: null, reasoning: null, rationale: 'test' },
        agentRunId: 'agent-run-1',
        agentLabel: 'codex#task-1',
      },
      {
        type: 'agent-event',
        role: 'worker',
        taskId: 'task-1',
        assignment: { role: 'worker', agentId: 'codex', model: null, reasoning: null, rationale: 'test' },
        agentRunId: 'agent-run-1',
        agentLabel: 'codex#task-1',
        event: { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'package.json' } },
      },
      {
        type: 'agent-event',
        role: 'worker',
        taskId: 'task-1',
        assignment: { role: 'worker', agentId: 'codex', model: null, reasoning: null, rationale: 'test' },
        agentRunId: 'agent-run-1',
        agentLabel: 'codex#task-1',
        event: { type: 'usage', usage: { totalTokens: 42 } },
      },
      {
        type: 'agent-event',
        role: 'worker',
        taskId: 'task-1',
        assignment: { role: 'worker', agentId: 'codex', model: null, reasoning: null, rationale: 'test' },
        agentRunId: 'agent-run-1',
        agentLabel: 'codex#task-1',
        event: { type: 'text_delta', delta: 'parser evidence ready' },
      },
      { type: 'run-finished', status: 'succeeded', summary: 'done' },
    ];
    await store.save(rich);

    const server = await startReadOnlyServer({ store });
    try {
      const detail = await fetch(`${server.url}/api/run/run-detail/detail`).then(
        (res) =>
          res.json() as Promise<{
            run: { id: string; status: string; taskDone: number; taskTotal: number };
            tasks: Array<{ id: string; agentLabel: string | null; tokens: number; tools: number }>;
            agents: Array<{ agentLabel: string | null; tokens: number; tools: number; lastEventType: string | null; lastText: string | null }>;
            reports: unknown[];
            knowledgeEvents: unknown[];
            events: Array<{ type: string; label: string }>;
          }>,
      );

      expect(detail.run).toMatchObject({ id: 'run-detail', status: 'succeeded', taskDone: 1, taskTotal: 1 });
      expect(detail.tasks[0]).toMatchObject({ id: 'task-1', agentLabel: 'codex#task-1', tokens: 42, tools: 1 });
      expect(detail.agents[0]).toMatchObject({
        agentLabel: 'codex#task-1',
        tokens: 42,
        tools: 1,
        lastEventType: 'text_delta',
        lastText: 'parser evidence ready',
      });
      expect(detail.reports).toHaveLength(1);
      expect(detail.knowledgeEvents).toHaveLength(1);
      expect(detail.events.map((event) => event.type)).toContain('run-finished');

      const home = await fetch(server.url).then((res) => res.text());
      expect(home).toContain('Run Inspector');
      expect(home).toContain('data-region="run-detail"');
      expect(home).toContain('data-run-id="run-detail"');
      expect(home).toContain('<h3>Reports</h3>');
      expect(home).toContain('Planning report');
      expect(home).toContain('<h3>Knowledge</h3>');
      expect(home).toContain('Run detail knowledge');
      expect(home).toContain('<h3>Iterations</h3>');
      expect(home).toContain('initial-plan');
      expect(home).toContain('jsonOr("/api/run/" + encodeURIComponent(activeRunId) + "/detail"');
    } finally {
      await server.close();
    }
  });
});
