import {
  BUILTIN_AGENT_ID,
  createPushStream,
  createResultAccumulator,
  errorMessage,
  type AgentEvent,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRuntime,
  type DetectedAgent,
  type DetectionOptions,
} from '@omakase/daemon';
import { createIdGenerator, createUniqueRunIdGenerator, type IdGenerator } from '../../ids.js';
import { ProjectWiki } from '../../knowledge/wiki.js';
import type { KnowledgeStore } from '../../knowledge/store.js';
import {
  createKnowledgeEvent,
  knowledgeEventToWikiEntry,
  type KnowledgeEvent,
} from '../../knowledge/events.js';
import { createModelPolicy, type ModelPolicy, type RoleAssignment } from '../../modes/policy.js';
import { PlanGraph } from '../../plan/plan-graph.js';
import { cleanAgentArtifactText, createReportArtifact, type ReportArtifact } from '../../reports.js';
import type { OrchestratorEvent, RunStatus } from '../../run-events.js';
import type { AgentRole, OrchestrationRequest } from '../../types.js';
import { MemoryRunStore, type RunRecord, type RunStore } from '../../supervisor/run-store.js';
import { BunWorkflowScriptRunner } from './script-runner.js';
import {
  validateWorkflowScriptSource,
  WorkflowScriptValidationError,
} from './validator.js';
import type {
  DynamicWorkflowAgentInput,
  DynamicWorkflowAgentResult,
  DynamicWorkflowApi,
  DynamicWorkflowCheckpointInput,
  DynamicWorkflowHostApi,
  DynamicWorkflowReportInput,
  DynamicWorkflowSnapshot,
  DynamicWorkflowWikiInput,
  WorkflowAgentSnapshot,
  WorkflowCheckpoint,
  WorkflowPhaseSnapshot,
  WorkflowPhaseStatus,
  WorkflowScriptArtifact,
  WorkflowScriptRunner,
} from './types.js';

export interface DynamicWorkflowRunOptions {
  runtime: AgentRuntime;
  request: OrchestrationRequest;
  script: WorkflowScriptArtifact;
  scriptRunner?: WorkflowScriptRunner;
  policy?: ModelPolicy;
  store?: RunStore;
  knowledgeStore?: KnowledgeStore;
  idGenerator?: IdGenerator;
  clock?: () => number;
  detectionOptions?: DetectionOptions;
  maxConcurrency?: number;
  maxAgents?: number;
}

export interface DynamicWorkflowRunResult {
  id: string;
  status: RunStatus;
  summary: string;
  plan: RunRecord['plan'];
  wiki: RunRecord['wiki'];
  workflow: DynamicWorkflowSnapshot;
  reports: ReportArtifact[];
  knowledgeEvents: KnowledgeEvent[];
  events: OrchestratorEvent[];
  spentTokens: number;
  spentCostUsd: number;
}

