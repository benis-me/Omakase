// Core domain types for Omakase.
//
// Omakase runs Dynamic Workflows that orchestrate multiple installed agent CLIs
// to achieve a Goal. Everything that happens in a run is captured as an
// append-only event log (see RunEvent) so runs can be replayed, resumed and
// inspected. This module is the shared vocabulary for the whole system.

/** Opaque identifiers. Plain strings, named for readability. */
export type RunId = string;
export type SessionId = string;
export type TaskId = string;
export type ReportId = string;
export type AgentCallId = string;
export type WorkspaceId = string;

/** Unix epoch milliseconds. */
export type Millis = number;

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/**
 * A machine-checkable success criterion. The goal-loop's verifier evaluates
 * these each round; the loop terminates as "succeeded" only when all pass.
 */
export type SuccessCriterion =
  | { kind: 'command'; run: string; expect?: 'exit0'; timeoutMs?: number; label?: string }
  | { kind: 'file'; path: string; exists?: boolean; matches?: string; label?: string }
  | { kind: 'rule'; pattern: string; inFiles?: string; label?: string }
  | { kind: 'judge'; rubric: string; label?: string };

/**
 * A Goal is what the user wants achieved. A run is one attempt to satisfy it.
 * `successCriteria` (natural language) is judged by an LLM; `checks` are
 * machine-verified. Together they drive the Goal-loop's termination.
 */
