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
import type { CodeGraphStats } from './knowledge/codegraph.js';
import type { AcceptanceCriterion, AcceptanceProgress } from './acceptance.js';
import type { IterationSnapshot } from './iterations.js';
import type { RiskGateSnapshot } from './risk-gates.js';
import type { ReportArtifact, ReportKind } from './reports.js';
import type { KnowledgeEvent } from './knowledge/events.js';

export interface ReviewCriterion {
  criterion: string;
  met: boolean;
  note?: string;
}

export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting-for-user'
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

export type StrategyUpdateReason =
  | 'criteria-failed'
  | 'criteria-unknown'
  | 'gate-open'
  | 'continue'
  | 'finish'
  | 'budget'
  | 'cancelled'
  | 'manual';

export type StrategyNextAction = 'continue' | 'replan' | 'wait-for-user' | 'finish' | 'stop';

export interface AcceptanceSnapshot {
  criteria: AcceptanceCriterion[];
  progress: AcceptanceProgress;
}

export type OrchestratorEvent =
  | { type: 'run-started'; runId: string; request: OrchestrationRequest; mode: WorkMode }
  | { type: 'routed'; decision: RouteDecision }
  | { type: 'planned'; snapshot: PlanGraphSnapshot }
  | { type: 'acceptance-updated'; acceptance: AcceptanceSnapshot }
  | { type: 'iteration-updated'; iteration: IterationSnapshot; iterations: IterationSnapshot[] }
  | {
      type: 'strategy-updated';
      iterationId: string | null;
      reason: StrategyUpdateReason;
      failedCriteria: string[];
      openGates: string[];
      nextAction: StrategyNextAction;
      summary: string;
    }
  | { type: 'risk-gate-opened'; gate: RiskGateSnapshot; gates: RiskGateSnapshot[] }
  | { type: 'risk-gate-answered'; gate: RiskGateSnapshot; gates: RiskGateSnapshot[] }
  | {
      type: 'report-requested';
      kind: ReportKind;
      title: string;
      reason: string;
      taskId: string | null;
      source: 'planner' | 'reviewer' | 'strategy' | 'system';
    }
  | { type: 'report-created'; report: ReportArtifact; reports: ReportArtifact[] }
  | { type: 'knowledge-event-created'; event: KnowledgeEvent; events: KnowledgeEvent[] }
  | {
      type: 'task-status';
      taskId: string;
      title: string;
      from: TaskStatus;
      to: TaskStatus;
      /** Clock timestamp for the transition, used by file-backed clients before the next heartbeat. */
      at?: number;
    }
  | {
      type: 'agent-assigned';
      role: AgentRole;
      taskId: string | null;
      title?: string;
      assignment: RoleAssignment;
      /** Unique identity for this concrete agent process/invocation. */
      agentRunId?: string;
      /** User-facing label that distinguishes concurrent runs on the same adapter. */
      agentLabel?: string;
    }
  | {
      type: 'agent-event';
      role: AgentRole;
      taskId: string | null;
      assignment: RoleAssignment;
      /** Unique identity for this concrete agent process/invocation. */
      agentRunId?: string;
      /** User-facing label that distinguishes concurrent runs on the same adapter. */
      agentLabel?: string;
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
  | {
      type: 'review';
      taskId: string;
      approved: boolean;
      notes: string;
      criteria?: ReviewCriterion[];
    }
  | { type: 'replanned'; reason: ReplanReason; snapshot: PlanGraphSnapshot }
  | {
      type: 'knowledge-updated';
      wikiEntries: number;
      codegraphFiles: number | null;
      codegraph: CodeGraphStats | null;
    }
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
