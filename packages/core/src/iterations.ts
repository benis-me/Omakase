export type IterationStatus =
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'replanning'
  | 'waiting-for-user'
  | 'complete';

export interface IterationSnapshot {
  id: string;
  index: number;
  status: IterationStatus;
  reason: string;
  taskIds: string[];
  reviewSummary: string | null;
  failedCriteria: string[];
  nextStrategy: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export function createIteration(input: {
  index: number;
  reason: string;
  taskIds: readonly string[];
  clock: () => number;
  nextId: (prefix: string) => string;
}): IterationSnapshot {
  return {
    id: input.nextId('iteration'),
    index: input.index,
    status: 'running',
    reason: input.reason,
    taskIds: [...input.taskIds],
    reviewSummary: null,
    failedCriteria: [],
    nextStrategy: null,
    startedAt: input.clock(),
    finishedAt: null,
  };
}

export function finishIteration(
  iteration: IterationSnapshot,
  patch: {
    status: IterationStatus;
    reviewSummary: string;
    failedCriteria: readonly string[];
    nextStrategy: string;
    clock: () => number;
  },
): IterationSnapshot {
  return {
    ...iteration,
    status: patch.status,
    reviewSummary: patch.reviewSummary,
    failedCriteria: [...patch.failedCriteria],
    nextStrategy: patch.nextStrategy,
    finishedAt: patch.clock(),
  };
}
