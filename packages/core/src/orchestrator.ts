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
import { createIdGenerator, type IdGenerator } from './ids.js';
import { CodeGraph } from './knowledge/codegraph.js';
import { ProjectWiki } from './knowledge/wiki.js';
import type { KnowledgeStore } from './knowledge/store.js';
import { createModelPolicy, type ModelPolicy } from './modes/policy.js';
import { Inbox, type InboxAppendOptions } from './inbox.js';
import {
  PlanGraph,
  type ReplanReason,
  type TaskNode,
} from './plan/plan-graph.js';
import { RulePlanner, extractJsonArray, type Planner } from './plan/planner.js';
import { RuleRouter, type RouteDecision, type Router } from './router/router.js';
import { MemoryRunStore } from './supervisor/run-store.js';
import type { RunRecord, RunStore } from './supervisor/run-store.js';
import type { ControlPoll, ControlSource } from './supervisor/control.js';
import type { OrchestratorEvent, ReviewCriterion, RunStatus } from './run-events.js';
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

/** Parse a reviewer's free-form verdict. */
export function parseReview(text: string): { approved: boolean; notes: string } {
  const lower = text.toLowerCase();
  const rejects = /\b(reject|rejected|needs work|needs more|incomplete|not done|insufficient|revise|fail(?:ed|s)?)\b/.test(
    lower,
  );
  const approves = /\b(approve|approved|lgtm|looks good|pass(?:ed|es)?|complete|all good|done)\b/.test(
    lower,
  );
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

class RunController implements RunHandle {
  readonly id: string;
  readonly result: Promise<RunResult>;

  private readonly request: OrchestrationRequest;
  private readonly mode: WorkMode;
  private readonly runtime: AgentRuntime;
  private readonly router: Router;
  private readonly planner: Planner;
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

  private readonly stream = createPushStream<OrchestratorEvent>();
  private readonly eventLog: OrchestratorEvent[] = [];
  private readonly inbox: Inbox;
  private wiki: ProjectWiki;
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
    this.router = options.router ?? new RuleRouter();
    this.planner = options.planner ?? new RulePlanner();
    this.policy =
      options.policy ??
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
    this.resuming = Boolean(resumeFrom);
    this.createdAt = resumeFrom?.createdAt ?? this.clock();

    if (resumeFrom) {
      this.id = resumeFrom.id;
      this.ids = options.idGenerator ?? createIdGenerator(resumeFrom.checkpointSeq + 1000);
      this.routeDecision = resumeFrom.routeDecision;
      this.wiki = ProjectWiki.fromJSON(resumeFrom.wiki, { clock: this.clock });
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
    this.pauseGate?.resolve();
    this.pauseGate = null;
  }

  appendUserInput(text: string, options: InboxAppendOptions = {}): void {
    this.inbox.append(text, options);
  }

  // ── Internals ────────────────────────────────────────────────────────────────
  private emit(event: OrchestratorEvent): void {
    this.eventLog.push(event);
    this.stream.push(event);
  }

  private attachGraphListener(): void {
    this.graph.setStatusListener((change) => {
      this.emit({
        type: 'task-status',
        taskId: change.task.id,
        title: change.task.title,
        from: change.from,
        to: change.to,
      });
      void this.hooks.emit('onTaskStatusChange', {
        task: change.task,
        from: change.from,
        to: change.to,
      });
    });
  }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.cancelled) {
      if (!this.pauseGate) this.pauseGate = deferred();
      await this.pauseGate.promise;
    }
  }

  /**
   * Consult the cross-process {@link ControlSource} and apply any newly-issued
   * command (seq > last applied) by calling the SAME in-process methods a
   * keypress used to. Idempotent across polls/restart via the seq guard. A
   * `stop` maps to {@link cancel} — which aborts the in-flight agent immediately
   * — so it takes effect mid-run, not at a task boundary.
   */
  private async applyControl(): Promise<void> {
    if (!this.control) return;
    let command;
    try {
      command = await this.control.read(this.id);
    } catch {
      return; // a torn/unreadable control file is non-fatal
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
    }
  }

  private emitKnowledge(): void {
    this.emit({
      type: 'knowledge-updated',
      wikiEntries: this.wiki.size,
      codegraphFiles: this.codegraph ? this.codegraph.size : null,
    });
  }

  private async detectAvailable(): Promise<DetectedAgent[]> {
    try {
      return await this.runtime.detect(this.detectionOptions);
    } catch {
      return [];
    }
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
      const criteria = this.request.acceptanceCriteria ?? [];
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
      if (!this.resuming) await this.loadPersistedKnowledge();

      if (!this.resuming) {
        await this.hooks.emit('beforeRoute', { request: this.request });
        this.routeDecision = await this.router.route(this.request);
        await this.hooks.emit('afterRoute', { request: this.request, decision: this.routeDecision });
        this.emit({ type: 'routed', decision: this.routeDecision });

        if (this.routeDecision.kind === 'simple') {
          this.graph.addTask({
            title: 'Handle request',
            description: this.request.prompt,
            role: 'worker',
            tags: ['simple'],
          });
        } else {
          this.graph = await this.planner.plan({
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
      }

      await this.checkpoint();
      await this.loop();

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

      await this.runBatch(ready);
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
    const assignment = this.policy.select(task.role, { available: this.available });
    this.graph.incrementAttempts(task.id);
    this.graph.setStatus(task.id, 'running');

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
      }
    } finally {
      this.activeAborts.delete(abort);
    }
    const result: AgentRunResult = acc.result();
    this.accountUsage(result);

    await this.hooks
      .emit('afterAgentRun', { role: task.role, input, result, task })
      .catch(() => undefined);

    this.wiki.recordTask(task.id, task.title, result.status, result.text.slice(0, 500));
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
      const criteria = this.request.acceptanceCriteria ?? [];
      const review =
        criteria.length > 0
          ? parseStructuredReview(result.text, criteria)
          : { ...parseReview(result.text), criteria: undefined as ReviewCriterion[] | undefined };
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
      if (review.approved) this.graph.setStatus(task.id, 'succeeded');
      else await this.handleReviewRejection(task, review.notes);
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
      if (!this.codegraph) {
        const cgSnapshot = await this.knowledgeStore.loadCodegraph();
        if (cgSnapshot) this.codegraph = CodeGraph.fromJSON(cgSnapshot);
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
    await this.store.save(this.buildRecord('running', this.computeSummary('running')));
    await this.persistKnowledge();
  }

  private computeFinalStatus(): RunStatus {
    if (this.cancelled) return 'cancelled';
    const tasks = this.graph.tasks();
    if (tasks.length === 0) return 'succeeded';
    if (tasks.every((t) => t.status === 'succeeded')) return 'succeeded';
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
      inbox: this.inbox.snapshot(),
      events: this.eventLog,
      summary,
      spentTokens: this.spentTokens,
      spentCostUsd: this.spentCostUsd,
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
    this.runIds = options.idGenerator ?? createIdGenerator();
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
