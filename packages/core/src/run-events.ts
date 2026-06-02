/**
 * The orchestrator's outward event stream. The CLI/TUI and any downstream
 * consumer subscribe to these; they are also persisted with a run so a paused
 * or crashed run can be replayed/inspected.
 */
import type { AgentEvent } from '@omakase/daemon';
import type { RoleAssignment } from './modes/policy.js';
import type { PlanGraphSnapshot, ReplanReason, TaskStatus } from './plan/plan-graph.js';
import type { RouteDecision } from './router/router.js';
import type { AgentRole, OrchestrationRequest, WorkMode } from './types.js';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** Made progress but not finished — e.g. the iteration cap was hit. Resumable. */
  | 'incomplete';

export interface InboxItemSnapshot {
  id: string;
  kind: 'requirement' | 'instruction' | 'interrupt';
  text: string;
  priority: number;
  createdAt: number;
  consumed: boolean;
}

export type OrchestratorEvent =
  | { type: 'run-started'; runId: string; request: OrchestrationRequest; mode: WorkMode }
  | { type: 'routed'; decision: RouteDecision }
  | { type: 'planned'; snapshot: PlanGraphSnapshot }
  | {
      type: 'task-status';
      taskId: string;
      title: string;
      from: TaskStatus;
      to: TaskStatus;
    }
  | {
      type: 'agent-event';
      role: AgentRole;
      taskId: string | null;
      assignment: RoleAssignment;
      event: AgentEvent;
    }
  | {
      type: 'task-finished';
      taskId: string;
      title: string;
      role: AgentRole;
      success: boolean;
      summary: string;
    }
  | { type: 'review'; taskId: string; approved: boolean; notes: string }
  | { type: 'replanned'; reason: ReplanReason; snapshot: PlanGraphSnapshot }
  | { type: 'knowledge-updated'; wikiEntries: number; codegraphFiles: number | null }
  | {
      type: 'budget-exhausted';
      spentTokens: number;
      spentCostUsd: number;
      limit: { maxTokens?: number; maxCostUsd?: number };
    }
  | { type: 'user-input'; item: InboxItemSnapshot }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'heartbeat'; at: number }
  | { type: 'run-finished'; status: RunStatus; summary: string }
  | { type: 'error'; phase: string; message: string };

export type OrchestratorEventType = OrchestratorEvent['type'];
