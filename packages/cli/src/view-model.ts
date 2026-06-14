/**
 * The CLI/TUI view-model: a pure reducer that folds the orchestrator's event
 * stream into a render-ready snapshot. Keeping this logic out of the Ink
 * components makes it unit-testable and keeps the TUI a thin presentation layer
 * over it — and, crucially, lets a re-attaching client reconstruct identical
 * state by re-folding a run's persisted event log (replay == live tail).
 */
import type {
  AgentRole,
  AcceptanceSnapshot,
  CodeGraphStats,
  IterationSnapshot,
  OrchestratorEvent,
  PlanGraphSnapshot,
  ReportArtifact,
  RiskGateSnapshot,
  KnowledgeEvent,
  RouteKind,
  RunStatus,
  TaskStatus,
  WorkMode,
  DynamicWorkflowSnapshot,
  WorkflowPhaseStatus,
} from '@omakase/core';

export type RunViewStatus = RunStatus | 'idle';

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export interface TaskView {
  id: string;
  title: string;
  role: AgentRole;
  status: TaskStatus;
  tags: string[];
  /** Cumulative tokens spent by this task's agent(s). */
  tokens: number;
  /** Number of tool calls this task's agent made. */
  toolCount: number;
  /** Clock value (from heartbeats) when the task entered 'running' / a terminal state. */
  startedAt: number | null;
  finishedAt: number | null;
  agentId: string | null;
  /** Concrete process/invocation id for this task's current agent run. */
  agentRunId: string | null;
  /** Display label that distinguishes same-runtime concurrent workers. */
  agentLabel: string | null;
}

/** A run "phase": a group of tasks (by first tag, else role) with progress. */
export interface PhaseView {
  stage: string;
  done: number;
  total: number;
}

export interface RunView {
  runId: string | null;
  status: RunViewStatus;
  mode: WorkMode;
  title: string | null;
  route: { kind: RouteKind; reason: string } | null;
  tasks: TaskView[];
  phases: PhaseView[];
  activeAgents: number;
  totalAgents: number;
  totalTokens: number;
  /** First/last heartbeat clock values; the renderer derives live elapsed. */
  startedAt: number | null;
  updatedAt: number | null;
  events: string[];
  /** Human-readable streamed planner/agent phrases, separate from structural events. */
  phrases: string[];
  /** Chronological user-facing activity, mixing structural run events and agent stream updates. */
  activity: string[];
  /** Out-of-band reporter/wiki-curator activity, kept out of the main run flow. */
  supportActivity: string[];
  wikiEntries: number;
  codegraphFiles: number | null;
  codegraphStats: CodeGraphStats | null;
  acceptance: AcceptanceSnapshot | null;
  iterations: IterationSnapshot[];
  riskGates: RiskGateSnapshot[];
  reports: ReportArtifact[];
  knowledgeEvents: KnowledgeEvent[];
  workflow: DynamicWorkflowSnapshot | null;
  lastReview: { approved: boolean; notes: string } | null;
  summary: string | null;
}

export type TranscriptItem =
  | { kind: 'user-message'; text: string }
  | { kind: 'route'; routeKind: RouteKind; reason: string }
  | { kind: 'plan'; taskCount: number }
  | { kind: 'task-progress'; role: AgentRole; title: string; agentLabel: string | null; status: 'started' | 'succeeded' | 'failed' }
  | { kind: 'review'; approved: boolean; notes: string }
  | { kind: 'report'; title: string }
  | { kind: 'workflow-phase'; name: string; status: WorkflowPhaseStatus }
  | { kind: 'finished'; status: RunStatus; summary: string };

/**
 * Project a run's event log into an ordered chat transcript of structural
 * milestones (user message → route → plan → per-task progress → review →
 * finish). Streaming token/thinking deltas and heartbeats are intentionally
 * dropped — those belong to the live "phrases" feed, not the readable timeline.
 */
