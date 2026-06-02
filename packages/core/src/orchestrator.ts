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
import { createModelPolicy, type ModelPolicy } from './modes/policy.js';
import { Inbox, type InboxAppendOptions } from './inbox.js';
import {
  PlanGraph,
  type ReplanReason,
  type TaskNode,
} from './plan/plan-graph.js';
import { RulePlanner, type Planner } from './plan/planner.js';
import { RuleRouter, type RouteDecision, type Router } from './router/router.js';
import { MemoryRunStore } from './supervisor/run-store.js';
import type { RunRecord, RunStore } from './supervisor/run-store.js';
import type { OrchestratorEvent, RunStatus } from './run-events.js';
import type { AgentRole, OrchestrationRequest, WorkMode } from './types.js';

export interface RunResult {
  id: string;
  status: RunStatus;
  summary: string;
  plan: RunRecord['plan'];
  wiki: RunRecord['wiki'];
  events: OrchestratorEvent[];
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
  skills?: SkillInfo[];
  codegraph?: CodeGraph;
  idGenerator?: IdGenerator;
  clock?: () => number;
  detectionOptions?: DetectionOptions;
  maxIterations?: number;
  maxAttemptsPerTask?: number;
  defaultMode?: WorkMode;
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
  if (rejects && !approves) return { approved: false, notes };
  if (approves && !rejects) return { approved: true, notes };
  // Ambiguous: default to approve to avoid livelock, unless an explicit reject term appears.
  return { approved: !rejects, notes };
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
  private readonly codegraph: CodeGraph | undefined;
  private readonly ids: IdGenerator;
  private readonly clock: () => number;
  private readonly detectionOptions: DetectionOptions | undefined;
  private readonly maxIterations: number;
  private readonly maxAttempts: number;

  private readonly stream = createPushStream<OrchestratorEvent>();
  private readonly eventLog: OrchestratorEvent[] = [];
  private readonly inbox: Inbox;
  private wiki: ProjectWiki;
  private graph: PlanGraph;
  private routeDecision: RouteDecision | undefined;
  private available: DetectedAgent[] = [];

  private status: RunStatus = 'pending';
  private paused = false;
  private cancelled = false;
  private pauseGate: Deferred | null = null;
  private activeAbort: AbortController | null = null;
  private checkpointSeq = 0;
  private readonly createdAt: number;
  private readonly resuming: boolean;

  get events(): AsyncIterable<OrchestratorEvent> {
    return this.stream.iterable;
  }

  constructor(options: OrchestratorOptions, request: OrchestrationRequest, resumeFrom?: RunRecord) {
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
    this.clock = options.clock ?? (() => Date.now());
    this.detectionOptions = options.detectionOptions;
    this.maxIterations = options.maxIterations ?? 50;
    this.maxAttempts = options.maxAttemptsPerTask ?? 3;
    this.resuming = Boolean(resumeFrom);
    this.createdAt = resumeFrom?.createdAt ?? this.clock();

    if (resumeFrom) {
      this.id = resumeFrom.id;
      this.ids = options.idGenerator ?? createIdGenerator(resumeFrom.checkpointSeq + 1000);
      this.routeDecision = resumeFrom.routeDecision;
      this.wiki = ProjectWiki.fromJSON(resumeFrom.wiki);
      this.graph = PlanGraph.fromSnapshot(resumeFrom.plan, { clock: this.clock });
      this.inbox = Inbox.restore(resumeFrom.inbox, { clock: this.clock });
      this.eventLog.push(...resumeFrom.events);
      this.checkpointSeq = resumeFrom.checkpointSeq;
    } else {
      this.ids = options.idGenerator ?? createIdGenerator();
      this.id = this.ids.next('run');
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
    this.activeAbort?.abort();
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
      this.emit({ type: 'run-started', runId: this.id, request: this.request, mode: this.mode });
      this.available = await this.detectAvailable();

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
      this.emit({ type: 'run-finished', status, summary });
      await this.store.save(this.buildRecord(status, summary));
      return this.buildResult(status, summary);
    } catch (err) {
      const message = errorMessage(err);
      this.emit({ type: 'error', phase: 'run', message });
      await this.hooks.emit('onError', { error: err, phase: 'run' }).catch(() => undefined);
      this.status = 'failed';
      this.emit({ type: 'run-finished', status: 'failed', summary: message });
      await this.store.save(this.buildRecord('failed', message)).catch(() => undefined);
      return this.buildResult('failed', message);
    } finally {
      this.stream.end();
    }
  }

  private async loop(): Promise<void> {
    let iterations = 0;
    while (!this.cancelled && iterations < this.maxIterations) {
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

      for (const task of ready) {
        await this.waitIfPaused();
        if (this.cancelled) break;
        await this.executeTask(task);
        await this.checkpoint();
        if (this.cancelled) break;
      }
      iterations += 1;
    }
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
    this.activeAbort = abort;
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
      this.activeAbort = null;
    }
    const result: AgentRunResult = acc.result();

    await this.hooks
      .emit('afterAgentRun', { role: task.role, input, result, task })
      .catch(() => undefined);

    this.wiki.recordTask(task.id, task.title, result.status, result.text.slice(0, 500));
    this.emitKnowledge();

    const summary = (result.text || result.error || '').slice(0, 300);
    const success = result.status === 'completed' && !result.error;
    this.graph.setResult(task.id, {
      success,
      summary,
      output: result.text,
      agentId: assignment.agentId,
      ...(result.error ? { error: result.error } : {}),
    });
    this.emit({ type: 'task-finished', taskId: task.id, title: task.title, role: task.role, success, summary });

    if (task.role === 'reviewer') {
      const review = parseReview(result.text);
      this.emit({ type: 'review', taskId: task.id, approved: review.approved, notes: review.notes.slice(0, 300) });
      if (review.approved) {
        this.graph.setStatus(task.id, 'succeeded');
      } else {
        await this.handleReviewRejection(task, review.notes);
      }
      return;
    }

    if (success) {
      this.graph.setStatus(task.id, 'succeeded');
    } else if (task.attempts < this.maxAttempts) {
      this.graph.setStatus(task.id, 'pending');
    } else {
      this.graph.setStatus(task.id, 'failed');
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
    this.checkpointSeq += 1;
    this.emit({ type: 'heartbeat', at: this.clock() });
    await this.store.save(this.buildRecord('running', this.computeSummary('running')));
  }

  private computeFinalStatus(): RunStatus {
    if (this.cancelled) return 'cancelled';
    const tasks = this.graph.tasks();
    if (tasks.length === 0) return 'succeeded';
    if (tasks.every((t) => t.status === 'succeeded')) return 'succeeded';
    if (tasks.some((t) => t.status === 'failed' || t.status === 'blocked')) return 'failed';
    // Ran out of iterations with work still pending.
    return tasks.every((t) => t.status === 'succeeded') ? 'succeeded' : 'failed';
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
    };
  }
}

export class Orchestrator {
  constructor(private readonly options: OrchestratorOptions) {}

  /** Start a new run and return a streaming handle. */
  start(request: OrchestrationRequest): RunHandle {
    return new RunController(this.options, request);
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
