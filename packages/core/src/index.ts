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
export { CodeGraph, loadTsconfigAliases } from './knowledge/codegraph.js';
export type {
  CodeNode,
  CodeSymbol,
  ImportEdge,
  CodeLanguage,
  SymbolKind,
  CodeGraphSnapshot,
  CodeGraphStats,
  CodeGraphSummary,
  CodeGraphHotspot,
  CodeGraphExternalDependency,
  CodeSymbolReference,
  ScanOptions,
} from './knowledge/codegraph.js';
export { createCodeGraphWatcher } from './knowledge/watch.js';
export type { CodeGraphWatcher, CodeGraphWatchOptions } from './knowledge/watch.js';
export { FileKnowledgeStore, projectKnowledgeStore } from './knowledge/store.js';
export type { KnowledgeStore } from './knowledge/store.js';

// ── Inbox, supervisor, run events ────────────────────────────────────────────
export { Inbox } from './inbox.js';
export type { InboxItem, InboxItemKind, InboxAppendOptions, InboxOptions } from './inbox.js';
export { MemoryRunStore, FileRunStore, isValidRunRecord } from './supervisor/run-store.js';
export type { RunStore, RunRecord } from './supervisor/run-store.js';
// ── Sessions ──────────────────────────────────────────────────────────────
export { MemorySessionStore, FileSessionStore, isValidSession } from './session/store.js';
export type { Session, SessionStore } from './session/store.js';
export { Supervisor, RESUMABLE_STATUSES } from './supervisor/supervisor.js';
export type { SupervisorOptions, SupervisorHealth, SupervisorState } from './supervisor/supervisor.js';
export {
  FakeControlSource,
  FileControlSource,
  writeControl,
  isValidControlCommand,
} from './supervisor/control.js';
export type { ControlSource, ControlCommand, ControlCommandKind, ControlPoll } from './supervisor/control.js';
export type {
  OrchestratorEvent,
  OrchestratorEventType,
  RunStatus,
  ReviewCriterion,
  AcceptanceSnapshot,
  InboxItemSnapshot,
} from './run-events.js';

// ── Long-running run state ──────────────────────────────────────────────────
export {
  acceptanceProgress,
  applyStructuredReview,
  createAcceptanceCriteria,
} from './acceptance.js';
export type {
  AcceptanceCriterion,
  AcceptanceEvidence,
  AcceptanceProgress,
  AcceptanceSource,
  AcceptanceStatus,
  CreateAcceptanceInput,
} from './acceptance.js';
export { createIteration, finishIteration } from './iterations.js';
export type { IterationSnapshot, IterationStatus } from './iterations.js';
export { detectRateLimit, parseResetTime, RATE_LIMIT_DEFAULT_BACKOFF_MS } from './rate-limit.js';
export type { RateLimitInfo } from './rate-limit.js';
export { parseCuratedKnowledge } from './knowledge/curation.js';
export type { CuratedEntry } from './knowledge/curation.js';
export { retrieveRelevant, scoreEntry, tokenize, extractEntities } from './knowledge/retrieval.js';
export { answerRiskGate, createRiskGate } from './risk-gates.js';
export type { RiskGateReason, RiskGateSnapshot, RiskGateStatus } from './risk-gates.js';
export { cleanAgentArtifactText, createReportArtifact } from './reports.js';
export type { ReportArtifact, ReportKind } from './reports.js';
export { buildValidationPrompt, parseValidationVerdict } from './validation.js';
export type { ValidationVerdict } from './validation.js';
export {
  createKnowledgeEvent,
  knowledgeEventToWikiEntry,
  renderKnowledgeEventsMarkdown,
} from './knowledge/events.js';
export type { KnowledgeEvent, KnowledgeEventKind } from './knowledge/events.js';
export { buildWikiPages, renderWikiPagesMarkdown } from './knowledge/pages.js';
export type { WikiPage, WikiPageId, WikiPageSourceKind } from './knowledge/pages.js';

// ── Orchestrator ─────────────────────────────────────────────────────────────
export { Orchestrator, parseReview, parseStructuredReview } from './orchestrator.js';
export type {
  OrchestratorOptions,
  RunHandle,
  RunResult,
  RunBudget,
  RunVerifier,
  AuthoredSpecCriteria,
  StructuredReview,
} from './orchestrator.js';

// ── Workflows: spec-driven + TDD ─────────────────────────────────────────────
export { SpecWorkflow, SPEC_PHASES } from './workflows/spec.js';
export type { SpecPhase, SpecState, SpecTransition, SpecWorkflowOptions } from './workflows/spec.js';
export { TddLoop } from './workflows/tdd.js';
export type { TddPhase, TddState, TestRun, TddOptions } from './workflows/tdd.js';
export {
  BunWorkflowScriptRunner,
  DynamicWorkflowRun,
  MemoryWorkflowScriptRunner,
  WorkflowScriptValidationError,
  validateWorkflowScriptSource,
} from './workflows/dynamic/index.js';
export type {
  DynamicWorkflowAgentInput,
  DynamicWorkflowAgentResult,
  DynamicWorkflowApi,
  DynamicWorkflowCheckpointInput,
  DynamicWorkflowHandle,
  DynamicWorkflowHostApi,
  DynamicWorkflowReportInput,
  DynamicWorkflowRunOptions,
  DynamicWorkflowRunResult,
  DynamicWorkflowSnapshot,
  DynamicWorkflowWikiInput,
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowCheckpoint,
  WorkflowPhaseSnapshot,
  WorkflowPhaseStatus,
  WorkflowScriptArtifact,
  WorkflowScriptRunner,
  WorkflowScriptRunnerInput,
  WorkflowScriptRuntime,
} from './workflows/dynamic/index.js';

// ── Self-improvement ─────────────────────────────────────────────────────────
export {
  createGitRunner,
  readGitStatus,
  assertSafeWorkspace,
  WorkspaceDirtyError,
  buildSelfImproveRequest,
  summarizeChanges,
  prepareSelfImprovement,
  SELF_IMPROVE_PHASES,
} from './self-improve.js';
export type {
  GitStatus,
  GitRunner,
  SelfImproveGuardOptions,
  SelfImprovePhase,
  PrepareSelfImprovementOptions,
} from './self-improve.js';