export interface Goal {
  /** Natural-language description of the desired outcome. */
  text: string;
  /** Optional explicit, judge-checked success criteria (one per item). */
  successCriteria?: string[];
  /** Optional machine-checkable criteria (command/file/rule/judge). */
  checks?: SuccessCriterion[];
  /** Workflow to run; defaults to the built-in "goal" workflow. */
  workflow?: string;
  /** Preferred provider id (e.g. "claude"); falls back to auto-selection. */
  provider?: string;
  /** Preferred model for the default provider. */
  model?: string;
  /** Working directory the agents operate in. */
  cwd?: string;
  /** Free-form parameters forwarded to the workflow. */
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type RunMode = 'goal' | 'workflow' | 'once';

export interface RunRecord {
  id: RunId;
  sessionId: SessionId | null;
  mode: RunMode;
  /** Workflow name being executed. */
  workflow: string;
  status: RunStatus;
  goal: Goal;
  title: string;
  summary: string | null;
  /** Agent-call budget accounting. */
  spentAgents: number;
  budgetAgents: number | null;
  spentTokens: number;
  spentCostUsd: number;
  /** Last event sequence written (for resume / SSE cursors). */
  lastSeq: number;
  /** Highest checkpoint sequence (safe resume point). */
  checkpointSeq: number;
  error: string | null;
  createdAt: Millis;
  updatedAt: Millis;
  /** Liveness heartbeat; stale => run was interrupted. */
  heartbeatAt: Millis;
  /** If rate-limited, epoch ms until which we should back off. */
  rateLimitedUntil: Millis | null;
}

// ---------------------------------------------------------------------------
// Event log (event sourcing)
// ---------------------------------------------------------------------------

/**
 * Every meaningful thing in a run is an event. Events are append-only and
 * strictly ordered by `seq` within a run. Resume replays them; the TUI streams
 * them. Payloads are typed by `RunEventPayloadMap`.
 */
export type RunEventType =
  | 'run:started'
  | 'run:ended'
  | 'run:paused'
  | 'run:resumed'
  | 'phase:started'
  | 'phase:ended'
  | 'agent:started'
  | 'agent:activity'
  | 'agent:completed'
  | 'agent:failed'
  | 'agent:retry'
  | 'task:created'
  | 'task:updated'
  | 'report'
  | 'wiki:updated'
  | 'checkpoint'
  | 'log'
  | 'goal:evaluated'
  | 'harness:switched'
  | 'user:asked'
  | 'user:answered';

export interface RunEvent<T extends RunEventType = RunEventType> {
  runId: RunId;
  seq: number;
  type: T;
  payload: RunEventPayloadMap[T];
  createdAt: Millis;
}

/** Discriminated union of all event shapes — narrows on `.type`. */
export type AnyRunEvent = { [K in RunEventType]: RunEvent<K> }[RunEventType];

/** Live activity emitted while an agent CLI is working (parsed from its stream). */
export interface AgentActivity {
  kind: 'text' | 'tool' | 'reasoning' | 'notice';
  /** Human one-liner, e.g. "Writing src/index.ts" or "Running bun test". */
  summary: string;
  /** Optional tool name for kind === 'tool'. */
  tool?: string;
  at: Millis;
}

export type GoalVerdict = 'met' | 'unmet' | 'partial' | 'unknown';

export interface RunEventPayloadMap {
  'run:started': { goal: Goal; workflow: string };
  'run:ended': { status: RunStatus; summary: string | null };
  'run:paused': { reason: string };
  'run:resumed': { fromSeq: number };
  'phase:started': { name: string; index: number };
  'phase:ended': { name: string; index: number };
  'agent:started': {
    callId: AgentCallId;
    stepKey: string;
    role: string;
    title: string;
    provider: string;
    model: string | null;
    prompt: string;
    attempt: number;
  };
  'agent:activity': { callId: AgentCallId; activity: AgentActivity };
  'agent:completed': {
    callId: AgentCallId;
    stepKey: string;
    text: string;
    status: 'ok' | 'error';
    providerSessionId: string | null;
    tokens: number;
    costUsd: number;
    durationMs: number;
  };
  'agent:failed': { callId: AgentCallId; stepKey: string; error: string; attempt: number };
  'agent:retry': { callId: AgentCallId; stepKey: string; attempt: number; delayMs: number; reason: string };
  'task:created': { task: TaskRecord };
  'task:updated': { id: TaskId; status: TaskStatus; attempts: number };
  report: { report: Report };
  'wiki:updated': { slug: string; title: string };
  checkpoint: { seq: number; label: string };
  log: { level: LogLevel; message: string };
  'goal:evaluated': { round: number; verdict: GoalVerdict; gaps: string[]; note: string };
  'harness:switched': { from: string; to: string; reason: string };
  'user:asked': { stepKey: string; question: string; options: string[] };
  'user:answered': { stepKey: string; answer: string };
}

// ---------------------------------------------------------------------------
// Tasks (DAG), reports, sessions, wiki
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'running' | 'blocked' | 'done' | 'failed' | 'skipped';

export interface TaskRecord {
  runId: RunId;
  id: TaskId;
  title: string;
  role: string;
  status: TaskStatus;
  attempts: number;
  dependsOn: TaskId[];
  createdAt: Millis;
  updatedAt: Millis;
}

export type ReportKind = 'progress' | 'final' | 'error' | 'knowledge' | 'review';

export interface Report {
  runId: RunId;
  id: ReportId;
  kind: ReportKind;
  title: string;
  summary: string;
  taskId: TaskId | null;
  authorAgentId: string | null;
  createdAt: Millis;
}

export interface SessionRecord {
  id: SessionId;
  title: string;
  runIds: RunId[];
  rollingSummary: string;
  cwd: string;
  createdAt: Millis;
  updatedAt: Millis;
}

export interface WikiEntry {
  slug: string;
  title: string;
  body: string;
  updatedAt: Millis;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface WorkspaceConfig {
  id: WorkspaceId;
  name: string;
  createdAt: Millis;
  updatedAt: Millis;
  /** Additional project roots the agents may touch. */
  projectRoots: string[];
  settings: WorkspaceSettings;
}

export interface WorkspaceSettings {
  /** Default provider id when a goal/workflow doesn't specify one. */
  defaultProvider?: string;
  /** Default model for the default provider. */
  defaultModel?: string;
  /** Max agent calls per run (budget). */
  maxAgentsPerRun?: number;
  /** Ordered provider preference for auto-selection / fallback. */
  providerPreference?: string[];
  /** How much an agent is allowed to do without asking. */
  permission?: PermissionMode;
  /** @deprecated Superseded by `permission`; still honoured when it is unset. */
  autoApprove?: boolean;
}

/**
 * What an agent may do. Orthogonal to which provider runs it: each adapter
 * expresses these in its own native flags, and a provider that cannot express
 * one refuses the run rather than quietly granting more.
 *
 * - `read-only` — may inspect, may not modify.
 * - `edit`      — may change the working directory without per-action approval.
 * - `bypass`    — skips approval entirely, sandbox included.
 */
export type PermissionMode = 'read-only' | 'edit' | 'bypass';

export const PERMISSION_MODES: PermissionMode[] = ['read-only', 'edit', 'bypass'];

/**
 * The mode a run should use. `permission` wins; otherwise the older
 * `autoApprove` boolean is honoured so existing workspaces keep behaving
 * exactly as they did.
 */
export function resolvePermission(settings: { permission?: PermissionMode; autoApprove?: boolean }): PermissionMode {
  if (settings.permission) return settings.permission;
  return settings.autoApprove === false ? 'read-only' : 'bypass';
}
