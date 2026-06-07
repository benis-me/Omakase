export type ReportKind = 'planning' | 'review' | 'milestone';

export interface ReportArtifact {
  id: string;
  runId: string;
  kind: ReportKind;
  title: string;
  summary: string;
  markdown: string;
  taskId: string | null;
  authorAgentId: string | null;
  authorRole: 'reporter';
  source: 'agent' | 'fallback';
  createdAt: number;
}

export function cleanAgentArtifactText(text: string): string {
  const trimmed = text.trim();
  const heading = /#{1,3}\s+[^\n]+/.exec(trimmed);
  if (!heading || heading.index === 0) return trimmed;
  return trimmed.slice(heading.index).trim();
}

export function createReportArtifact(input: {
  runId: string;
  kind: ReportKind;
  title: string;
  summary: string;
  markdown: string;
  taskId?: string;
  authorAgentId?: string | null;
  source?: 'agent' | 'fallback';
  clock: () => number;
  nextId: (prefix: string) => string;
}): ReportArtifact {
  return {
    id: input.nextId('report'),
    runId: input.runId,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    markdown: input.markdown,
    taskId: input.taskId ?? null,
    authorAgentId: input.authorAgentId ?? null,
    authorRole: 'reporter',
    source: input.source ?? (input.authorAgentId ? 'agent' : 'fallback'),
    createdAt: input.clock(),
  };
}
