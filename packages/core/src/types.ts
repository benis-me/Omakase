/**
 * Shared domain vocabulary for the orchestration core.
 */

/** The roles in the Ralph loop. Each is executed by an agent chosen by policy. */
export type AgentRole = 'router' | 'planner' | 'worker' | 'reviewer';

export const AGENT_ROLES: readonly AgentRole[] = ['router', 'planner', 'worker', 'reviewer'];

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
  /** Free-form metadata threaded into hooks and persisted with the run. */
  metadata?: Record<string, unknown>;
}

export interface FileChange {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  reason?: string;
  taskId?: string;
}
