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
  type AcceptanceCriterion,
} from './acceptance.js';
import { createIteration, finishIteration, type IterationSnapshot } from './iterations.js';
import { answerRiskGate, createRiskGate, type RiskGateSnapshot } from './risk-gates.js';
import { createReportArtifact, type ReportArtifact, type ReportKind } from './reports.js';
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
import type { AcceptanceSnapshot, OrchestratorEvent, ReviewCriterion, RunStatus } from './run-events.js';
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
}

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
}

/**
 * Parse a reviewer's per-criterion verdict. Expects a JSON array (same order as
 * `criteria`) of `{ met: boolean, note?: string }`. Approved iff every criterion
 * is met. Falls back to {@link parseReview} (applying the overall verdict to all
 * criteria) when the JSON can't be parsed.
 */
export function parseStructuredReview(text: string, criteria: string[]): StructuredReview {
  const arr = extractJsonArray(text);
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
    };
  }
  const fallback = parseReview(text);
  return {
    approved: fallback.approved,
    criteria: criteria.map((criterion) => ({ criterion, met: fallback.approved })),
    notes: fallback.notes,
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
  private readonly maxAttempts: number;
  private readonly maxConcurrency: number;
  private readonly budget: RunBudget | undefined;
  private spentTokens = 0;
  private spentCostUsd = 0;
  private budgetExhausted = false;
  private readonly hasUserAcceptanceCriteria: boolean;

  private readonly stream = createPushStream<OrchestratorEvent>();
  private readonly eventLog: OrchestratorEvent[] = [];
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
    this.detectionOptions = options.detectionOptions;
    this.maxIterations = options.maxIterations ?? 50;
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
    const nextStrategy =
      this.cancelled ? 'cancel' : failedCriteria.length > 0 ? 'replan' : this.graph.isComplete() ? 'finish' : 'continue';
    const updated = finishIteration(iteration, {
      status: 'complete',
      reviewSummary: this.computeSummary('running'),
      failedCriteria,
      nextStrategy,
      clock: this.clock,
    });
    this.iterations = this.iterations.map((item) => (item.id === updated.id ? updated : item));
    this.emit({ type: 'iteration-updated', iteration: updated, iterations: this.iterations });
  }

  private acceptanceCriteriaText(): string[] {
    return this.acceptance.criteria.map((criterion) => criterion.title);
  }

  private createReport(kind: ReportKind, title: string, summary: string, markdown: string, taskId?: string): void {
    const report = createReportArtifact({
      runId: this.id,
      kind,
      title,
      summary,
      markdown,
      ...(taskId ? { taskId } : {}),
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    this.reports = [...this.reports, report];
    this.emit({ type: 'report-created', report, reports: this.reports });

    const knowledge = createKnowledgeEvent({
      runId: this.id,
      kind: 'report',
      title,
      body: summary,
      ...(taskId ? { taskId } : {}),
      reportId: report.id,
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
  }

  private createPlanningReport(): void {
    const tasks = this.graph.tasks();
    const summary = `Planned ${tasks.length} task(s).`;
    const markdown = [
      '# Planning report',
      '',
      summary,
      '',
      ...tasks.map((task) => `- ${task.id}: ${task.title} [${task.role}]`),
    ].join('\n');
    this.createReport('planning', 'Planning report', summary, markdown);
  }

  private createReviewReport(taskId: string, approved: boolean, notes: string): void {
    const summary = `Review ${approved ? 'approved' : 'rejected'}: ${notes || '(no notes)'}`;
    const markdown = [
      '# Review report',
      '',
      summary,
      '',
      `Acceptance: ${this.acceptance.progress.passed}/${this.acceptance.progress.total}`,
    ].join('\n');
    this.createReport('review', 'Review report', summary, markdown, taskId);
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
        if (command.criteria) this.replaceAcceptanceCriteria(command.criteria);
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
      'Respond with ONLY a JSON array of objects.',
      'Each object must be: {"title": string, "description": string, "phase": string, "dependsOn": number[]}.',
      'phase is the user-visible stage name shown in the TUI, such as Discovery, Core, TUI, Verification, or Docs.',
      'For broad requests, create 3-7 focused worker tasks and prefer independent tasks that can run in parallel.',
      'Do not collapse unrelated work into one task.',
      'dependsOn uses zero-based indices of earlier tasks.',
      '',
      `Request: ${this.request.prompt}`,
      knowledge ? `\nProject context:\n${knowledge}` : '',
      skills.length > 0 ? `\nApplicable skills:\n${renderSkillContext(skills)}` : '',
    ].join('\n');
  }

  private graphFromAgentPlan(text: string): PlanGraph | null {
    const arr = extractJsonArray(text);
    if (!arr || arr.length === 0) return null;
    const graph = new PlanGraph({ idGenerator: this.ids, clock: this.clock });
    const ids: string[] = [];
    for (const raw of arr) {
      const item = raw as { title?: unknown; description?: unknown; dependsOn?: unknown };
      const title =
        typeof item.title === 'string' && item.title.trim()
          ? item.title.replace(/\s+/g, ' ').trim().slice(0, 72)
          : 'Task';
      const description =
        typeof item.description === 'string' && item.description.trim()
          ? item.description
          : title;
      const dependsOn = Array.isArray(item.dependsOn)
        ? item.dependsOn
            .map((idx) => (typeof idx === 'number' ? ids[idx] : undefined))
            .filter((id): id is string => Boolean(id))
        : [];
      const task = graph.addTask({
        title,
        description,
        role: 'worker',
        dependsOn,
        tags: tagsFromAgentPlanTask(raw, title),
      });
      ids.push(task.id);
    }
    graph.addTask({
      title: 'Review and verify the work',
      description: 'Review the completed work against the original request.',
      role: 'reviewer',
      dependsOn: ids,
      tags: ['Review'],
    });
    graph.refreshReadiness();
    return graph;
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

    const input: AgentRunInput = {
      agentId: assignment.agentId,
      prompt: this.plannerPrompt(),
      ...(this.request.cwd ? { cwd: this.request.cwd } : {}),
      model: assignment.model,
      reasoning: assignment.reasoning,
      metadata: { role: 'planner' },
    };
    const acc = createResultAccumulator();
    try {
      for await (const event of this.runtime.streamAgentEvents(input)) {
        acc.push(event);
        this.emit({ type: 'agent-event', role: 'planner', taskId: null, assignment, event });
        await this.checkpointProgress();
      }
    } catch (err) {
      this.emit({ type: 'error', phase: 'planner', message: errorMessage(err) });
      return fallback();
    }
    const result = acc.result();
    this.accountUsage(result);
    const graph = result.status === 'completed' ? this.graphFromAgentPlan(result.text) : null;
    return graph ?? fallback();
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

  private buildPrompt(role: AgentRole, task: TaskNode): string {
    const knowledge = this.knowledgeContext();
    const skills = this.skillContext(role, `${task.title} ${task.description}`);
    if (role === 'reviewer') {
      const completed = task.dependsOn
        .map((id) => this.graph.get(id))
        .filter((t): t is TaskNode => Boolean(t))
        .map((t) => `- ${t.title}: ${t.result?.summary ?? '(no summary)'}`)
        .join('\n');
      const criteria = this.acceptanceCriteriaText();
      if (criteria.length > 0) {
        return [
          'You are reviewing completed work against acceptance criteria.',
          'For EACH criterion decide whether it is met. Respond with ONLY a JSON',
          'array in the SAME order: [{"met": true|false, "note": "why"}].',
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
        this.createPlanningReport();
      }

      await this.checkpoint();
      await this.loop();
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
          this.applyUserInput(item.text);
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
      metadata: { role: task.role, taskId: task.id },
    };

    const abort = new AbortController();
    this.activeAborts.add(abort);
    input.signal = abort.signal;

    await this.hooks
      .emit('beforeAgentRun', { role: task.role, assignment, input, task })
      .catch((e) => this.emit({ type: 'error', phase: 'beforeAgentRun', message: errorMessage(e) }));

    const acc = createResultAccumulator();
    try {
      for await (const event of this.runtime.streamAgentEvents(input)) {
        acc.push(event);
        this.emit({ type: 'agent-event', role: task.role, taskId: task.id, assignment, event });
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
      const hasStructuredVerdict = criteria.length > 0 && Boolean(extractJsonArray(result.text));
      const uncertain = !hasStructuredVerdict && isUncertainReviewText(result.text);
      const review =
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
      this.createReviewReport(task.id, review.approved, review.notes.slice(0, 300));
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

  private applyUserInput(text: string): void {
    const worker = this.graph.addTask({
      title: `User input: ${text.slice(0, 48)}`,
      description: text,
      role: 'worker',
      tags: ['user-input'],
    });
    const reviewer = [...this.graph.tasks()]
      .reverse()
      .find((t) => t.role === 'reviewer' && t.status !== 'failed');
    if (reviewer) {
      reviewer.dependsOn.push(worker.id);
      if (reviewer.status === 'succeeded' || reviewer.status === 'ready') {
        this.graph.setStatus(reviewer.id, 'pending');
      }
    }
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
    const status = this.status === 'waiting-for-user' ? 'waiting-for-user' : 'running';
    await this.store.save(this.buildRecord(status, this.computeSummary(status))).catch(() => undefined);
  }

  private applyImplicitAcceptanceIfNeeded(): void {
    if (this.hasUserAcceptanceCriteria || !this.graph.succeeded() || this.acceptance.progress.complete) return;
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
      if (this.hasUserAcceptanceCriteria && !this.acceptance.progress.complete) return 'incomplete';
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
