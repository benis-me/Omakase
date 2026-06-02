/**
 * The orchestration hook surface. Each key is a hook point; its value type is
 * the payload handlers receive. The orchestrator emits these at well-defined
 * moments so downstream code can observe, augment, or (for `before*` hooks)
 * veto by throwing under `failureMode: 'throw'`.
 */
import type { AgentRunInput, AgentRunResult } from '@omakase/daemon';
import type { RoleAssignment } from '../modes/policy.js';
import type {
  PlanGraphSnapshot,
  ReplanReason,
  TaskNode,
  TaskStatus,
} from '../plan/plan-graph.js';
import type { RouteDecision } from '../router/router.js';
import type { AgentRole, FileChange, OrchestrationRequest } from '../types.js';
import type { HookBus } from './bus.js';

export interface OrchestrationHooks extends Record<string, unknown> {
  beforeRoute: { request: OrchestrationRequest };
  afterRoute: { request: OrchestrationRequest; decision: RouteDecision };
  beforeAgentRun: {
    role: AgentRole;
    assignment: RoleAssignment;
    input: AgentRunInput;
    task?: TaskNode;
  };
  afterAgentRun: {
    role: AgentRole;
    input: AgentRunInput;
    result: AgentRunResult;
    task?: TaskNode;
  };
  beforeFileChange: { change: FileChange };
  afterFileChange: { change: FileChange };
  beforeReplan: { reason: ReplanReason; snapshot: PlanGraphSnapshot };
  afterReplan: { reason: ReplanReason; snapshot: PlanGraphSnapshot };
  onTaskStatusChange: { task: TaskNode; from: TaskStatus; to: TaskStatus };
  onError: { error: unknown; phase: string };
}

export type OrchestrationHookBus = HookBus<OrchestrationHooks>;

export const HOOK_POINTS: readonly (keyof OrchestrationHooks)[] = [
  'beforeRoute',
  'afterRoute',
  'beforeAgentRun',
  'afterAgentRun',
  'beforeFileChange',
  'afterFileChange',
  'beforeReplan',
  'afterReplan',
  'onTaskStatusChange',
  'onError',
];