export function reduceTranscript(events: OrchestratorEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'run-started':
        items.push({ kind: 'user-message', text: event.request.prompt });
        break;
      case 'routed':
        items.push({ kind: 'route', routeKind: event.decision.kind, reason: event.decision.reason });
        break;
      case 'planned':
        items.push({ kind: 'plan', taskCount: event.snapshot.tasks.length });
        break;
      case 'agent-assigned':
        if (event.taskId) {
          items.push({
            kind: 'task-progress',
            role: event.role,
            title: event.title ?? event.taskId,
            agentLabel: event.agentLabel ?? event.assignment?.agentId ?? null,
            status: 'started',
          });
        }
        break;
      case 'task-finished':
        items.push({
          kind: 'task-progress',
          role: event.role,
          title: event.title,
          agentLabel: null,
          status: event.success ? 'succeeded' : 'failed',
        });
        break;
      case 'review':
        items.push({ kind: 'review', approved: event.approved, notes: event.notes });
        break;
      case 'report-created':
        items.push({ kind: 'report', title: event.report.title });
        break;
      case 'workflow-phase-started':
      case 'workflow-phase-finished':
        items.push({ kind: 'workflow-phase', name: event.phase.name, status: event.phase.status });
        break;
      case 'run-finished':
        items.push({ kind: 'finished', status: event.status, summary: event.summary });
        break;
      default:
        break;
    }
  }
  return items;
}

const MAX_EVENT_LINES = 200;
const MAX_PHRASES = 120;
const MAX_ACTIVITY_LINES = 200;

export function initialRunView(mode: WorkMode = 'normal'): RunView {
  return {
    runId: null,
    status: 'idle',
    mode,
    title: null,
    route: null,
    tasks: [],
    phases: [],
    activeAgents: 0,
    totalAgents: 0,
    totalTokens: 0,
    startedAt: null,
    updatedAt: null,
    events: [],
    phrases: [],
    activity: [],
    supportActivity: [],
    wikiEntries: 0,
    codegraphFiles: null,
    codegraphStats: null,
    acceptance: null,
    iterations: [],
    riskGates: [],
    reports: [],
    knowledgeEvents: [],
    workflow: null,
    lastReview: null,
    summary: null,
  };
}

function phraseLine(event: OrchestratorEvent): string {
  if (event.type !== 'agent-event') return '';
  const role = event.role;
  const agent = agentDisplay(event);
  const inner = event.event;
  if (inner.type === 'thinking_delta' && inner.delta.trim()) {
    return `${role}/${agent} thinking: ${inner.delta.trim()}`;
  }
  if (inner.type === 'text_delta' && inner.delta.trim()) {
    return `${role}/${agent}: ${inner.delta.trim()}`;
  }
  if (inner.type === 'status') {
    return `${role}/${agent} status: ${inner.label}`;
  }
  if (inner.type === 'tool_use') {
    return `${role}/${agent} tool: ${safeToolLabel(inner.name, inner.id)}`;
  }
  if (inner.type === 'usage') {
    return `${role}/${agent} usage: ${tokensOf(inner.usage)} tok`;
  }
  if (inner.type === 'error') {
    return `${role}/${agent} error: ${inner.message}`;
  }
  return '';
}

function agentDisplay(
  event: Extract<OrchestratorEvent, { type: 'agent-assigned' | 'agent-event' }>,
): string {
  return event.agentLabel ?? event.assignment.agentId;
}

