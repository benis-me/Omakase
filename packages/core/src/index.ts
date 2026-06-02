// @omakase/core — orchestration core public entrypoint.
export const CORE_VERSION = '0.1.0';
export { DAEMON_VERSION } from '@omakase/daemon';

// ── Domain types ─────────────────────────────────────────────────────────────
export type { AgentRole, WorkMode, OrchestrationRequest, FileChange } from './types.js';
export { AGENT_ROLES } from './types.js';
export type { IdGenerator } from './ids.js';
export { createIdGenerator } from './ids.js';

// ── Plan graph & planner ─────────────────────────────────────────────────────
export { PlanGraph, TERMINAL_STATUSES } from './plan/plan-graph.js';
export type {
  TaskNode,
  TaskStatus,
  ReplanReason,
  TaskResult,
  NewTask,
  PlanGraphSnapshot,
  StatusChangeListener,
  PlanGraphOptions,
} from './plan/plan-graph.js';
export { RulePlanner, createAgentPlanner, splitGoals, extractJsonArray } from './plan/planner.js';
export type { Planner, PlanContext, AgentPlannerOptions } from './plan/planner.js';

// ── Router ───────────────────────────────────────────────────────────────────
export { RuleRouter, createAgentRouter, parseRouteText } from './router/router.js';
export type {
  Router,
  RouteDecision,
  RouteKind,
  RuleRouterOptions,
  AgentRouterOptions,
} from './router/router.js';

// ── Work modes & model policy ────────────────────────────────────────────────
export { createModelPolicy, DEFAULT_AGENT_STRENGTH, BUILTIN_AGENT_ID } from './modes/policy.js';
export type {
  ModelPolicy,
  RoleAssignment,
  SelectionContext,
  CustomModeConfig,
  CustomRoleConfig,
  ModelPolicyOptions,
} from './modes/policy.js';

// ── Hooks ────────────────────────────────────────────────────────────────────
export { HookBus } from './hooks/bus.js';
export type { HookHandler, HookHandle, HookFailureMode, EmitOptions } from './hooks/bus.js';
export { HOOK_POINTS } from './hooks/types.js';
export type { OrchestrationHooks, OrchestrationHookBus } from './hooks/types.js';

// ── Knowledge: wiki + codegraph ──────────────────────────────────────────────
export { ProjectWiki } from './knowledge/wiki.js';
export type {
  WikiEntry,
  WikiEntryKind,
  WikiSnapshot,
  WikiInput,
  ProjectWikiOptions,
} from './knowledge/wiki.js';
export { CodeGraph } from './knowledge/codegraph.js';
export type {
  CodeNode,
  CodeSymbol,
  ImportEdge,
  CodeLanguage,
  SymbolKind,
  CodeGraphSnapshot,
  ScanOptions,
} from './knowledge/codegraph.js';
