/**
 * The orchestrator runs the Ralph loop:
 *
 *   router → planner → workers → reviewer → replan → continue/finish
 *
 * `start()` returns a {@link RunHandle} that streams {@link OrchestratorEvent}s,
 * resolves with a {@link RunResult}, and exposes pause/resume/cancel plus
 * `appendUserInput` for mid-run requirements. State is checkpointed to a
 * {@link RunStore} after every task, so `resume()` can pick a crashed run back up.
 */
import {
  createResultAccumulator,
  createPushStream,
  errorMessage,
  renderSkillContext,
  selectSkillsForPrompt,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRuntime,
  type DetectedAgent,
  type DetectionOptions,
  type SkillInfo,
} from '@omakase/daemon';
import { HookBus } from './hooks/bus.js';
import type { OrchestrationHookBus } from './hooks/types.js';
import { createIdGenerator, createUniqueRunIdGenerator, type IdGenerator } from './ids.js';
import { CodeGraph } from './knowledge/codegraph.js';
import { ProjectWiki } from './knowledge/wiki.js';
import type { KnowledgeStore } from './knowledge/store.js';
import {
  acceptanceProgress,
  applyStructuredReview,
  createAcceptanceCriteria,
  type AcceptanceSource,
  type AcceptanceCriterion,
} from './acceptance.js';
import { createIteration, finishIteration, type IterationSnapshot } from './iterations.js';
import { answerRiskGate, createRiskGate, type RiskGateSnapshot } from './risk-gates.js';
import { cleanAgentArtifactText, createReportArtifact, type ReportArtifact, type ReportKind } from './reports.js';
import { buildValidationPrompt, parseValidationVerdict } from './validation.js';
import {
  createKnowledgeEvent,
  knowledgeEventToWikiEntry,
  type KnowledgeEvent,
} from './knowledge/events.js';
import { BUILTIN_AGENT_ID, createModelPolicy, type ModelPolicy } from './modes/policy.js';
import { Inbox, type InboxAppendOptions } from './inbox.js';
import {
  PlanGraph,
  type ReplanReason,
  type TaskNode,
} from './plan/plan-graph.js';
import { RulePlanner, extractJsonArray, tagsFromAgentPlanTask, type Planner } from './plan/planner.js';
import { RuleRouter, createAgentRouter, type RouteDecision, type Router } from './router/router.js';
import { MemoryRunStore } from './supervisor/run-store.js';
import type { RunRecord, RunStore } from './supervisor/run-store.js';
import type { ControlPoll, ControlSource } from './supervisor/control.js';
import type {
  AcceptanceSnapshot,
  InboxItemSnapshot,
  OrchestratorEvent,
  ReviewCriterion,
  RunStatus,
  StrategyNextAction,
  StrategyUpdateReason,
} from './run-events.js';
import type { AgentRole, OrchestrationRequest, WorkMode } from './types.js';

export interface RunBudget {
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface RunResult {
  id: string;
  status: RunStatus;
  summary: string;
  plan: RunRecord['plan'];
  wiki: RunRecord['wiki'];
  acceptance: AcceptanceSnapshot;
  iterations: IterationSnapshot[];
  riskGates: RiskGateSnapshot[];
  reports: ReportArtifact[];
  knowledgeEvents: KnowledgeEvent[];
  events: OrchestratorEvent[];
  spentTokens: number;
  spentCostUsd: number;
}

export interface RunHandle {
  readonly id: string;
  readonly events: AsyncIterable<OrchestratorEvent>;
  readonly result: Promise<RunResult>;
  pause(): void;
  resume(): void;
  cancel(): void;
  appendUserInput(text: string, options?: InboxAppendOptions): void;
}

export interface OrchestratorOptions {
  runtime: AgentRuntime;
  router?: Router;
  planner?: Planner;
  policy?: ModelPolicy;
  policyFor?: (mode: WorkMode) => ModelPolicy;
  hooks?: OrchestrationHookBus;
  store?: RunStore;
  /** Persists wiki/codegraph across runs (e.g. under `<cwd>/.omakase`). */
  knowledgeStore?: KnowledgeStore;
  skills?: SkillInfo[];
  codegraph?: CodeGraph;
  idGenerator?: IdGenerator;
  clock?: () => number;
  /**
   * Coalesce mid-task progress checkpoints (the per-agent-event saves that drive
   * live streaming in file-backed clients) to at most one per this many ms. `0`
   * (default) saves on every event — exact, but a write storm for long real
   * runs. The daemon sets ~120ms so streaming stays smooth without thrashing disk.
   */
  streamFlushMs?: number;
  detectionOptions?: DetectionOptions;
  maxIterations?: number;
  maxAttemptsPerTask?: number;
  /** Max independent ready tasks executed concurrently per iteration (default 4). */
  maxConcurrency?: number;
  /** Soft token/cost ceiling: stop scheduling new tasks once exceeded. */
  budget?: RunBudget;
  defaultMode?: WorkMode;
  /**
   * Cross-process control: a source of pending pause/resume/stop/input commands
   * for this run, consulted inside the run loop so a detached supervisor can be
   * steered from another process (see {@link ControlSource}).
   */
  control?: ControlSource;
  /** Registers the recurring poll that re-checks {@link control}; see {@link ControlPoll}. */
  controlPoll?: ControlPoll;
  /**
   * Run an independent VALIDATOR at the finish line: when the run would otherwise
   * succeed, a validator agent judges the work against the acceptance criteria and,
   * if it finds gaps, injects fix-tasks and re-runs the loop (bounded by
   * {@link maxValidationRounds}). Off by default — set true for spec/mission runs.
   * Falls back to a no-op when no real validator agent is available (e.g. offline).
   */
  validate?: boolean;
  /** Max validate → fix → re-loop rounds before finishing anyway (default 2). */
  maxValidationRounds?: number;
  /**
   * Closed-loop verification: a real, deterministic check (run the test/build
   * command) used as a HARD gate at the finish line, ahead of the LLM validator.
   * When it fails, its output becomes a fix-task and the loop re-runs (bounded by
   * {@link maxValidationRounds}). This is the "verification is the differentiator"
   * upgrade — objective pass/fail, not agent self-assessment. Omit to skip.
   */
  verifier?: RunVerifier;
  /**
   * Closes the loop on agent self-authored specs. When a run authors a spec
   * mid-flight (e.g. a spec-less prompt where the agent writes `.omks/specs/*.md`),
   * this returns that spec's acceptance criteria so the loop adopts and verifies
   * against them — instead of trusting the worker's own "done". The implementer
   * (RunHost / CLI) reads the workspace and returns criteria from specs authored
   * during this run. Omit to skip (the run keeps its prior, looser acceptance).
   */
  authoredSpecCriteria?: AuthoredSpecCriteria;
}

/** A deterministic finish-line check — typically running the workspace's tests. */
export type RunVerifier = () => Promise<{ passed: boolean; summary: string }>;

/** Returns acceptance criteria from specs the agent authored during the run. */
export type AuthoredSpecCriteria = (cwd: string) => string[] | Promise<string[]>;

const REVIEW_REJECTS =
  /\b(reject|rejected|needs work|needs more|incomplete|not done|insufficient|revise|fail(?:ed|s)?)\b/;
const REVIEW_APPROVES =
  /\b(approve|approved|lgtm|looks good|pass(?:ed|es)?|complete|all good|done)\b/;

function isUncertainReviewText(text: string): boolean {
  const lower = text.toLowerCase();
  return text.trim().length > 0 && !REVIEW_REJECTS.test(lower) && !REVIEW_APPROVES.test(lower);
}

/** Parse a reviewer's free-form verdict. */
export function parseReview(text: string): { approved: boolean; notes: string } {
  const lower = text.toLowerCase();
  const rejects = REVIEW_REJECTS.test(lower);
  const approves = REVIEW_APPROVES.test(lower);
  const notes = text.trim();
  // Blank/no verdict is not an approval — a real reviewer always says something.
  if (notes.length === 0) return { approved: false, notes };
  if (rejects && !approves) return { approved: false, notes };
  if (approves && !rejects) return { approved: true, notes };
  // Ambiguous non-empty text: default to approve to avoid livelock, unless an
  // explicit reject term appears.
  return { approved: !rejects, notes };
}

export interface StructuredReview {
  approved: boolean;
  criteria: ReviewCriterion[];
  notes: string;
  reportRequests?: AgentReportRequest[];
}

export interface AgentReportRequest {
  title: string;
  reason: string;
  summary: string;
  markdown?: string;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const arrayStart = text.indexOf('[');
  if (arrayStart !== -1 && arrayStart < start) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function cleanAgentReportRequestText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.slice(0, max);
}

function agentReportRequestsFromObject(obj: Record<string, unknown> | null): AgentReportRequest[] {
  if (!obj || !Array.isArray(obj.reportRequests)) return [];
  const requests: AgentReportRequest[] = [];
  for (const raw of obj.reportRequests) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const title = cleanAgentReportRequestText(item.title, 96);
    const reason = cleanAgentReportRequestText(item.reason, 96);
    if (!title || !reason) continue;
    const summary =
      cleanAgentReportRequestText(item.summary, 500) ??
      cleanAgentReportRequestText(item.body, 500) ??
      `${title}: ${reason}`;
    const markdown = typeof item.markdown === 'string' && item.markdown.trim() ? item.markdown.trim().slice(0, 4000) : null;
    requests.push({
      title,
      reason,
      summary,
      ...(markdown ? { markdown } : {}),
    });
    if (requests.length >= 5) break;
  }
  return requests;
}

function hasStructuredReviewVerdict(text: string): boolean {
  const obj = extractJsonObject(text);
  if (Array.isArray(obj?.criteria)) return true;
  return !obj && Boolean(extractJsonArray(text));
}

/**
 * Parse a reviewer's per-criterion verdict. Expects a JSON array (same order as
 * `criteria`) of `{ met: boolean, note?: string }`, or a JSON object wrapper
 * `{ criteria: [...], reportRequests?: [...] }`. Approved iff every criterion is
 * met. Falls back to {@link parseReview} (applying the overall verdict to all
 * criteria) when the JSON can't be parsed.
 */
