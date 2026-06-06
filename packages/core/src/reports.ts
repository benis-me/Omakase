export type ReportKind = 'planning' | 'review' | 'milestone';

export interface ReportArtifact {
  id: string;
  runId: string;
  kind: ReportKind;
  title: string;
  summary: string;
  markdown: string;
  taskId: string | null;
  createdAt: number;
}

export function createReportArtifact(input: {
  runId: string;
  kind: ReportKind;
  title: string;
  summary: string;
  markdown: string;
  taskId?: string;
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
    createdAt: input.clock(),
  };
}