export function formatEventLine(event: OrchestratorEvent): string {
  switch (event.type) {
    case 'run-started':
      return `▶ run ${event.runId} started (${event.mode})`;
    case 'routed':
      return `↪ routed: ${event.decision.kind} — ${event.decision.reason}`;
    case 'planned':
      return `▤ planned ${event.snapshot.tasks.length} task(s)`;
    case 'workflow-created':
      return `▥ workflow: ${event.workflow.script.path}`;
    case 'workflow-phase-started':
      return `▧ phase started: ${event.phase.name}`;
    case 'workflow-phase-finished':
      return `▧ phase ${event.phase.status}: ${event.phase.name}`;
    case 'workflow-agent-started':
      return `  ⇄ workflow agent ${event.agent.role}/${event.agent.agentLabel} started`;
    case 'workflow-agent-finished':
      return `  ${event.agent.status === 'succeeded' ? '✓' : '✗'} workflow agent ${event.agent.role}/${event.agent.agentLabel}`;
    case 'workflow-checkpoint':
      return `  ◇ checkpoint: ${event.checkpoint.label}`;
    case 'workflow-finished':
      return `▥ workflow finished: ${event.workflow.status}`;
    case 'acceptance-updated':
      return `□ acceptance: ${event.acceptance.progress.passed}/${event.acceptance.progress.total} complete`;
    case 'iteration-updated':
      return `↺ iteration ${event.iteration.index} ${event.iteration.status}: ${event.iteration.reason}${
        event.iteration.nextStrategy ? ` → ${event.iteration.nextStrategy}` : ''
      }`;
    case 'strategy-updated': {
      const blockers = [...event.failedCriteria, ...event.openGates];
      return `↯ strategy: ${event.nextAction} — ${event.reason}${
        blockers.length > 0 ? ` (${blockers.join(', ')})` : ''
      }`;
    }
    case 'risk-gate-opened':
      return `⚠ gate opened: ${event.gate.reason}`;
    case 'risk-gate-answered':
      return `✓ gate answered: ${event.gate.id}`;
    case 'report-requested':
      return `▣ report requested: ${event.title} (${event.reason})`;
    case 'report-created':
      return `▣ report: ${event.report.title}`;
    case 'knowledge-event-created':
      return `◇ knowledge event: ${event.event.title}`;
    case 'task-status':
      return `  · ${event.title}: ${event.from} → ${event.to}`;
    case 'agent-assigned':
      return `  ⇄ assigned ${event.role}/${agentDisplay(event)}${event.title ? ` to ${event.title}` : ''}`;
    case 'task-finished':
      return `  ${event.success ? '✓' : '✗'} [${event.role}] ${event.title}`;
    case 'review':
      return `  ⚖ review: ${event.approved ? 'APPROVED' : 'REJECTED'} — ${event.notes}`;
    case 'replanned':
      return `↻ replanned (${event.reason})`;
    case 'knowledge-updated':
      return event.codegraph
        ? `  ⌕ knowledge: ${event.wikiEntries} wiki entries, ${event.codegraph.files} files, ${event.codegraph.internalEdges} internal, ${event.codegraph.externalEdges} external, ${event.codegraph.symbols} symbols, ${event.codegraph.cycles} cycles`
        : `  ⌕ knowledge: ${event.wikiEntries} wiki entries${event.codegraphFiles != null ? `, ${event.codegraphFiles} files` : ''}`;
    case 'budget-exhausted':
      return `⛔ budget exhausted: ${event.spentTokens} tokens, $${event.spentCostUsd.toFixed(2)} spent`;
    case 'user-input':
      return `✎ user input: ${event.item.text}`;
    case 'paused':
      return '⏸ paused';
    case 'resumed':
      return '▶ resumed';
    case 'heartbeat':
      return '';
    case 'agent-event':
      return event.event.type === 'status' ? `  … ${event.event.label}` : '';
    case 'run-finished':
      return `■ run finished: ${event.status} — ${event.summary}`;
    case 'error':
      return `✗ error (${event.phase}): ${event.message}`;
  }
}

/** Merge a plan snapshot into the task list BY ID, preserving accumulated stats. */
function upsertTasks(tasks: TaskView[], snapshot: PlanGraphSnapshot): TaskView[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return snapshot.tasks.map((t) => {
    const prev = byId.get(t.id);
    return {
      id: t.id,
      title: t.title,
      role: t.role,
      status: t.status,
      tags: [...(t.tags ?? [])],
      tokens: prev?.tokens ?? 0,
      toolCount: prev?.toolCount ?? 0,
      startedAt: prev?.startedAt ?? null,
      finishedAt: prev?.finishedAt ?? null,
      agentId: prev?.agentId ?? null,
      agentRunId: prev?.agentRunId ?? null,
      agentLabel: prev?.agentLabel ?? null,
    };
  });
}