export function parseStructuredReview(text: string, criteria: string[]): StructuredReview {
  const obj = extractJsonObject(text);
  const arr = Array.isArray(obj?.criteria) ? obj.criteria : obj ? null : extractJsonArray(text);
  const reportRequests = agentReportRequestsFromObject(obj);
  if (arr && arr.length > 0) {
    const results: ReviewCriterion[] = criteria.map((criterion, i) => {
      const entry = arr[i] as { met?: unknown; note?: unknown } | undefined;
      const met = entry?.met === true;
      return {
        criterion,
        met,
        ...(typeof entry?.note === 'string' ? { note: entry.note } : {}),
      };
    });
    return {
      approved: results.length > 0 && results.every((r) => r.met),
      criteria: results,
      notes: text.trim(),
      ...(reportRequests.length > 0 ? { reportRequests } : {}),
    };
  }
  const fallback = parseReview(text);
  return {
    approved: fallback.approved,
    criteria: criteria.map((criterion) => ({ criterion, met: fallback.approved })),
    notes: fallback.notes,
    ...(reportRequests.length > 0 ? { reportRequests } : {}),
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function usageTokens(usage: AgentRunResult['usage']): number {
  if (!usage) return 0;
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function summarizeMarkdown(markdown: string, fallback: string): string {
  const line = markdown
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith('#'));
  return (line ?? fallback).slice(0, 300);
}

function boundedReviewExcerpt(text: string, limit = 6000): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n[...truncated ${text.length - limit} chars...]\n\n${text.slice(-tail)}`;
}

class RunController implements RunHandle {
  readonly id: string;
  readonly result: Promise<RunResult>;

  private readonly request: OrchestrationRequest;
  private readonly mode: WorkMode;
  private readonly runtime: AgentRuntime;
  private readonly router: Router;
  private readonly planner: Planner;
  private readonly defaultPlanner: boolean;
  private readonly policy: ModelPolicy;
  private readonly hooks: OrchestrationHookBus;
  private readonly store: RunStore;
  private readonly skills: SkillInfo[];
  private codegraph: CodeGraph | undefined;
  private readonly knowledgeStore: KnowledgeStore | undefined;
  private readonly ids: IdGenerator;
  private readonly clock: () => number;
  private readonly detectionOptions: DetectionOptions | undefined;
  private readonly maxIterations: number;
  private readonly validateEnabled: boolean;
  private readonly maxValidationRounds: number;
  private readonly verifier?: RunVerifier;
  private readonly authoredSpecCriteria?: AuthoredSpecCriteria;
  /** Set once we adopt criteria from a spec the agent authored this run, so the
   * finish-line gate runs and the run is held to that spec (not implicitly passed). */
  private adoptedSpec = false;
  /** Set when closed-loop verification never passed within maxValidationRounds —
   * the run did its tasks but its objective check is still red, so it isn't a
   * true success. */
  private verificationFailed = false;
  private readonly maxAttempts: number;
  private readonly maxConcurrency: number;
  private readonly budget: RunBudget | undefined;
  private spentTokens = 0;
  private spentCostUsd = 0;
  private budgetExhausted = false;
  private readonly hasUserAcceptanceCriteria: boolean;

  private readonly stream = createPushStream<OrchestratorEvent>();
  private readonly eventLog: OrchestratorEvent[] = [];
  private readonly supportWork = new Set<Promise<void>>();
  private readonly requestedReportKeys = new Set<string>();
  private pendingPlannerReportRequests: AgentReportRequest[] = [];
  private readonly inbox: Inbox;
  private wiki: ProjectWiki;
  private acceptance: AcceptanceSnapshot = { criteria: [], progress: { passed: 0, total: 0, complete: false } };
  private iterations: IterationSnapshot[] = [];
  private riskGates: RiskGateSnapshot[] = [];
  private reports: ReportArtifact[] = [];
  private knowledgeEvents: KnowledgeEvent[] = [];
  private gateWaiter: Deferred | null = null;
  private uncertainReviewCount = 0;
  private graph: PlanGraph;
  private routeDecision: RouteDecision | undefined;
  private available: DetectedAgent[] = [];

  private status: RunStatus = 'pending';
  private finished = false;
  private paused = false;
  private cancelled = false;
  private pauseGate: Deferred | null = null;
  private readonly activeAborts = new Set<AbortController>();
  private checkpointSeq = 0;
  private readonly streamFlushMs: number;
  private progressDirty = false;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressFlush = 0;
  private readonly createdAt: number;
  private readonly resuming: boolean;
  private readonly control: ControlSource | undefined;
  private readonly controlPoll: ControlPoll | undefined;
  private lastControlSeq = 0;
  private controlInFlight = false;
  private controlDisposer: (() => void) | undefined;

  get events(): AsyncIterable<OrchestratorEvent> {
    return this.stream.iterable;
  }

  constructor(
    options: OrchestratorOptions,
    request: OrchestrationRequest,
    resumeFrom?: RunRecord,
    runId?: string,
  ) {
    this.request = request;
    this.runtime = options.runtime;
    this.mode = resumeFrom?.mode ?? request.mode ?? options.defaultMode ?? 'normal';
    // Default to AGENT-driven routing (the policy's router-role agent classifies
    // the request), not a rule heuristic — falling back to rules when offline
    // (built-in agent) or when the agent's answer can't be parsed. Inject an
    // explicit `router` (e.g. new RuleRouter()) to override.
    this.router = options.router ?? this.makeAgentRouter();
    this.defaultPlanner = !options.planner;
    this.planner = options.planner ?? new RulePlanner();
    // A per-request agent override (e.g. picked in the TUI) wins over the
    // configured policy, so a single task can be pinned to a chosen agent
    // without reconfiguring the daemon.
    const reqAgent =
      typeof request.metadata?.agentOverride === 'string' && request.metadata.agentOverride
        ? request.metadata.agentOverride
        : undefined;
    this.policy = reqAgent
      ? createModelPolicy('custom', { custom: { default: { agentId: reqAgent } } })
      : options.policy ??
        (options.policyFor ? options.policyFor(this.mode) : createModelPolicy(this.mode));
    this.hooks = options.hooks ?? new HookBus();
    this.store = options.store ?? new MemoryRunStore();
    this.skills = options.skills ?? [];
    this.codegraph = options.codegraph;
    this.knowledgeStore = options.knowledgeStore;
    this.clock = options.clock ?? (() => Date.now());
    this.streamFlushMs = Math.max(0, options.streamFlushMs ?? 0);
    this.detectionOptions = options.detectionOptions;
    this.maxIterations = options.maxIterations ?? 50;
    this.authoredSpecCriteria = options.authoredSpecCriteria;
    this.validateEnabled = options.validate ?? false;
    this.maxValidationRounds = options.maxValidationRounds ?? 2;
    this.verifier = options.verifier;
    this.maxAttempts = options.maxAttemptsPerTask ?? 3;
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.budget = options.budget;
    this.control = options.control;
    this.controlPoll = options.controlPoll;
    this.hasUserAcceptanceCriteria = (request.acceptanceCriteria ?? []).some((criterion) => criterion.trim().length > 0);
    this.resuming = Boolean(resumeFrom);
    this.createdAt = resumeFrom?.createdAt ?? this.clock();

    if (resumeFrom) {
      this.id = resumeFrom.id;
      this.ids = options.idGenerator ?? createIdGenerator(resumeFrom.checkpointSeq + 1000);
      this.routeDecision = resumeFrom.routeDecision;
      this.wiki = ProjectWiki.fromJSON(resumeFrom.wiki, { clock: this.clock });
      this.acceptance = resumeFrom.acceptance ?? this.createInitialAcceptance();
      this.iterations = resumeFrom.iterations ? structuredClone(resumeFrom.iterations) : [];
      this.riskGates = resumeFrom.riskGates ? structuredClone(resumeFrom.riskGates) : [];
      this.reports = resumeFrom.reports ? structuredClone(resumeFrom.reports) : [];
      this.knowledgeEvents = resumeFrom.knowledgeEvents ? structuredClone(resumeFrom.knowledgeEvents) : [];
      this.graph = PlanGraph.fromSnapshot(resumeFrom.plan, { clock: this.clock });
      this.inbox = Inbox.restore(resumeFrom.inbox, { clock: this.clock });
      // Drop the interrupted run's terminal run-finished marker(s) so the
      // resumed run's log stays a single coherent sequence (one run-started,
      // one trailing run-finished) instead of stacking a second pair.
      const restored = [...resumeFrom.events];
      while (restored.length > 0 && restored[restored.length - 1]?.type === 'run-finished') {
        restored.pop();
      }
      this.eventLog.push(...restored);
      this.checkpointSeq = resumeFrom.checkpointSeq;
      // Carry spend across resume so the budget ceiling is cumulative, not reset.
      this.spentTokens = resumeFrom.spentTokens ?? 0;
      this.spentCostUsd = resumeFrom.spentCostUsd ?? 0;
      // Carry the applied-control seq so a restart honors a still-pending command
      // (seq > this) exactly once and never re-applies an already-honored one.
      this.lastControlSeq = resumeFrom.lastControlSeq ?? 0;
      if (this.budget) {
        const overTokens = this.budget.maxTokens != null && this.spentTokens >= this.budget.maxTokens;
        const overCost = this.budget.maxCostUsd != null && this.spentCostUsd >= this.budget.maxCostUsd;
        this.budgetExhausted = overTokens || overCost;
      }
    } else {
      this.ids = options.idGenerator ?? createIdGenerator();
      // A caller-supplied runId (the Orchestrator allocates a unique one per
      // start) keeps runs from colliding in the store; otherwise derive one.
      this.id = runId ?? this.ids.next('run');
      this.wiki = new ProjectWiki({ clock: this.clock });
      this.graph = new PlanGraph({ idGenerator: this.ids, clock: this.clock });
      this.inbox = new Inbox({ clock: this.clock });
      this.acceptance = this.createInitialAcceptance();
    }
    this.attachGraphListener();

    this.result = this.run();
  }

  // ── Handle API ─────────────────────────────────────────────────────────────
  pause(): void {
    if (this.paused || this.cancelled) return;
    this.paused = true;
    this.emit({ type: 'paused' });
  }

  resumeRun(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emit({ type: 'resumed' });
    this.pauseGate?.resolve();
    this.pauseGate = null;
  }

  resume(): void {
    this.resumeRun();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const abort of this.activeAborts) abort.abort();
    this.cancelUnfinishedTasks();
    this.pauseGate?.resolve();
    this.pauseGate = null;
    this.gateWaiter?.resolve();
    this.gateWaiter = null;
  }

  appendUserInput(text: string, options: InboxAppendOptions = {}): void {
    this.inbox.append(text, options);
  }

  // ── Internals ────────────────────────────────────────────────────────────────
  private emit(event: OrchestratorEvent): void {
    this.eventLog.push(event);
    this.stream.push(event);
  }

  private createInitialAcceptance(): AcceptanceSnapshot {
    const criteria = createAcceptanceCriteria({
      prompt: this.request.prompt,
      rawCriteria: this.request.acceptanceCriteria,
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    return { criteria, progress: acceptanceProgress(criteria) };
  }

  private setAcceptance(criteria: readonly AcceptanceCriterion[]): void {
    this.acceptance = {
      criteria: criteria.map((criterion) => ({
        ...criterion,
        evidence: criterion.evidence.map((evidence) => ({ ...evidence })),
      })),
      progress: acceptanceProgress(criteria),
    };
    this.emit({ type: 'acceptance-updated', acceptance: this.acceptance });
  }

  private emitAcceptance(): void {
    this.emit({ type: 'acceptance-updated', acceptance: this.acceptance });
  }

  private startIteration(reason: string, taskIds: readonly string[]): IterationSnapshot {
    const iteration = createIteration({
      index: this.iterations.length + 1,
      reason,
      taskIds,
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    this.iterations = [...this.iterations, iteration];
    this.emit({ type: 'iteration-updated', iteration, iterations: this.iterations });
    return iteration;
  }

  private completeIteration(iteration: IterationSnapshot): void {
    const failedCriteria = this.acceptance.criteria
      .filter((criterion) => criterion.status === 'fail')
      .map((criterion) => criterion.title);
    const openGates = this.riskGates.filter((gate) => gate.status === 'open').map((gate) => gate.id);
    const unknownCriteria = this.acceptance.criteria
      .filter((criterion) => criterion.status === 'unknown' || criterion.status === 'needs-user')
      .map((criterion) => criterion.title);
    const nextAction = this.nextStrategyAction({ failedCriteria, unknownCriteria, openGates });
    const nextStrategy = nextAction === 'stop' ? 'cancel' : nextAction;
    const updated = finishIteration(iteration, {
      status: 'complete',
      reviewSummary: this.computeSummary('running'),
      failedCriteria,
      nextStrategy,
      clock: this.clock,
    });
    this.iterations = this.iterations.map((item) => (item.id === updated.id ? updated : item));
    this.emit({ type: 'iteration-updated', iteration: updated, iterations: this.iterations });
    this.emitStrategyUpdate(updated, { failedCriteria, unknownCriteria, openGates, nextAction });
  }

  private nextStrategyAction(input: {
    failedCriteria: readonly string[];
    unknownCriteria: readonly string[];
    openGates: readonly string[];
  }): StrategyNextAction {
    if (this.cancelled || this.budgetExhausted) return 'stop';
    if (input.openGates.length > 0) return 'wait-for-user';
    if (input.failedCriteria.length > 0 || input.unknownCriteria.length > 0) return 'replan';
    return this.graph.isComplete() ? 'finish' : 'continue';
  }

  private strategyReason(input: {
    failedCriteria: readonly string[];
    unknownCriteria: readonly string[];
    openGates: readonly string[];
    nextAction: StrategyNextAction;
  }): StrategyUpdateReason {
    if (this.budgetExhausted) return 'budget';
    if (this.cancelled) return 'cancelled';
    if (input.openGates.length > 0) return 'gate-open';
    if (input.failedCriteria.length > 0) return 'criteria-failed';
    if (input.unknownCriteria.length > 0) return 'criteria-unknown';
    if (input.nextAction === 'finish') return 'finish';
    return 'continue';
  }

  private emitStrategyUpdate(
    iteration: IterationSnapshot,
    input: {
      failedCriteria: readonly string[];
      unknownCriteria: readonly string[];
      openGates: readonly string[];
      nextAction: StrategyNextAction;
    },
  ): void {
    const reason = this.strategyReason(input);
    const pendingCriteria = [...input.failedCriteria, ...input.unknownCriteria];
    const summary =
      pendingCriteria.length > 0
        ? `Loop will ${input.nextAction}; pending criteria: ${pendingCriteria.join(', ')}.`
        : input.openGates.length > 0
          ? `Loop is waiting for ${input.openGates.length} open gate(s).`
          : `Loop will ${input.nextAction}.`;
    this.emit({
      type: 'strategy-updated',
      iterationId: iteration.id,
      reason,
      failedCriteria: [...input.failedCriteria],
      openGates: [...input.openGates],
      nextAction: input.nextAction,
      summary,
    });
    this.scheduleStrategyReport({
      iterationId: iteration.id,
      reason,
      failedCriteria: input.failedCriteria,
      unknownCriteria: input.unknownCriteria,
      openGates: input.openGates,
      nextAction: input.nextAction,
      summary,
    });
  }

  private acceptanceCriteriaText(): string[] {
    return this.acceptance.criteria.map((criterion) => criterion.title);
  }

  private createAgentIdentity(
    assignment: ReturnType<ModelPolicy['select']>,
    role: AgentRole,
    taskId: string | null,
  ): { agentRunId: string; agentLabel: string } {
    const agentRunId = this.ids.next('agent-run');
    const suffix = taskId ?? role;
    return { agentRunId, agentLabel: `${assignment.agentId}#${suffix}` };
  }

  private launchSupportWork(phase: string, work: () => Promise<void>): void {
    const promise = (async () => {
      try {
        await work();
      } catch (err) {
        this.emit({ type: 'error', phase, message: errorMessage(err) });
        await this.checkpointSupportProgress().catch(() => undefined);
      }
    })();
    this.supportWork.add(promise);
    void promise.finally(() => this.supportWork.delete(promise));
  }

  private async drainSupportWork(): Promise<void> {
    while (this.supportWork.size > 0) {
      await Promise.allSettled([...this.supportWork]);
    }
  }

  private async runSupportAgent(
    role: Extract<AgentRole, 'reporter' | 'wiki-curator' | 'validator'>,
    prompt: string,
  ): Promise<{ result: AgentRunResult; assignment: ReturnType<ModelPolicy['select']> }> {
    const assignment = this.policy.select(role, {
      available: this.available,
      taskType: role,
      taskTitle: role,
    });
    const forced = this.request.metadata?.supportAgents === true;
    const disabled = this.request.metadata?.supportAgents === false;
    if (disabled || (!forced && (assignment.agentId === BUILTIN_AGENT_ID || assignment.agentId === 'scripted'))) {
      return {
        assignment,
        result: {
          text: '',
          thinking: '',
          toolCalls: [],
          usage: null,
          costUsd: null,
          status: 'cancelled',
          error: null,
          model: null,
        },
      };
    }
    const identity = this.createAgentIdentity(assignment, role, null);
    const input: AgentRunInput = {
      agentId: assignment.agentId,
      prompt,
      ...(this.request.cwd ? { cwd: this.request.cwd } : {}),
      model: assignment.model,
      reasoning: assignment.reasoning,
      metadata: { role, runId: this.id, ...identity },
    };
    const abort = new AbortController();
    this.activeAborts.add(abort);
    input.signal = abort.signal;
    this.emit({ type: 'agent-assigned', role, taskId: null, title: role, assignment, ...identity });
    await this.checkpointSupportProgress();
    const acc = createResultAccumulator();
    try {
      for await (const event of this.runtime.streamAgentEvents(input)) {
        acc.push(event);
        this.emit({ type: 'agent-event', role, taskId: null, assignment, ...identity, event });
        await this.checkpointSupportProgress();
      }
    } catch (err) {
      const message = errorMessage(err);
      this.emit({ type: 'error', phase: role, message });
      await this.checkpointSupportProgress().catch(() => undefined);
      return {
        assignment,
        result: {
          text: '',
          thinking: '',
          toolCalls: [],
          usage: null,
          costUsd: null,
          status: 'error',
          error: message,
          model: null,
        },
      };
    } finally {
      this.activeAborts.delete(abort);
    }
    const result = acc.result();
    // Support agents are explicitly outside the main task loop. Their artifacts
    // carry author metadata, but their usage must not trip the user's task
    // completion/budget gates.
    return { result, assignment };
  }

  /**
   * Adopt acceptance criteria from a spec the agent authored during this run.
   * Each becomes a 'spec'-sourced criterion, which forces explicit acceptance (so
   * the work isn't implicitly passed) and is scored by the validator. Wired only
   * when an {@link AuthoredSpecCriteria} provider is supplied and the workspace is
   * writable; a read failure must never break the run.
   */
  private async ingestAuthoredSpecCriteria(): Promise<void> {
    if (!this.authoredSpecCriteria || !this.request.cwd) return;
    let criteria: string[];
    try {
      criteria = await this.authoredSpecCriteria(this.request.cwd);
    } catch {
      return;
    }
    for (const raw of criteria) {
      const added = this.appendAcceptanceCriterion(raw, 'spec');
      // Only count genuinely new spec criteria (append dedupes by title).
      if (added && added.source === 'spec') this.adoptedSpec = true;
    }
  }

  /** Mark every still-open acceptance criterion as passed with shared evidence. */
  private markAcceptanceSatisfied(note: string): void {
    const now = this.clock();
    this.setAcceptance(
      this.acceptance.criteria.map((criterion) =>
        criterion.status === 'pass'
          ? criterion
          : { ...criterion, status: 'pass', evidence: [...criterion.evidence, { text: note, createdAt: now }], updatedAt: now },
      ),
    );
  }

  /**
   * Independent validation gate. When a run would otherwise succeed, an
   * independent validator judges the work against the acceptance criteria; on a
   * gap verdict it injects fix-tasks and re-runs the loop, bounded by
   * {@link maxValidationRounds}. Runs when validation/verification is enabled, or
   * when the agent authored a spec this run (its criteria are then verified).
   */
  private async validationGate(): Promise<void> {
    // Adopt criteria from any spec the agent authored this run, so the loop is
    // held to the spec it wrote rather than the worker's own "done".
    await this.ingestAuthoredSpecCriteria();
    if (!this.validateEnabled && !this.verifier && !this.adoptedSpec) return;
    let round = 0;
    let lastVerifierPassed = true;
    // Note: budget exhaustion does NOT skip the gate. The verifier (a shell check)
    // and the validator (a budget-exempt support agent, like the wiki-curator that
    // already runs post-budget) still get to render a verdict — otherwise a run that
    // spent its budget in the worker phase could never verify the spec it adopted.
    // Only the fix→re-loop below (which spends worker budget) honors the budget.
    while (round < this.maxValidationRounds && !this.cancelled) {
      this.applyImplicitAcceptanceIfNeeded();
      const status = this.computeFinalStatus();
      // Gate a run that would otherwise succeed. For an adopted spec, 'incomplete'
      // just means its criteria are still pending — that IS what we verify here; only
      // bail on a real failure (failed/blocked tasks) or a non-adopted incomplete.
      if (status !== 'succeeded' && !(this.adoptedSpec && status === 'incomplete')) return;

      const fixes: { title: string; description: string; tag: string }[] = [];

      // 1. Closed-loop verification (real tests/build) — an objective HARD gate.
      if (this.verifier) {
        const result = await this.verifier();
        lastVerifierPassed = result.passed;
        this.wiki.addNote({
          title: `Verification — ${result.passed ? 'passed' : 'failed'}`,
          body: result.summary || (result.passed ? 'All checks passed.' : 'Verification failed.'),
          tags: ['verification', result.passed ? 'passed' : 'failed'],
          source: `verifier:${this.id}`,
        });
        if (!result.passed) {
          fixes.push({
            title: 'Fix failing verification',
            description: `The verification command failed:\n${result.summary}`.slice(0, 2000),
            tag: 'verify-fix',
          });
        }
      }

      // 2. Independent LLM validator — only once verification is clean. Also runs
      // for an adopted spec, to judge the work against the agent's own criteria.
      if ((this.validateEnabled || this.adoptedSpec) && fixes.length === 0) {
        const verdict = await this.runValidator();
        this.wiki.addNote({
          title: `Validation — ${verdict.passed ? 'passed' : 'gaps found'}`,
          body: verdict.notes || (verdict.gaps.length ? verdict.gaps.join('\n') : 'No gaps.'),
          tags: ['validation', verdict.passed ? 'passed' : 'rejected'],
          source: `validator:${this.id}`,
        });
        if (!verdict.passed) {
          for (const gap of verdict.gaps.filter((g) => g.trim()).slice(0, 8)) {
            fixes.push({ title: `Fix: ${gap.slice(0, 70)}`, description: gap, tag: 'validator-fix' });
          }
        }
      }

      if (fixes.length === 0) {
        // Every gate is clean. For an adopted spec, the verifier/validator just
        // confirmed the work meets the agent's own criteria — mark them satisfied
        // so the run reaches a true 'succeeded' instead of a pending 'incomplete'.
        if (this.adoptedSpec) {
          this.markAcceptanceSatisfied('Verified against the agent-authored spec.');
        }
        return;
      }
      // Gaps remain. Fixing them re-runs workers, which spends budget — so if the
      // budget is already exhausted, stop here: the run finishes 'incomplete' with
      // the gaps recorded, rather than overspending.
      if (this.budgetExhausted) return;
      for (const fix of fixes) {
        this.graph.addTask({ title: fix.title, description: fix.description, role: 'worker', tags: [fix.tag] });
      }
      await this.replan('validation-rejected');
      await this.checkpoint();
      await this.loop();
      round += 1;
    }
    // Exhausted the rounds. If the objective verifier is still red, this isn't a
    // true success — computeFinalStatus() will downgrade it to 'incomplete'.
    this.verificationFailed = this.verifier ? !lastVerifierPassed : false;
  }

  private async runValidator(): Promise<ReturnType<typeof parseValidationVerdict>> {
    // Validate against the run's full accepted criteria set (seeded + planner +
    // adopted spec), not just the request's — so agent-authored criteria are judged.
    const criteria = this.acceptanceCriteriaText();
    const prompt = buildValidationPrompt(this.request.prompt, criteria, this.supportContext());
    const { result } = await this.runSupportAgent('validator', prompt);
    // No real validator available (offline / scripted gating) → don't block finishing.
    if (result.status !== 'completed' || !result.text.trim()) {
      return { passed: true, gaps: [], notes: 'validator unavailable' };
    }
    return parseValidationVerdict(result.text);
  }

  private supportContext(): string {
    const tasks = this.graph.tasks().map((task) => ({
      id: task.id,
      title: task.title,
      role: task.role,
      status: task.status,
      attempts: task.attempts,
      tags: task.tags,
      result: task.result?.summary,
    }));
    return JSON.stringify(
      {
        runId: this.id,
        prompt: this.request.prompt,
        route: this.routeDecision,
        summary: this.computeSummary(this.status === 'pending' ? 'running' : this.status),
        acceptance: this.acceptance,
        iterations: this.iterations.slice(-5),
        tasks,
        reports: this.reports.map((report) => ({
          id: report.id,
          kind: report.kind,
          title: report.title,
          summary: report.summary,
        })),
        codegraph: this.codegraph?.stats() ?? null,
      },
      null,
      2,
    ).slice(0, 12000);
  }

  private reporterPrompt(kind: ReportKind, title: string, fallbackSummary: string, taskId?: string): string {
    return [
      'You are Omakase Reporter, an out-of-band reporting agent.',
      'You do not participate in the main plan. Write a concise stage report for the user in markdown.',
      'Do not paste raw logs. Synthesize progress, current state, risks, evidence, and next useful action.',
      `Report kind: ${kind}`,
      `Title: ${title}`,
      taskId ? `Related task: ${taskId}` : 'Related task: none',
      `Fallback summary: ${fallbackSummary}`,
      '',
      'Current run state JSON:',
      this.supportContext(),
    ].join('\n');
  }

  private wikiCuratorPrompt(reason: string, report: ReportArtifact | null): string {
    return [
      'You are Omakase Wiki Curator, an out-of-band project knowledge agent.',
      'Write durable project wiki content, not a chronological run log.',
      'Capture stable facts, architecture decisions, risks, open questions, and verification handles that will still help a future agent.',
      'Keep it concise and specific. Avoid generic status phrases.',
      `Reason: ${reason}`,
      report ? `Related report: ${report.title} (${report.id})` : 'Related report: none',
      this.commandCurationDirective(),
      '',
      'Current run state JSON:',
      this.supportContext(),
    ].join('\n');
  }

  /**
   * "/learn"-style command curation (P2). The post-run curator may distill a
   * reusable command when — and only when — the run revealed a genuinely
   * repeatable recipe. Deliberately conservative: most runs warrant nothing, and
   * writing a command every run would just add entropy (the thing P3 guards). The
   * agent authors the file itself; silent when the workspace isn't writable.
   */
  private commandCurationDirective(): string {
    if (!this.request.cwd) return '';
    return [
      '',
      'Command curation: if — and ONLY if — this run revealed a clearly repeatable,',
      'general procedure a future run would benefit from invoking directly, distill it',
      'into a command with your file tools: write `.omks/commands/<slug>.md` (a one-line',
      'title, then the reusable prompt body; use `$ARGUMENTS` where the caller substitutes',
      'input). Most runs warrant NO new command — skip it unless the recipe is genuinely',
      'reusable, and never duplicate a command already in `.omks/commands/`.',
    ].join('\n');
  }

  private async createReport(kind: ReportKind, title: string, fallbackSummary: string, fallbackMarkdown: string, taskId?: string): Promise<void> {
    const { result, assignment } = await this.runSupportAgent('reporter', this.reporterPrompt(kind, title, fallbackSummary, taskId));
    const agentMarkdown = result.status === 'completed' && result.text.trim().length > 0 ? cleanAgentArtifactText(result.text) : '';
    const markdown = agentMarkdown || fallbackMarkdown;
    const source = agentMarkdown ? 'agent' : 'fallback';
    const report = createReportArtifact({
      runId: this.id,
      kind,
      title,
      summary: summarizeMarkdown(markdown, fallbackSummary),
      markdown,
      ...(taskId ? { taskId } : {}),
      authorAgentId: source === 'agent' ? assignment.agentId : null,
      source,
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    this.reports = [...this.reports, report];
    this.emit({ type: 'report-created', report, reports: this.reports });

    const knowledge = createKnowledgeEvent({
      runId: this.id,
      kind: 'report',
      title,
      body: report.summary,
      ...(taskId ? { taskId } : {}),
      reportId: report.id,
      ...(report.authorAgentId ? { authorAgentId: report.authorAgentId } : {}),
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    this.knowledgeEvents = [...this.knowledgeEvents, knowledge];
    const wikiEntry = knowledgeEventToWikiEntry(knowledge);
    this.wiki.add(wikiEntry.kind, {
      title: wikiEntry.title,
      body: wikiEntry.body,
      tags: wikiEntry.tags,
      source: wikiEntry.source,
    });
    this.emit({ type: 'knowledge-event-created', event: knowledge, events: this.knowledgeEvents });
    this.emitKnowledge();
    await this.checkpointSupportProgress({ persistKnowledge: true });
    await this.createWikiSynthesis(`report:${kind}`, report);
  }

  private async createWikiSynthesis(reason: string, report: ReportArtifact | null = null): Promise<void> {
    const { result, assignment } = await this.runSupportAgent('wiki-curator', this.wikiCuratorPrompt(reason, report));
    const body = result.status === 'completed' && result.text.trim().length > 0 ? cleanAgentArtifactText(result.text) : '';
    if (!body) return;
    const knowledge = createKnowledgeEvent({
      runId: this.id,
      kind: 'synthesis',
      title: report ? `Wiki synthesis: ${report.title}` : 'Wiki synthesis',
      body,
      ...(report?.taskId ? { taskId: report.taskId } : {}),
      ...(report ? { reportId: report.id } : {}),
      authorAgentId: assignment.agentId,
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    this.knowledgeEvents = [...this.knowledgeEvents, knowledge];
    const wikiEntry = knowledgeEventToWikiEntry(knowledge);
    this.wiki.add(wikiEntry.kind, {
      title: wikiEntry.title,
      body: wikiEntry.body,
      tags: wikiEntry.tags,
      source: wikiEntry.source,
    });
    this.emit({ type: 'knowledge-event-created', event: knowledge, events: this.knowledgeEvents });
    this.emitKnowledge();
    await this.checkpointSupportProgress({ persistKnowledge: true });
  }

  private async createPlanningReport(): Promise<void> {
    const tasks = this.graph.tasks();
    const summary = `Planned ${tasks.length} task(s).`;
    const markdown = [
      '# Planning report',
      '',
      summary,
      '',
      ...tasks.map((task) => `- ${task.id}: ${task.title} [${task.role}]`),
    ].join('\n');
    await this.createReport('planning', 'Planning report', summary, markdown);
  }

  private schedulePlanningReport(): void {
    this.requestReport({
      kind: 'planning',
      title: 'Planning report',
      reason: 'planner:planned',
      taskId: null,
      source: 'planner',
      work: () => this.createPlanningReport(),
    });
  }

  private async createReviewReport(taskId: string, approved: boolean, notes: string): Promise<void> {
    const summary = `Review ${approved ? 'approved' : 'rejected'}: ${notes || '(no notes)'}`;
    const markdown = [
      '# Review report',
      '',
      summary,
      '',
      `Acceptance: ${this.acceptance.progress.passed}/${this.acceptance.progress.total}`,
    ].join('\n');
    await this.createReport('review', 'Review report', summary, markdown, taskId);
  }

  private scheduleReviewReport(taskId: string, approved: boolean, notes: string): void {
    this.requestReport({
      kind: 'review',
      title: 'Review report',
      reason: `review:${approved ? 'approved' : 'rejected'}`,
      taskId,
      source: 'reviewer',
      work: () => this.createReviewReport(taskId, approved, notes),
    });
  }

  private async createAgentRequestedReport(
    source: 'planner' | 'reviewer',
    request: AgentReportRequest,
    taskId: string | null,
  ): Promise<void> {
    const markdown =
      request.markdown ??
      [
        `# ${request.title}`,
        '',
        request.summary,
        '',
        `Requested by: ${source}`,
        `Reason: ${request.reason}`,
      ].join('\n');
    await this.createReport('milestone', request.title, request.summary, markdown, taskId ?? undefined);
  }

  private scheduleAgentRequestedReports(
    source: 'planner' | 'reviewer',
    requests: readonly AgentReportRequest[],
    taskId: string | null,
  ): void {
    for (const [index, request] of requests.entries()) {
      const reason = `${source}:${request.reason}`;
      this.requestReport({
        kind: 'milestone',
        title: request.title,
        reason,
        taskId,
        source,
        dedupeKey: `agent-request:${source}:${taskId ?? 'run'}:${index}:${request.title}:${request.reason}`,
        work: () => this.createAgentRequestedReport(source, request, taskId),
      });
    }
  }

  private schedulePlannerRequestedReports(): void {
    const requests = this.pendingPlannerReportRequests;
    this.pendingPlannerReportRequests = [];
    this.scheduleAgentRequestedReports('planner', requests, null);
  }

  private async createStrategyReport(input: {
    reason: StrategyUpdateReason;
    failedCriteria: readonly string[];
    unknownCriteria: readonly string[];
    openGates: readonly string[];
    nextAction: StrategyNextAction;
    summary: string;
  }): Promise<void> {
    const markdown = [
      '# Strategy report',
      '',
      input.summary,
      '',
      `Next action: ${input.nextAction}`,
      `Reason: ${input.reason}`,
      '',
      input.failedCriteria.length > 0
        ? ['Failed criteria:', ...input.failedCriteria.map((criterion) => `- ${criterion}`)].join('\n')
        : 'Failed criteria: none',
      '',
      input.unknownCriteria.length > 0
        ? ['Unknown criteria:', ...input.unknownCriteria.map((criterion) => `- ${criterion}`)].join('\n')
        : 'Unknown criteria: none',
      '',
      input.openGates.length > 0
        ? ['Open gates:', ...input.openGates.map((gate) => `- ${gate}`)].join('\n')
        : 'Open gates: none',
    ].join('\n');
    await this.createReport('milestone', 'Strategy report', input.summary, markdown);
  }

  private scheduleStrategyReport(input: {
    iterationId: string;
    reason: StrategyUpdateReason;
    failedCriteria: readonly string[];
    unknownCriteria: readonly string[];
    openGates: readonly string[];
    nextAction: StrategyNextAction;
    summary: string;
  }): void {
    if (input.nextAction !== 'replan' && input.nextAction !== 'wait-for-user') return;
    const requestReason = `strategy:${input.reason}`;
    this.requestReport({
      kind: 'milestone',
      title: 'Strategy report',
      reason: requestReason,
      taskId: null,
      source: 'strategy',
      dedupeKey: `${input.iterationId}:${requestReason}`,
      work: () => this.createStrategyReport(input),
    });
  }

  private requestReport(input: {
    kind: ReportKind;
    title: string;
    reason: string;
    taskId: string | null;
    source: 'planner' | 'reviewer' | 'strategy' | 'system';
    work: () => Promise<void>;
    dedupeKey?: string;
  }): void {
    if (input.dedupeKey) {
      if (this.requestedReportKeys.has(input.dedupeKey)) return;
      this.requestedReportKeys.add(input.dedupeKey);
    }
    this.emit({
      type: 'report-requested',
      kind: input.kind,
      title: input.title,
      reason: input.reason,
      taskId: input.taskId,
      source: input.source,
    });
    this.launchSupportWork(`report:${input.reason}`, input.work);
  }

  private scheduleWikiSynthesis(reason: string, report: ReportArtifact | null = null): void {
    this.launchSupportWork('wiki-synthesis', () => this.createWikiSynthesis(reason, report));
  }

  private setPlannerAcceptanceCriteria(rawCriteria: readonly string[]): void {
    const criteria = createAcceptanceCriteria({
      prompt: this.request.prompt,
      rawCriteria,
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    this.setAcceptance(criteria);
  }

  private appendAcceptanceCriterion(rawCriterion: string, source: AcceptanceSource): AcceptanceCriterion | null {
    const title = rawCriterion.replace(/\s+/g, ' ').trim();
    if (!title) return null;
    const existing = this.acceptance.criteria.find((criterion) => criterion.title === title);
    if (existing) return existing;
    const now = this.clock();
    const criterion: AcceptanceCriterion = {
      id: this.ids.next('criterion'),
      title,
      description: title,
      status: 'pending',
      evidence: [],
      source,
      createdAt: now,
      updatedAt: now,
    };
    this.setAcceptance([...this.acceptance.criteria, criterion]);
    return criterion;
  }

  private replaceAcceptanceCriteria(rawCriteria: readonly string[]): void {
    const criteria = createAcceptanceCriteria({
      prompt: this.request.prompt,
      rawCriteria,
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    }).map((criterion) => ({ ...criterion, source: 'user' as const }));
    this.setAcceptance(criteria);
  }

  private answerGate(gateId: string, answer: string, criteria?: readonly string[]): void {
    const existing = this.riskGates.find((gate) => gate.id === gateId && gate.status === 'open');
    if (!existing) return;
    if (criteria && criteria.length > 0) this.replaceAcceptanceCriteria(criteria);
    const updated = answerRiskGate(existing, { answer, criteria, clock: this.clock });
    this.riskGates = this.riskGates.map((gate) => (gate.id === gateId ? updated : gate));
    this.emit({ type: 'risk-gate-answered', gate: updated, gates: this.riskGates });
    this.gateWaiter?.resolve();
    this.gateWaiter = null;
  }

  private async openRiskGate(input: {
    reason: RiskGateSnapshot['reason'];
    question: string;
    taskId?: string;
  }): Promise<RiskGateSnapshot> {
    const gate = createRiskGate({
      reason: input.reason,
      question: input.question,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    this.riskGates = [...this.riskGates, gate];
    this.status = 'waiting-for-user';
    this.gateWaiter = deferred();
    this.emit({ type: 'risk-gate-opened', gate, gates: this.riskGates });
    await this.checkpoint();
    await this.gateWaiter.promise;
    this.status = 'running';
    await this.checkpoint();
    return this.riskGates.find((item) => item.id === gate.id) ?? gate;
  }

  private attachGraphListener(): void {
    this.graph.setStatusListener((change) => {
      this.emit({
        type: 'task-status',
        taskId: change.task.id,
        title: change.task.title,
        from: change.from,
        to: change.to,
        at: this.clock(),
      });
      void this.hooks.emit('onTaskStatusChange', {
        task: change.task,
        from: change.from,
        to: change.to,
      });
    });
  }

  private cancelUnfinishedTasks(): void {
    for (const task of this.graph.tasks()) {
      if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'cancelled') {
        this.graph.setStatus(task.id, 'cancelled');
      }
    }
  }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.cancelled) {
      if (!this.pauseGate) this.pauseGate = deferred();
      await this.pauseGate.promise;
    }
  }

  /**
   * The default router: ask the policy's `router`-role agent to classify the
   * request (SIMPLE/COMPLEX). Resolves the agent lazily at route time (after
   * detection) and falls back to the rule router when the built-in agent is the
   * only option (it has no model) or the agent's answer can't be parsed.
   */
  private makeAgentRouter(): Router {
    const fallback = new RuleRouter();
    return {
      route: async (request) => {
        const assignment = this.policy.select('router', { available: this.available });
        if (assignment.agentId === BUILTIN_AGENT_ID) return fallback.route(request);
        try {
          return await createAgentRouter(this.runtime, {
            agentId: assignment.agentId,
            model: assignment.model,
            fallback,
          }).route(request);
        } catch {
          return fallback.route(request);
        }
      },
    };
  }

  /**
   * Consult the cross-process {@link ControlSource} and apply any newly-issued
   * command (seq > last applied) by calling the SAME in-process methods a
   * keypress used to. Idempotent across polls/restart via the seq guard. A
   * `stop` maps to {@link cancel} — which aborts the in-flight agent immediately
   * — so it takes effect mid-run, not at a task boundary.
   */
  private async applyControl(): Promise<void> {
    // Serialize: a fire-and-forget poll tick must not overlap a prior read and
    // re-apply the same command across the seq-check await window.
    if (!this.control || this.controlInFlight) return;
    this.controlInFlight = true;
    let command;
    try {
      command = await this.control.read(this.id);
    } catch {
      return; // a torn/unreadable control file is non-fatal
    } finally {
      this.controlInFlight = false;
    }
    if (!command || command.seq <= this.lastControlSeq) return;
    this.lastControlSeq = command.seq;
    switch (command.command) {
      case 'stop':
        this.cancel();
        break;
      case 'pause':
        this.pause();
        break;
      case 'resume':
        this.resumeRun();
        break;
      case 'input':
        if (command.text) this.appendUserInput(command.text);
        break;
      case 'answer-gate':
        if (command.gateId && command.answer) this.answerGate(command.gateId, command.answer, command.criteria);
        break;
      case 'edit-criteria':
        if (command.criteria) {
          this.replaceAcceptanceCriteria(command.criteria);
          await this.replan('criteria-edited');
        }
        break;
    }
  }

  private emitKnowledge(): void {
    const codegraph = this.codegraph ? this.codegraph.stats() : null;
    this.emit({
      type: 'knowledge-updated',
      wikiEntries: this.wiki.size,
      codegraphFiles: codegraph ? codegraph.files : null,
      codegraph,
    });
  }

  private async detectAvailable(): Promise<DetectedAgent[]> {
    try {
      return await this.runtime.detect(this.detectionOptions);
    } catch {
      return [];
    }
  }

  /**
   * Spec-driven nudge for spec-less runs: when no spec seeded the run (the user
   * didn't pick one, so {@link hasUserAcceptanceCriteria} is false) and the
   * workspace is writable, ask the planner to make authoring a durable spec its
   * first task. The agent authors the spec with its own file tools — the
   * orchestrator never templates `.omks/` files itself. Silent on spec-driven
   * runs (the spec already exists) and on cwd-less runs (nothing to write to).
   */
  private specFirstDirective(): string {
    if (this.hasUserAcceptanceCriteria || !this.request.cwd) return '';
    return [
      '',
      'No spec drives this work yet. If the request is non-trivial (more than a quick one-off fix),',
      'make your FIRST worker task author a spec at `.omks/specs/<slug>.md` — sections ## Summary,',
      '## Acceptance criteria as `- [ ]` bullets mirroring the acceptanceCriteria you produce,',
      '## Implementation plan, ## Test strategy — and have the implementation tasks dependOn it.',
      'For a genuinely trivial request, skip the spec and plan the work directly.',
    ].join('\n');
  }

  private plannerPrompt(): string {
    const knowledge = this.knowledgeContext();
    const skills =
      this.skills.length > 0
        ? selectSkillsForPrompt(this.skills, this.request.prompt, {
            role: 'planner',
            limit: 3,
          })
        : [];
    return [
      'Break the following request into an ordered implementation plan.',
      'Respond with ONLY a JSON object: {"acceptanceCriteria": string[], "tasks": object[], "reportRequests": object[]}.',
      'Each task object must be: {"title": string, "description": string, "phase": string, "dependsOn": number[]}.',
      'Each optional report request object must be: {"title": string, "reason": string, "summary": string}.',
      'phase is the user-visible stage name shown in the TUI, such as Discovery, Core, TUI, Verification, or Docs.',
      'The tasks array is WORKER tasks only. Do not include reviewer, review, approval, or final verification tasks; Omakase automatically adds one reviewer task after the workers.',
      'acceptanceCriteria must be concrete, testable, product-facing completion checks.',
      'Use reportRequests only when the planner decides a separate Reporter should write a stage report outside the main flow.',
      'Do not create acceptance criteria about reviewer approval, report creation, wiki curator execution, strategy events, session logs, or harness internals.',
      'If the request specifies an exact number of worker tasks, obey that count. Otherwise, for broad requests, create 3-7 focused worker tasks and prefer independent tasks that can run in parallel.',
      'Do not collapse unrelated work into one task.',
      'Do not include reporter, report-writing, wiki-curator, wiki-synthesis, sidecar, or support-agent tasks in tasks; Omakase runs those outside the main task graph.',
      'dependsOn uses zero-based indices of earlier tasks.',
      this.specFirstDirective(),
      '',
      `Request: ${this.request.prompt}`,
      knowledge ? `\nProject context:\n${knowledge}` : '',
      skills.length > 0 ? `\nApplicable skills:\n${renderSkillContext(skills)}` : '',
      this.capabilitiesBriefing(),
    ].join('\n');
  }

  private extractAgentPlanObject(text: string): { tasks?: unknown; acceptanceCriteria?: unknown; reportRequests?: unknown } | null {
    return extractJsonObject(text);
  }

  private graphFromAgentPlan(text: string): { graph: PlanGraph; acceptanceCriteria: string[]; reportRequests: AgentReportRequest[] } | null {
    const obj = this.extractAgentPlanObject(text);
    const arr = Array.isArray(obj?.tasks) ? obj.tasks : extractJsonArray(text);
    if (!arr || arr.length === 0) return null;
    const reportRequests = agentReportRequestsFromObject(obj);
    const acceptanceCriteria = Array.isArray(obj?.acceptanceCriteria)
      ? obj.acceptanceCriteria
          .map((criterion) => (typeof criterion === 'string' ? criterion.replace(/\s+/g, ' ').trim() : ''))
          .filter(Boolean)
          .filter((criterion) => !this.isProcessAcceptanceCriterion(criterion))
          .slice(0, 12)
      : [];
    const graph = new PlanGraph({ idGenerator: this.ids, clock: this.clock });
    const idsByInputIndex: Array<string | undefined> = [];
    const mainTaskIds: string[] = [];
    for (const [index, raw] of arr.entries()) {
      const item = raw as { title?: unknown; description?: unknown; dependsOn?: unknown };
      const title =
        typeof item.title === 'string' && item.title.trim()
          ? item.title.replace(/\s+/g, ' ').trim().slice(0, 72)
          : 'Task';
      const description =
        typeof item.description === 'string' && item.description.trim()
          ? item.description
          : title;
      if (this.isOutOfBandPlanTask(raw, title, description)) {
        idsByInputIndex[index] = undefined;
        continue;
      }
      if (this.isSystemReviewPlanTask(raw, title, description)) {
        idsByInputIndex[index] = undefined;
        continue;
      }
      const dependsOn = Array.isArray(item.dependsOn)
        ? item.dependsOn
            .map((idx) => (typeof idx === 'number' ? idsByInputIndex[idx] : undefined))
            .filter((id): id is string => Boolean(id))
        : [];
      const task = graph.addTask({
        title,
        description,
        role: 'worker',
        dependsOn,
        tags: tagsFromAgentPlanTask(raw, title),
      });
      idsByInputIndex[index] = task.id;
      mainTaskIds.push(task.id);
    }
    if (mainTaskIds.length === 0) return null;
    graph.addTask({
      title: 'Review and verify the work',
      description: 'Review the completed work against the original request.',
      role: 'reviewer',
      dependsOn: mainTaskIds,
      tags: ['Review'],
    });
    graph.refreshReadiness();
    return { graph, acceptanceCriteria, reportRequests };
  }

  private isSystemReviewPlanTask(raw: unknown, title: string, description: string): boolean {
    const item = raw as { role?: unknown; phase?: unknown; kind?: unknown };
    const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
    if (role === 'reviewer' || role === 'review') return true;
    const phase = typeof item.phase === 'string' ? item.phase : '';
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const text = [title, description, phase, kind].join(' ').toLowerCase();
    const startsWithSystemReview = /^\s*(review|approve|验收|审查|复核)\b/i.test(title);
    const startsWithVerification = /^\s*(verify|validate)\b/i.test(title);
    const reviewerIntent =
      text.includes('reviewer task') ||
      text.includes('review task') ||
      text.includes('review and verify') ||
      text.includes('review completed work') ||
      text.includes('approve when') ||
      text.includes('approval') ||
      ((text.includes('worker result') || text.includes('worker output')) &&
        (text.includes('review') || text.includes('verify') || text.includes('approve'))) ||
      (text.includes('acceptance criteria') && (text.includes('review') || text.includes('reviewer') || text.includes('approve')));
    return (startsWithSystemReview || startsWithVerification) && reviewerIntent;
  }

  private isOutOfBandPlanTask(raw: unknown, title: string, description: string): boolean {
    const item = raw as { role?: unknown; phase?: unknown; kind?: unknown };
    const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
    if (role === 'reporter' || role === 'wiki-curator' || role === 'wiki_curator') return true;
    const phase = typeof item.phase === 'string' ? item.phase : '';
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const text = [title, description, phase, kind].join(' ').toLowerCase();
    const outOfBand =
      text.includes('sidecar') ||
      text.includes('support agent') ||
      text.includes('support-agent') ||
      text.includes('out-of-main-graph') ||
      text.includes('out of main graph') ||
      text.includes('outside the main graph') ||
      text.includes('outside main graph');
    const supportRole =
      text.includes('reporter') ||
      text.includes('report-writing') ||
      text.includes('wiki curator') ||
      text.includes('wiki-curator') ||
      text.includes('wiki synthesis') ||
      text.includes('wiki-synthesis');
    return outOfBand && supportRole;
  }

  private isProcessAcceptanceCriterion(criterion: string): boolean {
    const text = criterion.toLowerCase();
    if (text.includes('reviewer approval') || text.includes('reviewer approves')) return true;
    if (text.includes('report creation') || text.includes('reporter execution')) return true;
    if (text.includes('wiki curator') || text.includes('wiki-curator')) return true;
    if (text.includes('strategy event') || text.includes('strategy-update') || text.includes('strategy-updated')) return true;
    if (text.includes('session log') || text.includes('session-log')) return true;
    if (text.includes('harness internal') || text.includes('harness-level')) return true;
    if (text.includes('task graph') || text.includes('planned task graph')) return true;
    if (text.includes('dependency-free worker task') || text.includes('user-facing task graph')) return true;
    if (text.includes('exactly') && text.includes('worker task')) return true;
    if (text.includes('normal-mode') && text.includes('task') && text.includes('worker')) return true;
    if (text.includes('agent distribution') || text.includes('normal-mode agent')) return true;
    if (text.includes('offline') && (text.includes('builtin') || text.includes('scripted'))) return true;
    if (text.includes('fallback') && (text.includes('builtin') || text.includes('scripted'))) return true;
    return false;
  }

  private async planWithDefaultPlanner(): Promise<PlanGraph> {
    const fallback = async (): Promise<PlanGraph> =>
      this.planner.plan({
        request: this.request,
        idGenerator: this.ids,
        clock: this.clock,
        knowledge: this.knowledgeContext(),
        skills:
          this.skills.length > 0
            ? selectSkillsForPrompt(this.skills, this.request.prompt, {
                role: 'planner',
                limit: 3,
              })
            : [],
      });

    const assignment = this.policy.select('planner', { available: this.available });
    if (assignment.agentId === BUILTIN_AGENT_ID) return fallback();
    const identity = this.createAgentIdentity(assignment, 'planner', null);

    const input: AgentRunInput = {
      agentId: assignment.agentId,
      prompt: this.plannerPrompt(),
      ...(this.request.cwd ? { cwd: this.request.cwd } : {}),
      model: assignment.model,
      reasoning: assignment.reasoning,
      metadata: { role: 'planner', runId: this.id, ...identity },
    };
    const acc = createResultAccumulator();
    this.emit({ type: 'agent-assigned', role: 'planner', taskId: null, title: 'planner', assignment, ...identity });
    await this.checkpointProgress();
    try {
      for await (const event of this.runtime.streamAgentEvents(input)) {
        acc.push(event);
        this.emit({ type: 'agent-event', role: 'planner', taskId: null, assignment, ...identity, event });
        await this.checkpointProgress();
      }
    } catch (err) {
      this.emit({ type: 'error', phase: 'planner', message: errorMessage(err) });
      return fallback();
    }
    const result = acc.result();
    this.accountUsage(result);
    const parsed = result.status === 'completed' ? this.graphFromAgentPlan(result.text) : null;
    if (parsed && !this.hasUserAcceptanceCriteria && parsed.acceptanceCriteria.length > 0) {
      this.setPlannerAcceptanceCriteria(parsed.acceptanceCriteria);
    }
    this.pendingPlannerReportRequests = parsed?.reportRequests ?? [];
    return parsed?.graph ?? fallback();
  }

  private knowledgeContext(): string {
    const parts: string[] = [];
    const wiki = this.wiki.toMarkdown();
    if (this.wiki.size > 0) parts.push(wiki);
    if (this.codegraph && this.codegraph.size > 0) {
      const stats = this.codegraph.stats();
      parts.push(
        `# Codegraph\nFiles: ${stats.files}, internal edges: ${stats.internalEdges}, symbols: ${stats.symbols}`,
      );
    }
    return parts.join('\n\n');
  }

  private skillContext(role: AgentRole, text: string): string {
    if (this.skills.length === 0) return '';
    const selected = selectSkillsForPrompt(this.skills, text, { role, limit: 3 });
    return selected.length > 0 ? `\n\n${renderSkillContext(selected)}` : '';
  }

  /**
   * The harness capability declaration: tells the agent it can autonomously author
   * durable `.omks/` artifacts (specs, commands/skills, workflows, automations) with
   * its file tools — so the loop doesn't depend on a human writing them. Empty when
   * the run has no cwd (the agent can't touch the workspace). Instruction-level
   * memory (AGENTS.md / rules) is intentionally off-limits to avoid self-poisoning.
   */
  private capabilitiesBriefing(): string {
    if (!this.request.cwd) return '';
    return [
      '',
      'Workspace authoring — you MAY create or update durable artifacts under `.omks/` in the',
      'working directory with your normal file tools, and you SHOULD do so autonomously whenever',
      'it serves the task (you decide; no human will write these for you):',
      '- `.omks/specs/<slug>.md` — a spec capturing requirements before non-trivial work (sections:',
      '  ## Summary, ## Acceptance criteria as `- [ ]` bullets, ## Implementation plan, ## Test strategy).',
      '- `.omks/commands/<slug>.md` — a reusable prompt recipe ("skill"), invoked later as /<slug>',
      '  (supports `$ARGUMENTS`); save one when you find a repeatable workflow worth reusing.',
      '- `.omks/workflows/<slug>.ts` — a dynamic orchestration script: `export default async function(w){…}`',
      '  using w.phase / w.agent / w.parallel / w.pipeline / w.loopUntil / w.budget to coordinate sub-agents.',
      '- `.omks/triggers.json` — automations: an array of {"name","kind":"interval"|"daily"|"watch",',
      '  "specId"|"prompt","mode","autonomy",…} that re-run work on a schedule or on file changes.',
      'Do NOT modify `.omks/memory/AGENTS.md` or `.omks/memory/rules/` unless explicitly asked —',
      'instruction-level memory biases every future run.',
    ].join('\n');
  }

  private buildPrompt(role: AgentRole, task: TaskNode): string {
    const knowledge = this.knowledgeContext();
    const skills = this.skillContext(role, `${task.title} ${task.description}`);
    if (role === 'reviewer') {
      const completed = task.dependsOn
        .map((id) => this.graph.get(id))
        .filter((t): t is TaskNode => Boolean(t))
        .map((t) => {
          const resultText = t.result?.output || t.result?.summary || '(no output)';
          const lines = [
            `- ${t.title} (${t.id})`,
            `  status: ${t.status}`,
            t.result?.agentId ? `  agent: ${t.result.agentId}` : '',
            '  output:',
            boundedReviewExcerpt(resultText)
              .split('\n')
              .map((line) => `    ${line}`)
              .join('\n'),
          ].filter(Boolean);
          return lines.join('\n');
        })
        .join('\n');
      const criteria = this.acceptanceCriteriaText();
      if (criteria.length > 0) {
        return [
          'You are reviewing completed work against acceptance criteria.',
          'For EACH criterion decide whether it is met. Respond with ONLY a JSON object.',
          'The object must be: {"criteria": [{"met": true|false, "note": "why"}], "reportRequests": object[]}.',
          'criteria must be in the SAME order as the acceptance criteria.',
          'Each optional report request object must be: {"title": string, "reason": string, "summary": string}.',
          'Use reportRequests only when the reviewer decides a separate Reporter should write a stage report outside the main flow.',
          '',
          'Acceptance criteria:',
          ...criteria.map((c, i) => `${i + 1}. ${c}`),
          '',
          `Original request: ${this.request.prompt}`,
          `Completed work:\n${completed || '(none)'}`,
          knowledge ? `\n${knowledge}` : '',
          skills,
        ].join('\n');
      }
      return [
        'You are reviewing completed work against the original request.',
        'Reply with APPROVE or REJECT and a one-line reason.',
        '',
        `Original request: ${this.request.prompt}`,
        '',
        `Completed work:\n${completed || '(none)'}`,
        knowledge ? `\n${knowledge}` : '',
        skills,
      ].join('\n');
    }
    return [
      'You are completing one task within a larger plan.',
      `Task: ${task.title}`,
      `Details: ${task.description}`,
      '',
      `Original request: ${this.request.prompt}`,
      knowledge ? `\nProject context:\n${knowledge}` : '',
      skills,
      this.capabilitiesBriefing(),
    ].join('\n');
  }

  private async run(): Promise<RunResult> {
    try {
      this.status = 'running';
      // Don't re-emit run-started when resuming: the restored log already opens
      // with the original run-started, and a second one (after the prior events)
      // would make the persisted sequence self-contradictory.
      if (!this.resuming) {
        this.emit({ type: 'run-started', runId: this.id, request: this.request, mode: this.mode });
        this.emitAcceptance();
        // Persist immediately so detached clients can correlate the queue token
        // and show the run before routing/planning has produced any tasks.
        await this.checkpointProgress();
      }
      // Honor any already-pending control command (e.g. a stop issued while the
      // run was only persisted-as-running) before doing work, then keep polling.
      await this.applyControl();
      if (this.controlPoll) {
        this.controlDisposer = this.controlPoll(() => {
          void this.applyControl();
        });
      }
      this.available = await this.detectAvailable();
      if (!this.resuming) {
        await this.loadPersistedKnowledge();
        if (this.wiki.size > 0 || this.codegraph) {
          this.emitKnowledge();
          await this.checkpoint();
        }
      }

      if (!this.resuming) {
        await this.hooks.emit('beforeRoute', { request: this.request });
        this.routeDecision = await this.router.route(this.request);
        await this.hooks.emit('afterRoute', { request: this.request, decision: this.routeDecision });
        this.emit({ type: 'routed', decision: this.routeDecision });

        if (this.routeDecision.kind === 'simple') {
          const worker = this.graph.addTask({
            title: 'Handle request',
            description: this.request.prompt,
            role: 'worker',
            tags: ['simple'],
          });
          if (this.hasUserAcceptanceCriteria) {
            this.graph.addTask({
              title: 'Review and verify the work',
              description: 'Review the completed work against the acceptance criteria.',
              role: 'reviewer',
              dependsOn: [worker.id],
              tags: ['Review'],
            });
          }
          this.emit({ type: 'planned', snapshot: this.graph.snapshot() });
        } else {
          this.graph = this.defaultPlanner
            ? await this.planWithDefaultPlanner()
            : await this.planner.plan({
                request: this.request,
                idGenerator: this.ids,
                clock: this.clock,
                knowledge: this.knowledgeContext(),
                skills:
                  this.skills.length > 0
                    ? selectSkillsForPrompt(this.skills, this.request.prompt, {
                        role: 'planner',
                        limit: 3,
                      })
                    : [],
              });
          this.attachGraphListener();
          this.emit({ type: 'planned', snapshot: this.graph.snapshot() });
        }
        this.schedulePlanningReport();
        this.schedulePlannerRequestedReports();
      }

      await this.checkpoint();
      await this.loop();
      await this.validationGate();
      this.applyImplicitAcceptanceIfNeeded();

      const status = this.computeFinalStatus();
      this.status = status;
      const summary = this.computeSummary(status);
      // Record a durable run-outcome note so the project wiki accumulates a log
      // across runs (task-status entries are run-scoped and upsert in place).
      this.wiki.addNote({
        title: `Run ${this.id} — ${status}`,
        body: `${this.request.prompt}\n${summary}`,
        tags: ['run', status],
        source: `run:${this.id}`,
      });
      this.finished = true;
      this.emit({ type: 'run-finished', status, summary });
      // Terminal persistence is best-effort: a disk error (ENOSPC, EACCES, a
      // failed rename) when saving the final record must NOT flip an
      // already-decided outcome (e.g. 'succeeded') to 'failed' or emit a second,
      // contradictory run-finished. persistKnowledge is already self-guarding.
      await this.store.save(this.buildRecord(status, summary)).catch(() => undefined);
      await this.persistKnowledge();
      if (!this.cancelled) this.scheduleWikiSynthesis(`run:${status}`);
      await this.drainSupportWork();
      return this.buildResult(status, summary);
    } catch (err) {
      // A run that already reached its terminal state must never be re-finished
      // as 'failed' by a late error (e.g. from teardown): that would double-emit
      // run-finished and return the wrong status to the caller.
      if (this.finished) {
        return this.buildResult(this.status, this.computeSummary(this.status));
      }
      const message = errorMessage(err);
      this.emit({ type: 'error', phase: 'run', message });
      await this.hooks.emit('onError', { error: err, phase: 'run' }).catch(() => undefined);
      this.status = 'failed';
      this.finished = true;
      this.emit({ type: 'run-finished', status: 'failed', summary: message });
      await this.store.save(this.buildRecord('failed', message)).catch(() => undefined);
      return this.buildResult('failed', message);
    } finally {
      this.controlDisposer?.();
      if (this.progressTimer) {
        clearTimeout(this.progressTimer);
        this.progressTimer = null;
      }
      this.stream.end();
    }
  }

  private async loop(): Promise<void> {
    let iterations = 0;
    while (!this.cancelled && !this.budgetExhausted && iterations < this.maxIterations) {
      await this.waitIfPaused();
      if (this.cancelled) break;

      if (this.inbox.hasPending()) {
        for (const item of this.inbox.drain()) {
          this.emit({ type: 'user-input', item });
          this.applyUserInput(item);
        }
        await this.replan('user-input');
      }

      this.graph.refreshReadiness();
      const ready = this.graph.readyTasks();
      if (ready.length === 0) {
        // Either everything is terminal (done) or we're stuck on blocked tasks.
        break;
      }

      const iteration = this.startIteration(
        iterations === 0 ? 'initial-plan' : 'continue',
        ready.map((task) => task.id),
      );
      try {
        await this.runBatch(ready);
      } finally {
        this.completeIteration(iteration);
      }
      iterations += 1;
    }
  }

  /** Run the ready tasks of one iteration with bounded concurrency. */
  private async runBatch(tasks: TaskNode[]): Promise<void> {
    let next = 0;
    let laneError: unknown;
    const worker = async (): Promise<void> => {
      while (next < tasks.length && !this.cancelled && !this.budgetExhausted && laneError === undefined) {
        const task = tasks[next];
        next += 1;
        if (!task) break;
        await this.waitIfPaused();
        if (this.cancelled) break;
        try {
          await this.executeTask(task);
          await this.checkpoint();
        } catch (err) {
          // A lane that throws must not orphan its siblings: record the error,
          // stop scheduling, and abort in-flight runs so every lane settles
          // before runBatch resolves (no late checkpoint over a terminal record).
          laneError ??= err;
          this.cancelled = true;
          for (const abort of this.activeAborts) abort.abort();
        }
      }
    };
    const lanes = Math.min(this.maxConcurrency, tasks.length);
    // Workers never reject (they catch internally), so Promise.all awaits ALL
    // lanes to completion before we surface the first error.
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    if (laneError !== undefined) throw laneError;
  }

  private async executeTask(task: TaskNode): Promise<void> {
    const assignment = this.policy.select(task.role, {
      available: this.available,
      taskId: task.id,
      taskTitle: task.title,
      taskType: task.tags[0] ?? task.role,
    });
    const identity = this.createAgentIdentity(assignment, task.role, task.id);
    this.graph.incrementAttempts(task.id);
    this.graph.setStatus(task.id, 'running');
    // Persist the 'running' transition NOW (the next checkpoint is only after the
    // task finishes, which may be minutes away): so an attached client sees the
    // task go live immediately instead of staring at a stale/empty view.
    await this.checkpoint();

    const input: AgentRunInput = {
      agentId: assignment.agentId,
      prompt: this.buildPrompt(task.role, task),
      ...(this.request.cwd ? { cwd: this.request.cwd } : {}),
      model: assignment.model,
      reasoning: assignment.reasoning,
      metadata: { role: task.role, taskId: task.id, runId: this.id, ...identity },
    };

    const abort = new AbortController();
    this.activeAborts.add(abort);
    input.signal = abort.signal;

    await this.hooks
      .emit('beforeAgentRun', { role: task.role, assignment, input, task })
      .catch((e) => this.emit({ type: 'error', phase: 'beforeAgentRun', message: errorMessage(e) }));

    this.emit({ type: 'agent-assigned', role: task.role, taskId: task.id, title: task.title, assignment, ...identity });
    await this.checkpointProgress();

    const acc = createResultAccumulator();
    try {
      for await (const event of this.runtime.streamAgentEvents(input)) {
        acc.push(event);
        this.emit({ type: 'agent-event', role: task.role, taskId: task.id, assignment, ...identity, event });
        await this.checkpointProgress();
      }
    } finally {
      this.activeAborts.delete(abort);
    }
    const result: AgentRunResult = acc.result();
    this.accountUsage(result);

    await this.hooks
      .emit('afterAgentRun', { role: task.role, input, result, task })
      .catch(() => undefined);

    this.wiki.recordTask(task.id, task.title, result.status, result.text.slice(0, 500), {
      runId: this.id,
      role: task.role,
      agentId: assignment.agentId,
      tokens: usageTokens(result.usage),
      toolCount: result.toolCalls.length,
    });
    this.emitKnowledge();

    // The task's run was aborted — a sibling lane failed (runBatch aborts its
    // peers) or the whole run was cancelled. That is NOT a verdict: don't emit a
    // contradictory task-finished{success:false}, don't burn a retry attempt,
    // and don't mark it failed. Refund the attempt and record an honest
    // 'cancelled' status so the persisted plan isn't corrupted.
    if (this.cancelled || abort.signal.aborted || result.status === 'cancelled') {
      this.graph.decrementAttempts(task.id);
      this.graph.setStatus(task.id, 'cancelled');
      return;
    }

    const summary = (result.text || result.error || '').slice(0, 300);
    const ranCleanly = result.status === 'completed' && !result.error;

    if (task.role === 'reviewer') {
      // A reviewer that crashed/timed out/was cancelled has NOT reviewed
      // anything — never silently treat that as approval. Retry or fail it
      // like any other task.
      if (!ranCleanly) {
        this.graph.setResult(task.id, {
          success: false,
          summary,
          output: result.text,
          agentId: assignment.agentId,
          error: result.error ?? 'reviewer did not complete',
        });
        this.emit({ type: 'task-finished', taskId: task.id, title: task.title, role: 'reviewer', success: false, summary });
        if (task.attempts < this.maxAttempts) this.graph.setStatus(task.id, 'pending');
        else this.graph.setStatus(task.id, 'failed');
        return;
      }
      const criteria = this.acceptanceCriteriaText();
      const hasStructuredVerdict = criteria.length > 0 && hasStructuredReviewVerdict(result.text);
      const uncertain = !hasStructuredVerdict && isUncertainReviewText(result.text);
      const review: {
        approved: boolean;
        notes: string;
        criteria?: ReviewCriterion[];
        reportRequests?: AgentReportRequest[];
      } =
        uncertain && criteria.length > 0
          ? {
              approved: false,
              criteria: criteria.map((criterion) => ({
                criterion,
                met: false,
                note: 'Reviewer could not verify this criterion.',
              })),
              notes: result.text.trim(),
            }
          : criteria.length > 0
            ? parseStructuredReview(result.text, criteria)
            : { ...parseReview(result.text), criteria: undefined as ReviewCriterion[] | undefined };
      this.uncertainReviewCount = uncertain ? this.uncertainReviewCount + 1 : 0;
      this.graph.setResult(task.id, {
        success: review.approved,
        summary,
        output: result.text,
        agentId: assignment.agentId,
      });
      // For a reviewer, task-finished.success reflects the verdict, not just
      // that the agent ran — so the two events never contradict each other.
      this.emit({ type: 'task-finished', taskId: task.id, title: task.title, role: 'reviewer', success: review.approved, summary });
      this.emit({
        type: 'review',
        taskId: task.id,
        approved: review.approved,
        notes: review.notes.slice(0, 300),
        ...(review.criteria ? { criteria: review.criteria } : {}),
      });
      if (review.criteria) {
        this.setAcceptance(
          applyStructuredReview(this.acceptance.criteria, review.criteria, {
            clock: this.clock,
            taskId: task.id,
          }),
        );
      }
      this.scheduleAgentRequestedReports('reviewer', review.reportRequests ?? [], task.id);
      this.scheduleReviewReport(task.id, review.approved, review.notes.slice(0, 300));
      if (review.approved) this.graph.setStatus(task.id, 'succeeded');
      else if (uncertain && this.uncertainReviewCount >= 2) {
        const gate = await this.openRiskGate({
          reason: 'review-uncertain',
          question: 'Reviewer could not verify the acceptance criteria twice. Continue, edit criteria, or stop?',
          taskId: task.id,
        });
        if (this.cancelled) return;
        await this.handleReviewRejection(
          task,
          `${review.notes}\nUser gate answer: ${gate.answer ?? '(no answer)'}`,
        );
      } else {
        await this.handleReviewRejection(task, review.notes);
      }
      return;
    }

    this.graph.setResult(task.id, {
      success: ranCleanly,
      summary,
      output: result.text,
      agentId: assignment.agentId,
      ...(result.error ? { error: result.error } : {}),
    });
    this.emit({ type: 'task-finished', taskId: task.id, title: task.title, role: task.role, success: ranCleanly, summary });

    if (ranCleanly) {
      this.graph.setStatus(task.id, 'succeeded');
    } else if (task.attempts < this.maxAttempts) {
      this.graph.setStatus(task.id, 'pending');
    } else {
      this.graph.setStatus(task.id, 'failed');
    }
  }

  /** Accumulate token/cost spend and trip the budget once a ceiling is hit. */
  private accountUsage(result: AgentRunResult): void {
    const usage = result.usage;
    if (usage) {
      this.spentTokens +=
        usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
    if (typeof result.costUsd === 'number') this.spentCostUsd += result.costUsd;
    if (this.budgetExhausted || !this.budget) return;
    const overTokens =
      this.budget.maxTokens != null && this.spentTokens >= this.budget.maxTokens;
    const overCost =
      this.budget.maxCostUsd != null && this.spentCostUsd >= this.budget.maxCostUsd;
    if (overTokens || overCost) {
      this.budgetExhausted = true;
      this.emit({
        type: 'budget-exhausted',
        spentTokens: this.spentTokens,
        spentCostUsd: this.spentCostUsd,
        limit: { ...this.budget },
      });
    }
  }

  private async handleReviewRejection(reviewer: TaskNode, notes: string): Promise<void> {
    if (reviewer.attempts >= this.maxAttempts) {
      this.graph.setStatus(reviewer.id, 'failed');
      return;
    }
    const fix = this.graph.addTask({
      title: `Address review feedback (round ${reviewer.attempts})`,
      description: `Revise the work to address the reviewer feedback:\n${notes}`,
      role: 'worker',
      tags: ['rework'],
    });
    reviewer.dependsOn.push(fix.id);
    this.graph.setStatus(reviewer.id, 'pending');
    await this.replan('review-rejected');
  }

  private async loadPersistedKnowledge(): Promise<void> {
    if (!this.knowledgeStore) return;
    try {
      const wikiSnapshot = await this.knowledgeStore.loadWiki();
      if (wikiSnapshot) this.wiki = ProjectWiki.fromJSON(wikiSnapshot, { clock: this.clock });
      const shouldRefreshCodegraph = !this.codegraph;
      if (shouldRefreshCodegraph) {
        const cgSnapshot = await this.knowledgeStore.loadCodegraph();
        if (cgSnapshot) this.codegraph = CodeGraph.fromJSON(cgSnapshot);
      }
      if (shouldRefreshCodegraph && this.request.cwd) {
        this.codegraph = await CodeGraph.scan({ root: this.request.cwd });
      }
    } catch {
      // Corrupt persisted knowledge is non-fatal — start from what we have.
    }
  }

  private async persistKnowledge(): Promise<void> {
    if (!this.knowledgeStore) return;
    try {
      // Merge against the on-disk wiki (union by entry id, this run's entries
      // win) rather than overwriting wholesale — otherwise a resumed run, or a
      // run that started before a sibling wrote, would clobber the shared
      // cross-run accumulator. Prefer the store's atomic, lock-serialized
      // mergeWiki so two concurrent runs that checkpoint at once can't lose
      // each other's entries through interleaved load-merge-save; fall back to
      // a caller-side merge for stores that don't implement it.
      const entries = this.wiki.toJSON().entries;
      if (this.knowledgeStore.mergeWiki) {
        await this.knowledgeStore.mergeWiki(entries);
      } else {
        const onDisk = await this.knowledgeStore.loadWiki();
        const byId = new Map((onDisk?.entries ?? []).map((e) => [e.id, e] as const));
        for (const entry of entries) byId.set(entry.id, entry);
        await this.knowledgeStore.saveWiki({ entries: [...byId.values()] });
      }
      if (this.codegraph) await this.knowledgeStore.saveCodegraph(this.codegraph.toJSON());
      if (this.knowledgeEvents.length > 0) {
        const onDisk = await this.knowledgeStore.loadKnowledgeEvents();
        const byId = new Map(onDisk.map((event) => [event.id, event] as const));
        for (const event of this.knowledgeEvents) byId.set(event.id, event);
        await this.knowledgeStore.saveKnowledgeEvents([...byId.values()]);
      }
    } catch {
      // Best-effort persistence; never fail a run over it.
    }
  }

  private applyUserInput(item: InboxItemSnapshot): void {
    const text = item.text;
    if (item.kind === 'requirement') {
      this.appendAcceptanceCriterion(text, 'user');
    }
    const worker = this.graph.addTask({
      title: `User input: ${text.slice(0, 48)}`,
      description: text,
      role: 'worker',
      tags: ['user-input'],
    });
    this.ensureReviewerForUpdatedRequirements(worker.id);
  }

  private ensureReviewerForUpdatedRequirements(workerId: string): void {
    const reviewer = [...this.graph.tasks()]
      .reverse()
      .find((t) => t.role === 'reviewer' && t.status !== 'failed' && t.status !== 'cancelled');
    if (reviewer) {
      if (!reviewer.dependsOn.includes(workerId)) reviewer.dependsOn.push(workerId);
      if (reviewer.status === 'succeeded' || reviewer.status === 'ready') {
        this.graph.setStatus(reviewer.id, 'pending');
      }
      return;
    }
    if (!this.requiresExplicitAcceptance()) return;
    const dependsOn = this.graph
      .tasks()
      .filter((task) => task.role !== 'reviewer')
      .map((task) => task.id);
    this.graph.addTask({
      title: 'Review and verify updated requirements',
      description: 'Review completed work against the updated user acceptance criteria.',
      role: 'reviewer',
      dependsOn,
      tags: ['Review'],
    });
  }

  private requiresExplicitAcceptance(): boolean {
    return (
      this.hasUserAcceptanceCriteria ||
      this.acceptance.criteria.some(
        (criterion) =>
          criterion.source === 'user' ||
          criterion.source === 'reviewer' ||
          criterion.source === 'replan' ||
          criterion.source === 'spec',
      )
    );
  }

  private async replan(reason: ReplanReason): Promise<void> {
    const snapshot = this.graph.snapshot();
    await this.hooks.emit('beforeReplan', { reason, snapshot }).catch(() => undefined);
    this.emit({ type: 'replanned', reason, snapshot });
    await this.hooks.emit('afterReplan', { reason, snapshot }).catch(() => undefined);
  }

  private async checkpoint(): Promise<void> {
    if (this.finished) return; // never overwrite the terminal record
    this.checkpointSeq += 1;
    this.emit({ type: 'heartbeat', at: this.clock() });
    const status = this.status === 'waiting-for-user' ? 'waiting-for-user' : 'running';
    await this.store.save(this.buildRecord(status, this.computeSummary(status)));
    await this.persistKnowledge();
  }

  private async checkpointProgress(): Promise<void> {
    if (this.finished) return;
    this.checkpointSeq += 1;
    this.emit({ type: 'heartbeat', at: this.clock() });
    if (this.streamFlushMs <= 0) {
      await this.saveProgress();
      return;
    }
    // Throttle: stream events fire faster than disk should be written. Save now
    // if a flush window has elapsed; otherwise mark dirty and let a trailing
    // timer flush the latest state, so the client still sees live streaming.
    this.progressDirty = true;
    const now = this.clock();
    if (now - this.lastProgressFlush >= this.streamFlushMs) {
      await this.flushProgress();
    } else if (!this.progressTimer) {
      this.progressTimer = setTimeout(() => {
        this.progressTimer = null;
        void this.flushProgress();
      }, this.streamFlushMs);
      this.progressTimer.unref?.();
    }
  }

  private async flushProgress(): Promise<void> {
    if (!this.progressDirty || this.finished) return;
    this.progressDirty = false;
    this.lastProgressFlush = this.clock();
    await this.saveProgress();
  }

  private async saveProgress(): Promise<void> {
    const status = this.status === 'waiting-for-user' ? 'waiting-for-user' : 'running';
    await this.store.save(this.buildRecord(status, this.computeSummary(status))).catch(() => undefined);
  }

  private async checkpointSupportProgress(options: { persistKnowledge?: boolean } = {}): Promise<void> {
    this.checkpointSeq += 1;
    this.emit({ type: 'heartbeat', at: this.clock() });
    const status = this.finished ? this.status : this.status === 'waiting-for-user' ? 'waiting-for-user' : 'running';
    await this.store.save(this.buildRecord(status, this.computeSummary(status))).catch(() => undefined);
    if (options.persistKnowledge) await this.persistKnowledge();
  }

  private applyImplicitAcceptanceIfNeeded(): void {
    if (this.requiresExplicitAcceptance() || !this.graph.succeeded() || this.acceptance.progress.complete) return;
    const now = this.clock();
    this.setAcceptance(
      this.acceptance.criteria.map((criterion) => ({
        ...criterion,
        status: 'pass',
        evidence: [
          ...criterion.evidence,
          { text: 'All planned tasks succeeded', createdAt: now },
        ],
        updatedAt: now,
      })),
    );
  }

  private computeFinalStatus(): RunStatus {
    if (this.cancelled) return 'cancelled';
    const tasks = this.graph.tasks();
    if (tasks.length === 0) return 'succeeded';
    if (tasks.every((t) => t.status === 'succeeded')) {
      if (this.requiresExplicitAcceptance() && !this.acceptance.progress.complete) return 'incomplete';
      // Objective verification (tests) never went green within the gate's rounds.
      if (this.verificationFailed) return 'incomplete';
      return 'succeeded';
    }
    if (tasks.some((t) => t.status === 'failed' || t.status === 'blocked')) return 'failed';
    // Non-terminal, non-failed work remains (e.g. the iteration cap was hit):
    // the run made progress but isn't done. Distinct from a hard failure.
    return 'incomplete';
  }

  private computeSummary(status: RunStatus): string {
    const stats = this.graph.stats();
    return `${status}: ${stats.succeeded}/${this.graph.size} tasks succeeded`;
  }

  private buildRecord(status: RunStatus, summary: string): RunRecord {
    const now = this.clock();
    return {
      id: this.id,
      request: this.request,
      mode: this.mode,
      status,
      ...(this.routeDecision ? { routeDecision: this.routeDecision } : {}),
      plan: this.graph.snapshot(),
      wiki: this.wiki.toJSON(),
      acceptance: this.acceptance,
      iterations: this.iterations,
      riskGates: this.riskGates,
      reports: this.reports,
      knowledgeEvents: this.knowledgeEvents,
      inbox: this.inbox.snapshot(),
      events: this.eventLog,
      summary,
      spentTokens: this.spentTokens,
      spentCostUsd: this.spentCostUsd,
      lastControlSeq: this.lastControlSeq,
      createdAt: this.createdAt,
      updatedAt: now,
      heartbeatAt: now,
      checkpointSeq: this.checkpointSeq,
    };
  }

  private buildResult(status: RunStatus, summary: string): RunResult {
    return {
      id: this.id,
      status,
      summary,
      plan: this.graph.snapshot(),
      wiki: this.wiki.toJSON(),
      acceptance: this.acceptance,
      iterations: this.iterations,
      riskGates: this.riskGates,
      reports: this.reports,
      knowledgeEvents: this.knowledgeEvents,
      events: [...this.eventLog],
      spentTokens: this.spentTokens,
      spentCostUsd: this.spentCostUsd,
    };
  }
}

export class Orchestrator {
  private readonly runIds: IdGenerator;

  constructor(private readonly options: OrchestratorOptions) {
    // A shared generator so every start() gets a distinct run id and runs never
    // collide in the store (the per-run task generator is separate).
    this.runIds = options.idGenerator ?? createUniqueRunIdGenerator();
  }

  /** Start a new run and return a streaming handle. */
  start(request: OrchestrationRequest): RunHandle {
    return new RunController(this.options, request, undefined, this.runIds.next('run'));
  }

  /** Resume a previously persisted run; returns null if not found or no store. */
  async resume(runId: string): Promise<RunHandle | null> {
    const store = this.options.store ?? null;
    if (!store) return null;
    const record = await store.load(runId);
    if (!record) return null;
    return new RunController(this.options, record.request, record);
  }
}
