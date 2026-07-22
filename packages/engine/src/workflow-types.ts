// The workflow-authoring surface: what a Dynamic Workflow's default-exported
// function receives as `w`. This is the stable contract workflow authors code
// against (mirrors the API documented in .omks/workflows/*.ts).

import type { Goal, BudgetSnapshot, PermissionMode } from '@omakase/core';

export interface AgentSpec {
  /** What this one agent may do, overriding the run's mode. */
  permission?: PermissionMode;
  /** Semantic role: planner | worker | reviewer | validator | ... (free-form). */
  role?: string;
  /** Short human title shown in the UI (e.g. "Build: auth"). */
  title: string;
  /** The task prompt for the agent. */
  prompt: string;
  /** Pin a provider id (else the run's default / auto-selection). */
  provider?: string;
  /** Pin a model. */
  model?: string;
  /** Override the system/role prompt. */
  systemPrompt?: string;
  /** Resume a prior provider session for continuity. */
  resumeSessionId?: string;
  /** Run this agent in a specific directory (absolute, or relative to the run
   *  cwd). Use with w.subdir(...) to isolate parallel agents from each other. */
  cwd?: string;
  /** Adopt a named definition from `.omks/agents/` — its provider, model,
   *  permission, isolation and guidance become the defaults for this call. */
  as?: string;
  /** Give this agent its own working copy (a git worktree, merged back when it
   *  finishes) instead of the shared tree. The way to keep parallel writers
   *  from editing the same files. */
  isolate?: boolean;
  /** Extra system-prompt guidance, contributed by a definition. */
  guidance?: string;
  /**
   * Provenance supplied by a dynamic orchestrator. The agent receives `prompt`;
   * crystallisation keeps `sourcePrompt` plus the dependency ids so runtime
   * output is wired back in on the next run instead of pasted into source.
   * Ordinary hand-written workflows do not need to set this.
   */
  workflowStep?: {
    id: string;
    dependsOn?: string[];
    sourcePrompt: string;
  };
}

export interface AgentResult {
  text: string;
  status: 'ok' | 'error';
  /** Native provider session id, usable as resumeSessionId later. */
  sessionId: string | null;
  provider: string;
  tokens: number;
  costUsd: number;
}

export interface ReportSpec {
  title: string;
  summary: string;
  kind?: 'progress' | 'final' | 'error' | 'knowledge' | 'review';
  reason?: string;
  taskId?: string;
}

export interface WikiSpec {
  slug?: string;
  title: string;
  body: string;
}

/** A pipeline stage: receives the previous result, the original item, its index. */
export type PipelineStage<In = unknown, Out = unknown> = (
  prev: In,
  item: unknown,
  index: number,
) => Promise<Out> | Out;

/**
 * `w` — the workflow orchestration handle. Deterministic: the same workflow with
 * the same inputs issues agent() calls in the same order, which is what makes
 * resume (cached replay) work.
 */
export interface WorkflowContext {
  /** The goal driving this run. */
  readonly goal: Goal;
  /** Working directory all agents operate in. */
  readonly cwd: string;
  /** Free-form parameters passed to the workflow. */
  readonly params: Record<string, unknown>;
  /** Available provider ids (for routing steps to specific agents). */
  /** Names of the agent definitions in `.omks/agents/` (usable as `agent({ as })`). */
  readonly agentNames: string[];
  readonly providers: string[];
  /** Abort signal — respect it in long loops. */
  readonly signal: AbortSignal;

  /** Run one agent turn. Returns its text + status (+ session for resume). */
  agent(spec: AgentSpec): Promise<AgentResult>;
  /** Low-level: run a prompt on a named provider with role "worker". */
  spawn(provider: string, prompt: string, title?: string): Promise<AgentResult>;

  /** Ensure and return an absolute isolated working directory under the run
   *  cwd (e.g. `w.subdir('feature-a')`). Pass its name as `agent({cwd})` so
   *  concurrent agents don't edit the same files. */
  subdir(name: string): string;

  /** Run `fn` in an isolated git worktree (when the run cwd is a git repo),
   *  then commit and merge its changes back into the base. `fn` receives the
   *  isolated absolute cwd — pass it to `agent({cwd})`. Merges are serialized;
   *  conflicts are left on a branch. Outside a git repo this is a no-op that
   *  runs `fn` against the run cwd. */
  isolate<T>(label: string, fn: (cwd: string) => Promise<T> | T): Promise<T>;

  /** Group work under a named phase (shown in the UI, recorded as events). */
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /** Run thunks concurrently (bounded), awaiting all (a barrier). */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;

  /** Run each item through all stages independently — no barrier between stages. */
  pipeline(items: unknown[], ...stages: PipelineStage[]): Promise<unknown[]>;

  /**
   * Loop until `fn` returns an empty array / falsy, or `maxRounds` is reached.
   * `fn(round)` returns the remaining work items (non-empty => loop again).
   */
  loopUntil(
    fn: (round: number) => Promise<unknown[] | void> | unknown[] | void,
    opts?: { maxRounds?: number },
  ): Promise<void>;

  /** Current budget snapshot (remaining agent calls, spend). */
  budget(): BudgetSnapshot;

  /** Emit a progress log line. */
  log(message: string): void;

  /** Record a report (progress / final / knowledge / review). */
  requestReport(spec: ReportSpec): void;

  /** Upsert a wiki page (accumulated project knowledge). */
  updateWiki(spec: WikiSpec): void;

  /** Recall accumulated workspace knowledge (most-recent wiki entries first).
   *  This is how a workspace gets stronger over time — workflows learn from
   *  what earlier runs recorded. */
  recall(limit?: number): { title: string; body: string }[];

  /** Evaluate the goal's success criteria now. */
  goalMet(): Promise<{ met: boolean; gaps: string[] }>;

  /** Ask the user a question and await their answer (human-in-the-loop).
   *  Headless runs without an answerer fall back to `default`/first option.
   *  Answers are journaled and replayed on resume. */
  ask(question: string, opts?: { options?: string[]; default?: string }): Promise<string>;
}

/** A request passed to the host's answerer (CLI stdin, TUI prompt, ...). */
export interface AskRequest {
  question: string;
  options?: string[];
  default?: string;
}
export type Answerer = (req: AskRequest) => Promise<string>;

export type WorkflowFn = (w: WorkflowContext) => Promise<void>;
