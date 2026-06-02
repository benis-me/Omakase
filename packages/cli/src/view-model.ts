/**
 * The CLI/TUI view-model: a pure reducer that folds the orchestrator's event
 * stream into a render-ready snapshot. Keeping this logic out of the Ink
 * components makes it unit-testable and keeps the TUI a thin presentation
 * layer over it.
 */
import type {
  AgentRole,
  OrchestratorEvent,
  RouteKind,
  RunStatus,
  TaskStatus,
  WorkMode,
} from '@omakase/core';

export type RunViewStatus = RunStatus | 'idle';

export interface TaskView {
  id: string;
  title: string;
  role: AgentRole;
  status: TaskStatus;
}

export interface RunView {
  runId: string | null;
  status: RunViewStatus;
  mode: WorkMode;
  route: { kind: RouteKind; reason: string } | null;
  tasks: TaskView[];
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
    route: null,
    tasks: [],
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

function upsertTasks(tasks: TaskView[], snapshot: { tasks: TaskView[] }): TaskView[] {
  return snapshot.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    role: t.role,
    status: t.status,
  }));
}

export function reduceRunView(view: RunView, event: OrchestratorEvent): RunView {
  const line = formatEventLine(event);
  const events = line ? [...view.events, line].slice(-MAX_EVENT_LINES) : view.events;
  const next: RunView = { ...view, events };

  switch (event.type) {
    case 'run-started':
      return { ...next, runId: event.runId, status: 'running', mode: event.mode };
    case 'routed':
      return { ...next, route: { kind: event.decision.kind, reason: event.decision.reason } };
    case 'planned':
      return { ...next, tasks: upsertTasks(view.tasks, event.snapshot) };
    case 'replanned':
      return { ...next, tasks: upsertTasks(view.tasks, event.snapshot) };
    case 'task-status': {
      const existing = view.tasks.find((t) => t.id === event.taskId);
      const tasks = existing
        ? view.tasks.map((t) => (t.id === event.taskId ? { ...t, status: event.to } : t))
        : [...view.tasks, { id: event.taskId, title: event.title, role: 'worker' as AgentRole, status: event.to }];
      return { ...next, tasks };
    }
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

/** Fold a complete event list into a final view (for non-interactive runs/tests). */
export function buildRunView(events: OrchestratorEvent[], mode: WorkMode = 'normal'): RunView {
  return events.reduce(reduceRunView, initialRunView(mode));
}
