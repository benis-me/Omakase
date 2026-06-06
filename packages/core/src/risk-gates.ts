export type RiskGateStatus = 'open' | 'answered' | 'cancelled';
export type RiskGateReason = 'review-uncertain' | 'user-confirmation' | 'high-risk-change';

export interface RiskGateSnapshot {
  id: string;
  status: RiskGateStatus;
  reason: RiskGateReason;
  question: string;
  taskId?: string;
  answer: string | null;
  criteria: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export function createRiskGate(input: {
  reason: RiskGateReason;
  question: string;
  taskId?: string;
  clock: () => number;
  nextId: (prefix: string) => string;
}): RiskGateSnapshot {
  const now = input.clock();
  return {
    id: input.nextId('gate'),
    status: 'open',
    reason: input.reason,
    question: input.question,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    answer: null,
    criteria: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function answerRiskGate(
  gate: RiskGateSnapshot,
  input: { answer: string; criteria?: readonly string[]; clock: () => number },
): RiskGateSnapshot {
  return {
    ...gate,
    status: 'answered',
    answer: input.answer,
    criteria: input.criteria ? [...input.criteria] : gate.criteria,
    updatedAt: input.clock(),
  };
}