export interface DynamicWorkflowHandle {
  readonly id: string;
  readonly events: AsyncIterable<OrchestratorEvent>;
  readonly result: Promise<DynamicWorkflowRunResult>;
  pause(): void;
  resume(): void;
  cancel(): void;
  appendUserInput(text: string): void;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

function usageTokens(result: AgentRunResult): number {
  const usage = result.usage;
  if (!usage) return 0;
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function cleanTitle(value: string, fallback: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return (clean || fallback).slice(0, 96);
}

function normalizeRole(value: AgentRole | undefined): AgentRole {
  return value ?? 'worker';
}

export class DynamicWorkflowRun {
  readonly id: string;

  private readonly runtime: AgentRuntime;
  private readonly request: OrchestrationRequest;
  private readonly script: WorkflowScriptArtifact;
  private readonly scriptRunner: WorkflowScriptRunner;
  private readonly policy: ModelPolicy;
  private readonly store: RunStore;
  private readonly knowledgeStore: KnowledgeStore | undefined;
  private readonly ids: IdGenerator;
  private readonly clock: () => number;
  private readonly detectionOptions: DetectionOptions | undefined;
  private readonly maxConcurrency: number;
  private readonly maxAgents: number;
  private readonly semaphore: Semaphore;
  private readonly stream = createPushStream<OrchestratorEvent>();
  private readonly eventLog: OrchestratorEvent[] = [];
  private readonly activeAborts = new Set<AbortController>();
  private readonly createdAt: number;
  private readonly graph: PlanGraph;
  private readonly phaseStack: string[] = [];
  private readonly abort = new AbortController();

  private started = false;
  private finished = false;
  private paused = false;
  private pauseGate: (() => void) | null = null;
  private status: RunStatus = 'pending';
  private summary = '';
  private checkpointSeq = 0;
  private available: DetectedAgent[] = [];
  private reports: ReportArtifact[] = [];
  private knowledgeEvents: KnowledgeEvent[] = [];
  private persistedKnowledgeEvents: KnowledgeEvent[] = [];
  private wiki: ProjectWiki;
  private workflow: DynamicWorkflowSnapshot;
  private spentTokens = 0;
  private spentCostUsd = 0;
  private agentCount = 0;
  private resultPromise: Promise<DynamicWorkflowRunResult> | null = null;

  constructor(options: DynamicWorkflowRunOptions) {
    this.runtime = options.runtime;
    this.request = options.request;
    this.script = options.script;
    this.scriptRunner = options.scriptRunner ?? new BunWorkflowScriptRunner();
    this.policy = options.policy ?? createModelPolicy(options.request.mode ?? 'normal');
    this.store = options.store ?? new MemoryRunStore();
    this.knowledgeStore = options.knowledgeStore;
    this.ids = options.idGenerator ?? createIdGenerator();
    this.clock = options.clock ?? (() => Date.now());
    this.detectionOptions = options.detectionOptions;
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 16);
    this.maxAgents = Math.max(1, options.maxAgents ?? 1000);
    this.semaphore = new Semaphore(this.maxConcurrency);
    this.id = options.idGenerator ? this.ids.next('run') : createUniqueRunIdGenerator().next('run');
    this.createdAt = this.clock();
    this.wiki = new ProjectWiki({ clock: this.clock });
    this.graph = new PlanGraph({ idGenerator: this.ids, clock: this.clock });
    this.graph.setStatusListener((change) => {
      this.emit({
        type: 'task-status',
        taskId: change.task.id,
        title: change.task.title,
        from: change.from,
        to: change.to,
        at: this.clock(),
      });
    });
    this.workflow = {
      id: this.ids.next('workflow'),
      script: this.script,
      request: this.request,
      status: 'pending',
      phases: [],
      agents: [],
      checkpoints: [],
      maxConcurrency: this.maxConcurrency,
      maxAgents: this.maxAgents,
      startedAt: this.createdAt,
      updatedAt: this.createdAt,
      finishedAt: null,
      error: null,
    };
  }

  start(): DynamicWorkflowHandle {
    if (!this.started) {
      this.started = true;
      this.resultPromise = this.run();
    }
    return {
      id: this.id,
      events: this.stream.iterable,
      result: this.resultPromise!,
      pause: () => this.pause(),
      resume: () => this.resume(),
      cancel: () => this.cancel(),
      appendUserInput: (text) => {
        void this.checkpoint({ label: 'user-input', data: { text } });
      },
    };
  }

  private emit(event: OrchestratorEvent): void {
    this.eventLog.push(event);
    this.stream.push(event);
  }

  private updateWorkflow(mutator: (snapshot: DynamicWorkflowSnapshot) => DynamicWorkflowSnapshot): DynamicWorkflowSnapshot {
    this.workflow = mutator({
      ...this.workflow,
      phases: this.workflow.phases.map((phase) => ({ ...phase, agentRunIds: [...phase.agentRunIds] })),
      agents: this.workflow.agents.map((agent) => ({ ...agent })),
      checkpoints: this.workflow.checkpoints.map((checkpoint) => ({ ...checkpoint })),
      updatedAt: this.clock(),
    });
    return this.workflow;
  }

  private workflowSnapshot(): DynamicWorkflowSnapshot {
    return {
      ...this.workflow,
      script: { ...this.workflow.script },
      request: { ...this.workflow.request, metadata: { ...(this.workflow.request.metadata ?? {}) } },
      phases: this.workflow.phases.map((phase) => ({ ...phase, agentRunIds: [...phase.agentRunIds] })),
      agents: this.workflow.agents.map((agent) => ({ ...agent })),
      checkpoints: this.workflow.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    };
  }

  private async run(): Promise<DynamicWorkflowRunResult> {
    try {
      this.status = 'running';
      this.workflow = { ...this.workflow, status: 'running', updatedAt: this.clock() };
      this.emit({ type: 'run-started', runId: this.id, request: this.request, mode: this.request.mode ?? 'normal' });
      this.emit({ type: 'workflow-created', workflow: this.workflowSnapshot() });
      validateWorkflowScriptSource(this.script.source);
      await this.loadKnowledge();
      await this.saveProgress();
      this.available = await this.detectAvailable();
      await this.scriptRunner.run({ script: this.script, api: this.createApi(), signal: this.abort.signal });
      if (this.status === 'running') this.status = 'succeeded';
      this.summary = this.summary || `Dynamic workflow ${this.status}.`;
      return await this.finish(this.status, this.summary);
    } catch (err) {
      const message = err instanceof WorkflowScriptValidationError ? err.message : errorMessage(err);
      if (!this.finished) {
        this.emit({ type: 'error', phase: 'workflow-script', message });
        this.status = this.status === 'cancelled' ? 'cancelled' : 'failed';
        this.summary = message;
        return await this.finish(this.status, message);
      }
      return this.buildResult();
    } finally {
      this.stream.end();
    }
  }

  private createApi(): DynamicWorkflowHostApi {
    const api: DynamicWorkflowHostApi = {
      phase: async <T>(name: string, fn: (workflow: DynamicWorkflowApi) => Promise<T> | T): Promise<T> => {
        const phase = await this.beginPhase(name);
        try {
          const result = await fn(api);
          await this.finishPhase(phase.id, 'succeeded');
          return result;
        } catch (err) {
          await this.finishPhase(phase.id, this.status === 'cancelled' ? 'cancelled' : 'failed', errorMessage(err));
          throw err;
        }
      },
      parallel: async <T>(items: Array<Promise<T> | (() => Promise<T> | T)>): Promise<T[]> =>
        Promise.all(items.map((item) => (typeof item === 'function' ? item() : item))),
      agent: (input) => this.runAgentFromWorkflow(input),
      requestReport: (input) => this.requestReport(input),
      updateWiki: (input) => this.updateWiki(input),
      checkpoint: (input) => this.checkpoint(input),
      log: (message) => this.checkpoint({ label: 'log', data: { message } }),
      beginPhase: (name) => this.beginPhase(name),
      finishPhase: (phaseId, status, error) => this.finishPhase(phaseId, status, error),
      finish: async (status, summary) => {
        this.status = status;
        if (summary) this.summary = summary;
      },
    };
    return api;
  }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && this.status !== 'cancelled') {
      await new Promise<void>((resolve) => {
        this.pauseGate = resolve;
      });
    }
  }

  private pause(): void {
    if (this.paused || this.status !== 'running') return;
    this.paused = true;
    this.status = 'paused';
    this.workflow = { ...this.workflow, status: 'paused', updatedAt: this.clock() };
    this.emit({ type: 'paused' });
    void this.saveProgress();
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.status = 'running';
    this.workflow = { ...this.workflow, status: 'running', updatedAt: this.clock() };
    this.emit({ type: 'resumed' });
    this.pauseGate?.();
    this.pauseGate = null;
    void this.saveProgress();
  }

  private cancel(): void {
    if (this.status === 'cancelled') return;
    this.status = 'cancelled';
    this.workflow = { ...this.workflow, status: 'cancelled', updatedAt: this.clock(), error: 'cancelled' };
    this.abort.abort();
    for (const active of this.activeAborts) active.abort();
    for (const task of this.graph.tasks()) {
      if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'cancelled') {
        this.graph.setStatus(task.id, 'cancelled');
      }
    }
    this.pauseGate?.();
    this.pauseGate = null;
  }

  private async beginPhase(name: string): Promise<WorkflowPhaseSnapshot> {
    await this.waitIfPaused();
    const phase: WorkflowPhaseSnapshot = {
      id: this.ids.next('workflow-phase'),
      name: cleanTitle(name, 'Workflow Phase'),
      status: 'running',
      startedAt: this.clock(),
      finishedAt: null,
      agentRunIds: [],
      error: null,
    };
    const workflow = this.updateWorkflow((snapshot) => ({
      ...snapshot,
      phases: [...snapshot.phases, phase],
    }));
    this.phaseStack.push(phase.id);
    this.emit({ type: 'workflow-phase-started', phase, workflow: this.workflowSnapshot() });
    await this.saveProgress();
    return workflow.phases.find((item) => item.id === phase.id)!;
  }

  private async finishPhase(phaseId: string, status: WorkflowPhaseStatus, err?: string): Promise<void> {
    const workflow = this.updateWorkflow((snapshot) => ({
      ...snapshot,
      phases: snapshot.phases.map((phase) =>
        phase.id === phaseId
          ? {
              ...phase,
              status,
              finishedAt: this.clock(),
              error: err ?? null,
            }
          : phase,
      ),
    }));
    const phase = workflow.phases.find((item) => item.id === phaseId);
    const last = this.phaseStack.lastIndexOf(phaseId);
    if (last !== -1) this.phaseStack.splice(last, 1);
    if (phase) this.emit({ type: 'workflow-phase-finished', phase, workflow: this.workflowSnapshot() });
    await this.saveProgress();
  }

  private currentPhase(): WorkflowPhaseSnapshot | null {
    const id = this.phaseStack[this.phaseStack.length - 1];
    return id ? this.workflow.phases.find((phase) => phase.id === id) ?? null : null;
  }

  private async runAgentFromWorkflow(input: DynamicWorkflowAgentInput): Promise<DynamicWorkflowAgentResult> {
    await this.waitIfPaused();
    if (this.status === 'cancelled') throw new Error('Workflow run was cancelled');
    if (this.agentCount >= this.maxAgents) {
      throw new Error(`Dynamic workflow max agents exceeded (${this.maxAgents})`);
    }
    this.agentCount += 1;
    return await this.semaphore.run(async () => this.doRunWorkflowAgent(input));
  }

  private async doRunWorkflowAgent(input: DynamicWorkflowAgentInput): Promise<DynamicWorkflowAgentResult> {
    const phase = this.currentPhase();
    const role = normalizeRole(input.role);
    const title = cleanTitle(input.title, 'Workflow agent');
    const assignment = this.assignmentFor(role, input, title);
    const task = this.graph.addTask({
      title,
      description: input.prompt,
      role,
      status: 'ready',
      tags: [phase?.name ?? 'Workflow'],
      metadata: { workflowId: this.workflow.id, phaseId: phase?.id ?? null },
    });
    this.emit({ type: 'planned', snapshot: this.graph.snapshot() });
    const identity = this.createAgentIdentity(assignment, role, task.id);
    const agentSnapshot: WorkflowAgentSnapshot = {
      taskId: task.id,
      agentRunId: identity.agentRunId,
      agentLabel: identity.agentLabel,
      agentId: assignment.agentId,
      role,
      title,
      prompt: input.prompt,
      phaseId: phase?.id ?? null,
      phaseName: phase?.name ?? null,
      status: 'running',
      startedAt: this.clock(),
      finishedAt: null,
      tokens: 0,
      toolCount: 0,
      model: assignment.model,
      error: null,
    };
    this.updateWorkflow((snapshot) => ({
      ...snapshot,
      agents: [...snapshot.agents, agentSnapshot],
      phases: phase
        ? snapshot.phases.map((item) =>
            item.id === phase.id
              ? { ...item, agentRunIds: [...item.agentRunIds, identity.agentRunId] }
              : item,
          )
        : snapshot.phases,
    }));
    this.emit({ type: 'workflow-agent-started', agent: agentSnapshot, workflow: this.workflowSnapshot() });
    this.graph.setStatus(task.id, 'running');
    this.emit({ type: 'agent-assigned', role, taskId: task.id, title, assignment, ...identity });
    await this.saveProgress();

    const abort = new AbortController();
    this.activeAborts.add(abort);
    const runInput: AgentRunInput = {
      agentId: assignment.agentId,
      prompt: input.prompt,
      cwd: input.cwd ?? this.request.cwd,
      model: input.model ?? assignment.model,
      reasoning: input.reasoning ?? assignment.reasoning,
      metadata: {
        ...(input.metadata ?? {}),
        role,
        runId: this.id,
        workflowId: this.workflow.id,
        phaseId: phase?.id ?? null,
        taskId: task.id,
        ...identity,
      },
      signal: abort.signal,
    };
    const acc = createResultAccumulator();
    let result: AgentRunResult;
    try {
      for await (const event of this.runtime.streamAgentEvents(runInput)) {
        acc.push(event);
        this.emit({ type: 'agent-event', role, taskId: task.id, assignment, ...identity, event });
        this.updateAgentProgress(identity.agentRunId, event);
        await this.saveProgress();
      }
      result = acc.result();
    } catch (err) {
      acc.push({ type: 'error', message: errorMessage(err) });
      result = acc.result();
    } finally {
      this.activeAborts.delete(abort);
    }

    const tokens = usageTokens(result);
    this.spentTokens += tokens;
    if (result.costUsd != null) this.spentCostUsd += result.costUsd;
    const success = result.status === 'completed';
    this.graph.setResult(task.id, {
      success,
      summary: result.error ?? (result.text.slice(0, 500) || result.status),
      output: result.text,
      agentId: assignment.agentId,
      ...(result.error ? { error: result.error } : {}),
    });
    this.graph.setStatus(task.id, success ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed');
    const agent = this.finishAgent(identity.agentRunId, success ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed', result.error);
    if (agent) this.emit({ type: 'workflow-agent-finished', agent, workflow: this.workflowSnapshot() });
    await this.saveProgress();
    if (!success) throw new Error(result.error ?? `Agent ${assignment.agentId} ended with ${result.status}`);
    return {
      taskId: task.id,
      ...identity,
      agentId: assignment.agentId,
      role,
      title,
      text: result.text,
      thinking: result.thinking,
      toolCalls: result.toolCalls,
      usage: result.usage,
      tokens,
      costUsd: result.costUsd,
      status: result.status,
      error: result.error,
      model: result.model,
    };
  }

  private assignmentFor(role: AgentRole, input: DynamicWorkflowAgentInput, taskTitle: string): RoleAssignment {
    if (input.agentId) {
      return {
        role,
        agentId: input.agentId,
        model: input.model ?? null,
        reasoning: input.reasoning ?? null,
        rationale: 'workflow: script override',
      };
    }
    return this.policy.select(role, {
      available: this.available,
      taskTitle,
      taskType: role,
    });
  }

  private createAgentIdentity(
    assignment: RoleAssignment,
    role: AgentRole,
    taskId: string | null,
  ): { agentRunId: string; agentLabel: string } {
    const agentRunId = this.ids.next('agent-run');
    return { agentRunId, agentLabel: `${assignment.agentId}#${taskId ?? role}` };
  }

  private updateAgentProgress(agentRunId: string, event: AgentEvent): void {
    this.updateWorkflow((snapshot) => ({
      ...snapshot,
      agents: snapshot.agents.map((agent) => {
        if (agent.agentRunId !== agentRunId) return agent;
        return {
          ...agent,
          tokens:
            agent.tokens +
            (event.type === 'usage'
              ? event.usage.totalTokens ?? (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0)
              : 0),
          toolCount: agent.toolCount + (event.type === 'tool_use' ? 1 : 0),
          model: event.type === 'status' && event.model != null ? event.model : agent.model,
          error: event.type === 'error' ? event.message : agent.error,
        };
      }),
    }));
  }

  private finishAgent(agentRunId: string, status: WorkflowAgentSnapshot['status'], err: string | null): WorkflowAgentSnapshot | null {
    let finished: WorkflowAgentSnapshot | null = null;
    this.updateWorkflow((snapshot) => ({
      ...snapshot,
      agents: snapshot.agents.map((agent) => {
        if (agent.agentRunId !== agentRunId) return agent;
        finished = {
          ...agent,
          status,
          finishedAt: this.clock(),
          error: err,
        };
        return finished;
      }),
    }));
    return finished;
  }

  private async requestReport(input: DynamicWorkflowReportInput): Promise<void> {
    const title = cleanTitle(input.title, 'Workflow report');
    this.emit({
      type: 'report-requested',
      kind: input.kind ?? 'milestone',
      title,
      reason: input.reason,
      taskId: input.taskId ?? null,
      source: 'workflow',
    });
    await this.saveProgress();
    const assignment = this.policy.select('reporter', { available: this.available, taskTitle: title, taskType: 'reporter' });
    const identity = this.createAgentIdentity(assignment, 'reporter', null);
    let agentText = '';
    if (assignment.agentId !== BUILTIN_AGENT_ID) {
      const acc = createResultAccumulator();
      this.emit({ type: 'agent-assigned', role: 'reporter', taskId: null, title, assignment, ...identity });
      for await (const event of this.runtime.streamAgentEvents({
        agentId: assignment.agentId,
        prompt: this.reporterPrompt(input),
        cwd: this.request.cwd,
        model: assignment.model,
        reasoning: assignment.reasoning,
        metadata: { role: 'reporter', runId: this.id, workflowId: this.workflow.id, ...identity },
      })) {
        acc.push(event);
        this.emit({ type: 'agent-event', role: 'reporter', taskId: null, assignment, ...identity, event });
        await this.saveProgress();
      }
      agentText = acc.result().text.trim();
    }
    const markdown = agentText ? cleanAgentArtifactText(agentText) : input.markdown ?? `# ${title}\n\n${input.summary}`;
    const report = createReportArtifact({
      runId: this.id,
      kind: input.kind ?? 'milestone',
      title,
      summary: input.summary,
      markdown,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      authorAgentId: agentText ? assignment.agentId : null,
      source: agentText ? 'agent' : 'fallback',
      clock: this.clock,
      nextId: (prefix) => this.ids.next(prefix),
    });
    this.reports = [...this.reports, report];
    this.emit({ type: 'report-created', report, reports: this.reports });
    await this.updateWiki({
      kind: 'report' as never,
      title,
      body: report.summary,
      ...(report.taskId ? { taskId: report.taskId } : {}),
      ...(report.authorAgentId ? { authorAgentId: report.authorAgentId } : {}),
    });
  }

  private reporterPrompt(input: DynamicWorkflowReportInput): string {
    return [
      'You are Omakase Reporter, an out-of-band reporting agent.',
      'Write a concise workflow stage report. Do not paste raw logs.',
      `Workflow: ${this.workflow.id}`,
      `Title: ${input.title}`,
      `Reason: ${input.reason}`,
      `Fallback summary: ${input.summary}`,
      '',
      JSON.stringify(
        {
          request: this.request.prompt,
          phases: this.workflow.phases,
          agents: this.workflow.agents,
          checkpoints: this.workflow.checkpoints.slice(-8),
        },
        null,
        2,
      ),
    ].join('\n');
  }

  private async updateWiki(input: DynamicWorkflowWikiInput): Promise<void> {
    const knowledge = createKnowledgeEvent({
      runId: this.id,
      kind: input.kind,
      title: cleanTitle(input.title, 'Workflow knowledge'),
      body: input.body,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      authorAgentId: input.authorAgentId ?? 'workflow-script',
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
    await this.saveProgress({ persistKnowledge: true });
  }

  private async checkpoint(input: DynamicWorkflowCheckpointInput | string): Promise<WorkflowCheckpoint> {
    const normalized = typeof input === 'string' ? { label: input } : input;
    const checkpoint: WorkflowCheckpoint = {
      id: this.ids.next('workflow-checkpoint'),
      label: cleanTitle(normalized.label, 'checkpoint'),
      data: normalized.data ?? null,
      at: this.clock(),
    };
    const workflow = this.updateWorkflow((snapshot) => ({
      ...snapshot,
      checkpoints: [...snapshot.checkpoints, checkpoint],
    }));
    this.emit({ type: 'workflow-checkpoint', checkpoint, workflow });
    await this.saveProgress();
    return checkpoint;
  }

  private emitKnowledge(): void {
    this.emit({
      type: 'knowledge-updated',
      wikiEntries: this.wiki.size,
      codegraphFiles: null,
      codegraph: null,
    });
  }

  private async detectAvailable(): Promise<DetectedAgent[]> {
    try {
      return await this.runtime.detect(this.detectionOptions);
    } catch {
      return [];
    }
  }

  private async loadKnowledge(): Promise<void> {
    const wiki = await this.knowledgeStore?.loadWiki();
    if (wiki) this.wiki = ProjectWiki.fromJSON(wiki, { clock: this.clock });
    this.persistedKnowledgeEvents = (await this.knowledgeStore?.loadKnowledgeEvents()) ?? [];
  }

  private async persistKnowledge(): Promise<void> {
    if (!this.knowledgeStore) return;
    const entries = this.wiki.toJSON().entries;
    if (this.knowledgeStore.mergeWiki) await this.knowledgeStore.mergeWiki(entries);
    else await this.knowledgeStore.saveWiki({ entries });
    const byId = new Map(this.persistedKnowledgeEvents.map((event) => [event.id, event] as const));
    for (const event of this.knowledgeEvents) byId.set(event.id, event);
    await this.knowledgeStore.saveKnowledgeEvents([...byId.values()]);
  }

  private async saveProgress(options: { persistKnowledge?: boolean } = {}): Promise<void> {
    this.checkpointSeq += 1;
    const at = this.clock();
    this.emit({ type: 'heartbeat', at });
    await this.store.save(this.buildRecord(this.status, this.summary));
    if (options.persistKnowledge) await this.persistKnowledge();
  }

  private async finish(status: RunStatus, summary: string): Promise<DynamicWorkflowRunResult> {
    this.finished = true;
    this.status = status;
    this.summary = summary;
    this.workflow = {
      ...this.workflow,
      status,
      finishedAt: this.clock(),
      updatedAt: this.clock(),
      error: status === 'failed' || status === 'cancelled' ? summary : null,
    };
    this.emit({ type: 'workflow-finished', workflow: this.workflowSnapshot() });
    this.emit({ type: 'run-finished', status, summary });
    await this.store.save(this.buildRecord(status, summary));
    await this.persistKnowledge();
    return this.buildResult();
  }

  private buildRecord(status: RunStatus, summary: string): RunRecord {
    const now = this.clock();
    return {
      id: this.id,
      request: this.request,
      mode: this.request.mode ?? 'normal',
      status,
      plan: this.graph.snapshot(),
      wiki: this.wiki.toJSON(),
      workflow: this.workflowSnapshot(),
      reports: this.reports,
      knowledgeEvents: this.knowledgeEvents,
      inbox: [],
      events: [...this.eventLog],
      summary,
      spentTokens: this.spentTokens,
      spentCostUsd: this.spentCostUsd,
      createdAt: this.createdAt,
      updatedAt: now,
      heartbeatAt: now,
      checkpointSeq: this.checkpointSeq,
    };
  }

  private buildResult(): DynamicWorkflowRunResult {
    return {
      id: this.id,
      status: this.status,
      summary: this.summary,
      plan: this.graph.snapshot(),
      wiki: this.wiki.toJSON(),
      workflow: this.workflowSnapshot(),
      reports: [...this.reports],
      knowledgeEvents: [...this.knowledgeEvents],
      events: [...this.eventLog],
      spentTokens: this.spentTokens,
      spentCostUsd: this.spentCostUsd,
    };
  }
}