function computePhases(tasks: TaskView[]): PhaseView[] {
  const order: string[] = [];
  const groups = new Map<string, PhaseView>();
  for (const t of tasks) {
    const stage = t.tags[0] ?? t.role ?? 'Plan';
    let g = groups.get(stage);
    if (!g) {
      g = { stage, done: 0, total: 0 };
      groups.set(stage, g);
      order.push(stage);
    }
    g.total += 1;
    if (TERMINAL.has(t.status)) g.done += 1;
  }
  return order.map((s) => groups.get(s)!);
}

/** Recompute the task-derived header fields (phases, agent counts). */
function derive(view: RunView): RunView {
  return {
    ...view,
    phases: computePhases(view.tasks),
    activeAgents: view.tasks.filter((t) => t.status === 'running').length,
    totalAgents: view.tasks.length,
  };
}

function tokensOf(usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number }): number {
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function safeToolLabel(name: string | null | undefined, id: string | null | undefined): string {
  const raw = name ?? id ?? 'tool';
  if (/^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/.test(raw)) return raw;
  const shell = parseShellInvocation(raw);
  if (shell) return `shell: ${shortenToolCommand(shell)}`;
  const first = raw.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').filter(Boolean).at(-1);
  return base && /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/.test(base) ? base : 'tool';
}

function parseShellInvocation(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return null;
  return stripOuterQuotes(match[1]!.trim());
}

function stripOuterQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function shortenToolCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (compact.length <= 72) return compact;
  return `${compact.slice(0, 69).trimEnd()}...`;
}

function isSupportActivityEvent(event: OrchestratorEvent): boolean {
  if (event.type === 'report-requested' || event.type === 'report-created' || event.type === 'knowledge-event-created') return true;
  if (event.type !== 'agent-event' && event.type !== 'agent-assigned') return false;
  return event.taskId == null && (event.role === 'reporter' || event.role === 'wiki-curator');
}

