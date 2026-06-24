import type {
  KnowledgeEvent,
  OrchestratorEvent,
  ReportArtifact,
  RunRecord,
  TaskNode,
  WikiEntry,
} from '@omakase/core';

export function makeTask(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: `task ${id}`,
    description: '',
    role: 'worker',
    status: 'pending',
    dependsOn: [],
    attempts: 0,
    tags: [],
    createdAt: 1000,
    metadata: {},
    ...overrides,
  };
}

export function makeReport(id: string, overrides: Partial<ReportArtifact> = {}): ReportArtifact {
  return {
    id,
    runId: 'run-1',
    kind: 'review',
    title: `report ${id}`,
    summary: 'summary',
    markdown: '# report',
    taskId: null,
    authorAgentId: 'claude',
    authorRole: 'reporter',
    source: 'agent',
    createdAt: 1234,
    ...overrides,
  };
}

export function makeKnowledgeEvent(
  id: string,
  overrides: Partial<KnowledgeEvent> = {},
): KnowledgeEvent {
  return {
    id,
    runId: 'run-1',
    kind: 'fact',
    title: `fact ${id}`,
    body: 'body',
    createdAt: 1500,
    ...overrides,
  };
}

export function makeWikiEntry(id: string, overrides: Partial<WikiEntry> = {}): WikiEntry {
  return {
    id,
    kind: 'fact',
    title: `wiki ${id}`,
    body: 'wiki body',
    tags: ['tag'],
    createdAt: 2000,
    updatedAt: 2000,
    ...overrides,
  };
}

export function makeRecord(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    request: { prompt: 'do the thing', cwd: '/tmp/project' },
    mode: 'normal',
    status: 'running',
    plan: { tasks: [makeTask('t1')], seq: 1 },
    wiki: { entries: [] },
    inbox: [],
    events: [],
    summary: '',
    createdAt: 1000,
    updatedAt: 1000,
    heartbeatAt: 1000,
    checkpointSeq: 0,
    ...overrides,
  };
}

export function heartbeat(at: number): OrchestratorEvent {
  return { type: 'heartbeat', at };
}
