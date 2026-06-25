/**
 * Map the orchestrator's rich event stream down to a compact, renderable feed
 * for the cockpit. High-signal structural events become feed items; the token
 * firehose (text/thinking deltas, usage, heartbeats) is dropped. One
 * OrchestratorEvent yields zero or one {@link CockpitEvent}.
 */
import type { OrchestratorEvent } from '@omakase/core';
import type { CockpitEvent, CockpitLevel } from '@shared/types';

function make(
  seq: number,
  kind: CockpitEvent['kind'],
  title: string,
  extra: Partial<Omit<CockpitEvent, 'seq' | 'kind' | 'title'>> = {},
): CockpitEvent {
  return { seq, kind, title, level: extra.level ?? 'info', ...extra };
}

export function toCockpitEvent(event: OrchestratorEvent, seq: number): CockpitEvent | null {
  switch (event.type) {
    case 'run-started':
      return make(seq, 'status', 'Run started', { detail: event.request.prompt });
    case 'routed':
      return make(seq, 'route', `Routed → ${event.decision.kind}`, {
        detail: 'rationale' in event.decision ? (event.decision as { rationale?: string }).rationale : undefined,
      });
    case 'planned':
      return make(seq, 'plan', `Planned ${event.snapshot.tasks.length} task(s)`);
    case 'replanned':
      return make(seq, 'plan', `Replanned (${event.reason})`);
    case 'task-status': {
      const level: CockpitLevel =
        event.to === 'failed' ? 'error' : event.to === 'succeeded' ? 'success' : 'info';
      return make(seq, 'task', event.title, {
        detail: `${event.from} → ${event.to}`,
        status: event.to,
        level,
      });
    }
    case 'agent-event': {
      const ae = event.event;
      if (ae.type === 'tool_use') {
        const name = (ae as { name?: string }).name ?? 'tool';
        return make(seq, 'tool', `${event.role}: ${name}`, { role: event.role });
      }
      if (ae.type === 'error') {
        return make(seq, 'error', `${event.role} error`, {
          detail: (ae as { message?: string }).message,
          role: event.role,
          level: 'error',
        });
      }
      return null;
    }
    case 'review':
      return make(seq, 'review', event.approved ? 'Review: approved' : 'Review: changes requested', {
        detail: event.notes,
        level: event.approved ? 'success' : 'warn',
      });
    case 'acceptance-updated':
      return make(seq, 'note', `Acceptance ${event.acceptance.progress.passed}/${event.acceptance.progress.total}`, {
        level: event.acceptance.progress.complete ? 'success' : 'info',
      });
    case 'report-created':
      return make(seq, 'report', `Report: ${event.report.title}`, { detail: event.report.summary });
    case 'knowledge-event-created':
      return make(seq, 'knowledge', `${event.event.kind}: ${event.event.title}`, {
        detail: event.event.body,
      });
    case 'risk-gate-opened':
      return make(seq, 'gate', 'Needs your decision', {
        detail: event.gate.question,
        gateId: event.gate.id,
        level: 'warn',
      });
    case 'risk-gate-answered':
      return make(seq, 'gate-answered', 'Gate answered', {
        detail: event.gate.answer ?? undefined,
        gateId: event.gate.id,
        level: 'success',
      });
    case 'iteration-updated':
      return make(seq, 'iteration', `Iteration ${event.iteration.index + 1}: ${event.iteration.status}`, {
        detail: event.iteration.reason,
      });
    case 'budget-exhausted':
      return make(seq, 'note', 'Budget exhausted', {
        detail: `${event.spentTokens} tokens`,
        level: 'warn',
      });
    case 'user-input':
      return make(seq, 'note', 'Your input', { detail: event.item.text });
    case 'paused':
      return make(seq, 'status', 'Paused', { level: 'warn' });
    case 'resumed':
      return make(seq, 'status', 'Resumed');
    case 'run-finished': {
      const level: CockpitLevel =
        event.status === 'succeeded' ? 'success' : event.status === 'failed' ? 'error' : 'info';
      return make(seq, 'finished', `Run ${event.status}`, { detail: event.summary, status: event.status, level });
    }
    case 'error':
      return make(seq, 'error', `Error: ${event.phase}`, { detail: event.message, level: 'error' });
    case 'workflow-created':
      return make(seq, 'status', 'Workflow started');
    case 'workflow-phase-started':
      return make(seq, 'plan', `Phase: ${event.phase.name}`);
    case 'workflow-agent-started':
      return make(seq, 'task', event.agent.title, { role: event.agent.role });
    case 'workflow-agent-finished': {
      const ok = event.agent.status === 'succeeded';
      return make(seq, 'task', event.agent.title, {
        role: event.agent.role,
        status: event.agent.status,
        level: ok ? 'success' : event.agent.status === 'failed' ? 'error' : 'info',
      });
    }
    case 'workflow-checkpoint':
      return make(seq, 'note', `Checkpoint: ${event.checkpoint.label}`);
    case 'workflow-finished': {
      const level: CockpitLevel = event.workflow.status === 'succeeded' ? 'success' : event.workflow.status === 'failed' ? 'error' : 'info';
      return make(seq, 'finished', `Workflow ${event.workflow.status}`, { status: event.workflow.status, level });
    }
    default:
      return null;
  }
}

/** Map a full persisted event log into a seq-numbered cockpit feed. */
export function toCockpitFeed(events: OrchestratorEvent[]): CockpitEvent[] {
  const feed: CockpitEvent[] = [];
  let seq = 0;
  for (const event of events) {
    const item = toCockpitEvent(event, seq);
    if (item) {
      feed.push(item);
      seq += 1;
    }
  }
  return feed;
}
