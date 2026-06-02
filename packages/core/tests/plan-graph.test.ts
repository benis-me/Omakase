import { describe, expect, it } from 'vitest';
import { PlanGraph } from '../src/plan/plan-graph.js';
import { createIdGenerator } from '../src/ids.js';

function fixedGraph() {
  return new PlanGraph({ idGenerator: createIdGenerator(), clock: () => 0 });
}

describe('PlanGraph', () => {
  it('computes readiness from dependency status', () => {
    const g = fixedGraph();
    const a = g.addTask({ title: 'A' });
    const b = g.addTask({ title: 'B', dependsOn: [a.id] });
    expect(g.refreshReadiness().map((t) => t.id)).toEqual([a.id]);
    expect(g.get(b.id)?.status).toBe('pending');

    g.setStatus(a.id, 'succeeded');
    expect(g.refreshReadiness().map((t) => t.id)).toContain(b.id);
    expect(g.get(b.id)?.status).toBe('ready');
  });

  it('blocks a task when a dependency fails', () => {
    const g = fixedGraph();
    const a = g.addTask({ title: 'A' });
    const b = g.addTask({ title: 'B', dependsOn: [a.id] });
    g.setStatus(a.id, 'failed');
    g.refreshReadiness();
    expect(g.get(b.id)?.status).toBe('blocked');
  });

  it('emits status-change events', () => {
    const changes: Array<{ from: string; to: string }> = [];
    const g = new PlanGraph({
      idGenerator: createIdGenerator(),
      clock: () => 0,
      onStatusChange: ({ from, to }) => changes.push({ from, to }),
    });
    const a = g.addTask({ title: 'A' });
    g.setStatus(a.id, 'running');
    g.setStatus(a.id, 'succeeded');
    expect(changes).toEqual([
      { from: 'pending', to: 'running' },
      { from: 'running', to: 'succeeded' },
    ]);
  });

  it('detects cycles and orders acyclic graphs topologically', () => {
    const cyclic = fixedGraph();
    const a = cyclic.addTask({ title: 'A', id: 'a' });
    const b = cyclic.addTask({ title: 'B', id: 'b', dependsOn: ['a'] });
    cyclic.get(a.id)!.dependsOn.push('b');
    expect(cyclic.findCycle()).not.toBeNull();
    expect(() => cyclic.topologicalOrder()).toThrow(/cycle/);

    const dag = fixedGraph();
    const x = dag.addTask({ title: 'X', id: 'x' });
    const y = dag.addTask({ title: 'Y', id: 'y', dependsOn: ['x'] });
    void y;
    const order = dag.topologicalOrder().map((t) => t.id);
    expect(order.indexOf('x')).toBeLessThan(order.indexOf('y'));
  });

  it('round-trips through a snapshot and avoids id collisions', () => {
    const g = fixedGraph();
    g.addTask({ title: 'A' });
    g.addTask({ title: 'B', dependsOn: ['task-1'] });
    const snapshot = g.snapshot();

    const restored = PlanGraph.fromSnapshot(snapshot);
    expect(restored.tasks().map((t) => t.title)).toEqual(['A', 'B']);
    // New tasks get ids beyond the restored max.
    const fresh = restored.addTask({ title: 'C' });
    expect(restored.get(fresh.id)).toBeDefined();
    expect(snapshot.tasks.some((t) => t.id === fresh.id)).toBe(false);
  });

  it('reports completion only when all tasks are terminal', () => {
    const g = fixedGraph();
    const a = g.addTask({ title: 'A' });
    expect(g.isComplete()).toBe(false);
    g.setStatus(a.id, 'succeeded');
    expect(g.isComplete()).toBe(true);
    expect(g.succeeded()).toBe(true);
  });
});
