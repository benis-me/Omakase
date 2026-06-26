import type { AgentRunResult, AgentToolCall, TokenUsage } from '@omakase/daemon';
import type { AgentRole, OrchestrationRequest } from '../../types.js';
import type { RunStatus } from '../../run-events.js';

export type WorkflowScriptRuntime = 'bun' | 'memory';

export interface WorkflowScriptArtifact {
  id: string;
  path: string;
  source: string;
  runtime: WorkflowScriptRuntime;
  createdAt: number;
  generatedByAgentId?: string;
  prompt?: string;
}

export type WorkflowPhaseStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type WorkflowAgentStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkflowPhaseSnapshot {
  id: string;
  name: string;
  status: WorkflowPhaseStatus;
  startedAt: number;
  finishedAt: number | null;
  agentRunIds: string[];
  error: string | null;
}

export interface WorkflowAgentSnapshot {
  taskId: string;
  agentRunId: string;
  agentLabel: string;
  agentId: string;
  role: AgentRole;
  title: string;
  prompt: string;
  phaseId: string | null;
  phaseName: string | null;
  status: WorkflowAgentStatus;
  startedAt: number;
  finishedAt: number | null;
  tokens: number;
  toolCount: number;
  model: string | null;
  error: string | null;
}

export interface WorkflowCheckpoint {
  id: string;
  label: string;
  data: unknown;
  at: number;
}

export interface DynamicWorkflowSnapshot {
  id: string;
  script: WorkflowScriptArtifact;
  request: OrchestrationRequest;
  status: RunStatus;
  phases: WorkflowPhaseSnapshot[];
  agents: WorkflowAgentSnapshot[];
  checkpoints: WorkflowCheckpoint[];
  maxConcurrency: number;
  maxAgents: number;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface DynamicWorkflowAgentInput {
  role?: AgentRole;
  title: string;
  prompt: string;
  agentId?: string;
  model?: string | null;
  reasoning?: string | null;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface DynamicWorkflowAgentResult {
  taskId: string;
  agentRunId: string;
  agentLabel: string;
  agentId: string;
  role: AgentRole;
  title: string;
  text: string;
  thinking: string;
  toolCalls: AgentToolCall[];
  usage: TokenUsage | null;
  tokens: number;
  costUsd: number | null;
  status: AgentRunResult['status'];
  error: string | null;
  model: string | null;
}

export interface DynamicWorkflowReportInput {
  title: string;
  reason: string;
  summary: string;
  markdown?: string;
  kind?: 'planning' | 'review' | 'milestone';
  taskId?: string | null;
}

export interface DynamicWorkflowWikiInput {
  kind: 'fact' | 'decision' | 'risk' | 'progress' | 'report' | 'synthesis';
  title: string;
  body: string;
  taskId?: string;
  authorAgentId?: string;
}

export interface DynamicWorkflowCheckpointInput {
  label: string;
  data?: unknown;
}

/** Remaining sub-agent budget for the run (agents are the bounded resource). */
export interface DynamicWorkflowBudget {
  total: number;
  spent: number;
  remaining: number;
}

export interface DynamicWorkflowLoopOptions {
  /** Hard cap on rounds — every loop is bounded (default 10). */
  maxRounds?: number;
  /** Return true to STOP. When omitted, the loop stops when a round comes back
   * "dry" (falsy, an empty array, or 0) — the loop-until-dry idiom. */
  until?: (result: unknown, round: number) => boolean | Promise<boolean>;
}

export interface DynamicWorkflowApi {
  phase<T>(name: string, fn: (workflow: DynamicWorkflowApi) => Promise<T> | T): Promise<T>;
  parallel<T>(items: Array<Promise<T> | (() => Promise<T> | T)>): Promise<T[]>;
  /**
   * Run each item through all stages independently — no barrier between stages,
   * so item A can be in stage 3 while item B is still in stage 1. Each stage
   * receives `(prevResult, originalItem, index)`.
   */
  pipeline<T = unknown>(
    items: readonly T[],
    ...stages: Array<(value: unknown, item: T, index: number) => unknown | Promise<unknown>>
  ): Promise<unknown[]>;
  /** Bounded loop-until: repeat `fn(round)` until `until` says stop (or it comes
   * back dry), capped by {@link DynamicWorkflowLoopOptions.maxRounds}. */
  loopUntil(
    fn: (round: number) => unknown | Promise<unknown>,
    options?: DynamicWorkflowLoopOptions,
  ): Promise<unknown[]>;
  /** Remaining sub-agent budget, for scaling loop depth to what's left.
   * Async because the Bun runtime answers it over IPC. */
  budget(): Promise<DynamicWorkflowBudget>;
  agent(input: DynamicWorkflowAgentInput): Promise<DynamicWorkflowAgentResult>;
  requestReport(input: DynamicWorkflowReportInput): Promise<void>;
  updateWiki(input: DynamicWorkflowWikiInput): Promise<void>;
  checkpoint(input: DynamicWorkflowCheckpointInput | string): Promise<WorkflowCheckpoint>;
  log(message: string): Promise<WorkflowCheckpoint>;
}

export interface DynamicWorkflowHostApi extends DynamicWorkflowApi {
  beginPhase(name: string): Promise<WorkflowPhaseSnapshot>;
  finishPhase(phaseId: string, status: WorkflowPhaseStatus, error?: string): Promise<void>;
  finish(status: RunStatus, summary?: string): Promise<void>;
}

export interface WorkflowScriptRunnerInput {
  script: WorkflowScriptArtifact;
  api: DynamicWorkflowHostApi;
  signal?: AbortSignal;
}

export interface WorkflowScriptRunner {
  run(input: WorkflowScriptRunnerInput): Promise<void>;
}