export function reduceRunView(view: RunView, event: OrchestratorEvent): RunView {
  const line = formatEventLine(event);
  const events = line ? [...view.events, line].slice(-MAX_EVENT_LINES) : view.events;
  const support = isSupportActivityEvent(event);
  const rawPhrase = phraseLine(event);
  const phrase = !support ? rawPhrase : '';
  const phrases = phrase ? [...view.phrases, phrase].slice(-MAX_PHRASES) : view.phrases;
  const activityLine = phrase || line;
  const activity = activityLine && !support
    ? [...view.activity, activityLine].slice(-MAX_ACTIVITY_LINES)
    : view.activity;
  const supportLine = support ? rawPhrase || line : '';
  const supportActivity = supportLine
    ? [...view.supportActivity, supportLine].slice(-MAX_ACTIVITY_LINES)
    : view.supportActivity;
  const next: RunView = { ...view, events, phrases, activity, supportActivity };

  switch (event.type) {
    case 'run-started':
      return { ...next, runId: event.runId, status: 'running', mode: event.mode, title: event.request.prompt };
    case 'routed':
      return { ...next, route: { kind: event.decision.kind, reason: event.decision.reason } };
    case 'planned':
      return derive({ ...next, tasks: upsertTasks(view.tasks, event.snapshot) });
    case 'workflow-created':
    case 'workflow-phase-started':
    case 'workflow-phase-finished':
    case 'workflow-agent-started':
    case 'workflow-agent-finished':
    case 'workflow-checkpoint':
    case 'workflow-finished':
      return { ...next, workflow: event.workflow };
    case 'acceptance-updated':
      return { ...next, acceptance: event.acceptance };
    case 'iteration-updated':
      return { ...next, iterations: event.iterations };
    case 'risk-gate-opened':
      return { ...next, status: 'waiting-for-user', riskGates: event.gates };
    case 'risk-gate-answered':
      return { ...next, status: 'running', riskGates: event.gates };
    case 'report-created':
      return { ...next, reports: event.reports };
    case 'knowledge-event-created':
      return { ...next, knowledgeEvents: event.events };
    case 'replanned':
      return derive({ ...next, tasks: upsertTasks(view.tasks, event.snapshot) });
    case 'task-status': {
      const stamp = event.at ?? view.updatedAt;
      const startStamp = event.to === 'running' ? stamp : null;
      const endStamp = TERMINAL.has(event.to) ? stamp : null;
      const existing = view.tasks.find((t) => t.id === event.taskId);
      const tasks = existing
        ? view.tasks.map((t) =>
            t.id === event.taskId
              ? {
                  ...t,
                  status: event.to,
                  startedAt: t.startedAt ?? startStamp,
                  finishedAt: endStamp ?? t.finishedAt,
                }
              : t,
          )
        : [
            ...view.tasks,
            {
              id: event.taskId,
              title: event.title,
              role: 'worker' as AgentRole,
              status: event.to,
              tags: [],
              tokens: 0,
              toolCount: 0,
              startedAt: startStamp,
              finishedAt: endStamp,
              agentId: null,
              agentRunId: null,
              agentLabel: null,
            },
          ];
      return derive({ ...next, tasks });
    }
    case 'agent-assigned': {
      const agentId = event.assignment?.agentId ?? null;
      const agentRunId = event.agentRunId ?? null;
      const agentLabel = event.agentLabel ?? null;
      const tasks = event.taskId
        ? view.tasks.map((t) =>
            t.id === event.taskId
              ? {
                  ...t,
                  agentId: agentId ?? t.agentId,
                  agentRunId: agentRunId ?? t.agentRunId,
                  agentLabel: agentLabel ?? t.agentLabel,
                }
              : t,
          )
        : view.tasks;
      return derive({ ...next, tasks });
    }
    case 'agent-event': {
      const inner = event.event;
      const agentId = event.assignment?.agentId ?? null;
      const agentRunId = event.agentRunId ?? null;
      const agentLabel = event.agentLabel ?? null;
      const addTokens = inner.type === 'usage' ? tokensOf(inner.usage) : 0;
      const tasks = view.tasks.map((t) =>
        t.id === event.taskId
          ? {
              ...t,
              tokens: t.tokens + addTokens,
              toolCount: t.toolCount + (inner.type === 'tool_use' ? 1 : 0),
              agentId: agentId ?? t.agentId,
              agentRunId: agentRunId ?? t.agentRunId,
              agentLabel: agentLabel ?? t.agentLabel,
            }
          : t,
      );
      return { ...next, tasks, totalTokens: view.totalTokens + addTokens };
    }
    case 'heartbeat':
      return { ...next, updatedAt: event.at, startedAt: view.startedAt ?? event.at };
    case 'knowledge-updated':
      return {
        ...next,
        wikiEntries: event.wikiEntries,
        codegraphFiles: event.codegraph?.files ?? event.codegraphFiles,
        codegraphStats: event.codegraph ?? null,
      };
    case 'review':
      return { ...next, lastReview: { approved: event.approved, notes: event.notes } };
    case 'paused':
      return { ...next, status: 'paused' };
    case 'resumed':
      return { ...next, status: 'running' };
    case 'run-finished':
      return { ...next, status: event.status, summary: event.summary };
    default:
      return next;
  }
}

/** Fold a complete event list into a final view (for replay / non-interactive runs). */
export function buildRunView(events: OrchestratorEvent[], mode: WorkMode = 'normal'): RunView {
  return events.reduce(reduceRunView, initialRunView(mode));
}

/**
 * Overlay a run's authoritative plan snapshot onto a folded view, preserving
 * event-derived per-task stats (merge by id). This is how a client reconstructs
 * the current task graph even when the persisted event log doesn't carry it —
 * e.g. a simple-route run (no `planned` event) or a long task still in flight
 * whose status changes haven't been checkpointed yet.
 */
export function applyPlanSnapshot(view: RunView, plan: PlanGraphSnapshot): RunView {
  if (!plan || plan.tasks.length === 0) return view;
  return derive({ ...view, tasks: upsertTasks(view.tasks, plan) });
}
