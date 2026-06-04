/**
 * The CLI/TUI view-model: a pure reducer that folds the orchestrator's event
 * stream into a render-ready snapshot. Keeping this logic out of the Ink
 * components makes it unit-testable and keeps the TUI a thin presentation layer
 * over it — and, crucially, lets a re-attaching client reconstruct identical
 * state by re-folding a run's persisted event log (replay == live tail).
 */
import type {
  AgentRole,
  OrchestratorEvent,
  PlanGraphSnapshot,
  RouteKind,
  RunStatus,
  TaskStatus,
  WorkMode,
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
  wikiEntries: number;
  codegraphFiles: number | null;
  lastReview: { approved: boolean; notes: string } | null;
  summary: string | null;
}

const MAX_EVENT_LINES = 200;

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
    wikiEntries: 0,
    codegraphFiles: null,
    lastReview: null,
    summary: null,
  };
}

export function formatEventLine(event: OrchestratorEvent): string {
  switch (event.type) {
    case 'run-started':
      return `▶ run ${event.runId} started (${event.mode})`;
    case 'routed':
      return `↪ routed: ${event.decision.kind} — ${event.decision.reason}`;
    case 'planned':
      return `▤ planned ${event.snapshot.tasks.length} task(s)`;
    case 'task-status':
      return `  · ${event.title}: ${event.from} → ${event.to}`;
    case 'task-finished':
      return `  ${event.success ? '✓' : '✗'} [${event.role}] ${event.title}`;
    case 'review':
      return `  ⚖ review: ${event.approved ? 'APPROVED' : 'REJECTED'} — ${event.notes}`;
    case 'replanned':
      return `↻ replanned (${event.reason})`;
    case 'knowledge-updated':
      return `  ⌕ knowledge: ${event.wikiEntries} wiki entries${event.codegraphFiles != null ? `, ${event.codegraphFiles} files` : ''}`;
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

export function reduceRunView(view: RunView, event: OrchestratorEvent): RunView {
  const line = formatEventLine(event);
  const events = line ? [...view.events, line].slice(-MAX_EVENT_LINES) : view.events;
  const next: RunView = { ...view, events };

  switch (event.type) {
    case 'run-started':
      return { ...next, runId: event.runId, status: 'running', mode: event.mode, title: event.request.prompt };
    case 'routed':
      return { ...next, route: { kind: event.decision.kind, reason: event.decision.reason } };
    case 'planned':
      return derive({ ...next, tasks: upsertTasks(view.tasks, event.snapshot) });
    case 'replanned':
      return derive({ ...next, tasks: upsertTasks(view.tasks, event.snapshot) });
    case 'task-status': {
      const startStamp = event.to === 'running' ? view.updatedAt : null;
      const endStamp = TERMINAL.has(event.to) ? view.updatedAt : null;
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
            },
          ];
      return derive({ ...next, tasks });
    }
    case 'agent-event': {
      const inner = event.event;
      const agentId = event.assignment?.agentId ?? null;
      const addTokens = inner.type === 'usage' ? tokensOf(inner.usage) : 0;
      const tasks = view.tasks.map((t) =>
        t.id === event.taskId
          ? {
              ...t,
              tokens: t.tokens + addTokens,
              toolCount: t.toolCount + (inner.type === 'tool_use' ? 1 : 0),
              agentId: agentId ?? t.agentId,
            }
          : t,
      );
      return { ...next, tasks, totalTokens: view.totalTokens + addTokens };
    }
    case 'heartbeat':
      return { ...next, updatedAt: event.at, startedAt: view.startedAt ?? event.at };
    case 'knowledge-updated':
      return { ...next, wikiEntries: event.wikiEntries, codegraphFiles: event.codegraphFiles };
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
