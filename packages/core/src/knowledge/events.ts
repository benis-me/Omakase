import type { WikiEntry, WikiEntryKind } from './wiki.js';

export type KnowledgeEventKind = 'fact' | 'decision' | 'risk' | 'progress' | 'report';

export interface KnowledgeEvent {
  id: string;
  runId: string;
  kind: KnowledgeEventKind;
  title: string;
  body: string;
  taskId?: string;
  criterionId?: string;
  reportId?: string;
  createdAt: number;
}

export function createKnowledgeEvent(input: {
  runId: string;
  kind: KnowledgeEventKind;
  title: string;
  body: string;
  taskId?: string;
  criterionId?: string;
  reportId?: string;
  clock: () => number;
  nextId: (prefix: string) => string;
}): KnowledgeEvent {
  return {
    id: input.nextId('knowledge'),
    runId: input.runId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.criterionId ? { criterionId: input.criterionId } : {}),
    ...(input.reportId ? { reportId: input.reportId } : {}),
    createdAt: input.clock(),
  };
}

function wikiKind(kind: KnowledgeEventKind): WikiEntryKind {
  if (kind === 'fact' || kind === 'decision' || kind === 'risk') return kind;
  return 'note';
}

export function knowledgeEventToWikiEntry(event: KnowledgeEvent): WikiEntry {
  const tags = ['knowledge', event.kind, `run:${event.runId}`];
  if (event.taskId) tags.push(`task:${event.taskId}`);
  if (event.criterionId) tags.push(`criterion:${event.criterionId}`);
  if (event.reportId) tags.push(`report:${event.reportId}`);
  return {
    id: event.id,
    kind: wikiKind(event.kind),
    title: event.title,
    body: event.body,
    tags,
    source: `knowledge:${event.runId}:${event.id}`,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  };
}

export function renderKnowledgeEventsMarkdown(events: readonly KnowledgeEvent[]): string {
  if (events.length === 0) return '# Knowledge Events\n';
  const lines = ['# Knowledge Events', ''];
  for (const event of events) {
    lines.push(`## ${event.title}`, event.body, '');
    lines.push(`_kind: ${event.kind}; run: ${event.runId}${event.reportId ? `; report: ${event.reportId}` : ''}_`, '');
  }
  return lines.join('\n').trimEnd();
}
