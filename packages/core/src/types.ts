/**
 * Shared domain vocabulary for the orchestration core.
 */

/** The roles in the Ralph loop and out-of-band support agents. */
export type AgentRole =
  | 'router'
  | 'planner'
  | 'worker'
  | 'reviewer'
  | 'validator'
  | 'reporter'
  | 'wiki-curator';

export const AGENT_ROLES: readonly AgentRole[] = [
  'router',
  'planner',
  'worker',
  'reviewer',
  'validator',
  'reporter',
  'wiki-curator',
];

/**
 * Work modes govern how aggressively the system spends model capability:
 *  - `max-power`: the strongest available agent + highest reasoning everywhere,
 *  - `normal`: the system balances capability, cost, and task type per role,
 *  - `custom`: the user pins role → agent/model/reasoning/budget.
 */
export type WorkMode = 'max-power' | 'normal' | 'custom';

export interface OrchestrationRequest {
  prompt: string;
  cwd?: string;
  mode?: WorkMode;
  /**
   * Acceptance criteria the reviewer scores per-criterion (e.g. from a
   * {@link SpecWorkflow}). When present the reviewer must mark each one met or
   * unmet, and the run is only approved when all are met.
   */
  acceptanceCriteria?: string[];
  /** Free-form metadata threaded into hooks and persisted with the run. */
  metadata?: Record<string, unknown>;
}

export interface FileChange {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  reason?: string;
  taskId?: string;
}
