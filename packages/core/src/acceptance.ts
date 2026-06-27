import type { ReviewCriterion } from './run-events.js';

export type AcceptanceStatus = 'pending' | 'pass' | 'fail' | 'unknown' | 'needs-user';
export type AcceptanceSource = 'planner' | 'user' | 'reviewer' | 'replan' | 'spec';

export interface AcceptanceEvidence {
  text: string;
  taskId?: string;
  reportId?: string;
  wikiEntryId?: string;
  eventId?: string;
  createdAt: number;
}

export interface AcceptanceCriterion {
  id: string;
  title: string;
  description: string;
  status: AcceptanceStatus;
  evidence: AcceptanceEvidence[];
  source: AcceptanceSource;
  createdAt: number;
  updatedAt: number;
}

export interface AcceptanceProgress {
  passed: number;
  total: number;
  complete: boolean;
}

export interface CreateAcceptanceInput {
  prompt: string;
  rawCriteria?: readonly string[];
  clock: () => number;
  nextId: (prefix: string) => string;
}

export function createAcceptanceCriteria(input: CreateAcceptanceInput): AcceptanceCriterion[] {
  const now = input.clock();
  const raw = (input.rawCriteria ?? []).map((criterion) => criterion.trim()).filter(Boolean);
  const items = raw.length > 0 ? raw : ['Complete requested work'];
  return items.map((criterion) => ({
    id: input.nextId('criterion'),
    title: criterion,
    description: raw.length > 0 ? criterion : input.prompt,
    status: 'pending',
    evidence: [],
    source: 'planner',
    createdAt: now,
    updatedAt: now,
  }));
}

export function applyStructuredReview(
  criteria: readonly AcceptanceCriterion[],
  verdicts: readonly ReviewCriterion[],
  options: { clock: () => number; taskId?: string },
): AcceptanceCriterion[] {
  const now = options.clock();
  return criteria.map((criterion, index) => {
    const verdict =
      verdicts.find((v) => v.criterion === criterion.title || v.criterion === criterion.description) ??
      verdicts[index];
    if (!verdict) return { ...criterion, status: 'unknown', updatedAt: now };

    const note = verdict.note?.trim();
    return {
      ...criterion,
      status: verdict.met ? 'pass' : 'fail',
      evidence: note
        ? [
            ...criterion.evidence,
            {
              text: note,
              ...(options.taskId ? { taskId: options.taskId } : {}),
              createdAt: now,
            },
          ]
        : criterion.evidence,
      updatedAt: now,
    };
  });
}

export function acceptanceProgress(criteria: readonly AcceptanceCriterion[]): AcceptanceProgress {
  const total = criteria.length;
  const passed = criteria.filter((criterion) => criterion.status === 'pass').length;
  return { passed, total, complete: total > 0 && passed === total };
}
