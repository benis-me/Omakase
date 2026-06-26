import { describe, expect, it } from 'vitest';
import type { OrchestratorEvent } from '@omakase/core';
import { toCockpitEvent, toCockpitFeed } from './cockpit-map.js';

const ev = (o: object): OrchestratorEvent => o as unknown as OrchestratorEvent;

describe('toCockpitEvent', () => {
  it('maps a task-status transition with a success level', () => {
    expect(
      toCockpitEvent(ev({ type: 'task-status', taskId: 't1', title: 'Build', from: 'running', to: 'succeeded' }), 0),
    ).toMatchObject({ kind: 'task', title: 'Build', level: 'success', status: 'succeeded' });
  });

  it('maps an agent-assigned event to a roster entry with its CLI and model', () => {
    expect(
      toCockpitEvent(
        ev({
          type: 'agent-assigned',
          role: 'worker',
          taskId: 't1',
          title: 'Build',
          assignment: { agentId: 'codex', model: 'gpt-5' },
          agentRunId: 'a1',
        }),
        0,
      ),
    ).toMatchObject({
      kind: 'agent',
      title: 'Build',
      role: 'worker',
      status: 'running',
      agentRunId: 'a1',
      agentId: 'codex',
      model: 'gpt-5',
      taskId: 't1',
    });
  });

  it('maps an agent done event to a terminal roster status', () => {
    expect(
      toCockpitEvent(
        ev({
          type: 'agent-event',
          role: 'planner',
          taskId: null,
          title: 'planner',
          assignment: { agentId: 'claude', model: null },
          agentRunId: 'a2',
          event: { type: 'done', reason: 'completed' },
        }),
        0,
      ),
    ).toMatchObject({ kind: 'agent', role: 'planner', status: 'done', agentRunId: 'a2', agentId: 'claude' });
    expect(
      toCockpitEvent(
        ev({
          type: 'agent-event',
          role: 'worker',
          taskId: 't1',
          assignment: { agentId: 'codex', model: null },
          agentRunId: 'a3',
          event: { type: 'done', reason: 'error' },
        }),
        1,
      ),
    ).toMatchObject({ kind: 'agent', status: 'failed', agentRunId: 'a3' });
  });

  it('maps a tool_use agent event to a tool line', () => {
    expect(
      toCockpitEvent(ev({ type: 'agent-event', role: 'worker', taskId: 't1', assignment: {}, event: { type: 'tool_use', name: 'edit' } }), 1),
    ).toMatchObject({ kind: 'tool', title: 'worker: edit', role: 'worker' });
  });

  it('drops token deltas and heartbeats', () => {
    expect(
      toCockpitEvent(ev({ type: 'agent-event', role: 'worker', taskId: 't1', assignment: {}, event: { type: 'text_delta', text: 'hi' } }), 0),
    ).toBeNull();
    expect(toCockpitEvent(ev({ type: 'heartbeat', at: 1 }), 0)).toBeNull();
  });

  it('maps a risk gate, carrying its id and question', () => {
    expect(
      toCockpitEvent(ev({ type: 'risk-gate-opened', gate: { id: 'g1', question: 'Proceed?', reason: 'user-confirmation' }, gates: [] }), 0),
    ).toMatchObject({ kind: 'gate', gateId: 'g1', level: 'warn', detail: 'Proceed?' });
  });

  it('maps dynamic-workflow agent and finish events', () => {
    expect(
      toCockpitEvent(ev({ type: 'workflow-agent-started', agent: { title: 'worker A', role: 'worker' }, workflow: {} }), 0),
    ).toMatchObject({ kind: 'task', title: 'worker A', role: 'worker' });
    expect(
      toCockpitEvent(ev({ type: 'workflow-finished', workflow: { status: 'succeeded' } }), 1),
    ).toMatchObject({ kind: 'finished', level: 'success' });
  });
});

describe('toCockpitFeed', () => {
  it('numbers only the surviving events sequentially', () => {
    const feed = toCockpitFeed([
      ev({ type: 'run-started', runId: 'r', request: { prompt: 'x' }, mode: 'normal' }),
      ev({ type: 'heartbeat', at: 1 }),
      ev({ type: 'run-finished', status: 'succeeded', summary: 'done' }),
    ]);
    expect(feed.map((f) => f.seq)).toEqual([0, 1]);
    expect(feed[1]).toMatchObject({ kind: 'finished', level: 'success' });
  });
});
