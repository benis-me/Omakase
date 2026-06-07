/**
 * The plan graph: a dependency DAG of tasks the orchestrator executes. Nodes
 * carry a status that advances through the Ralph loop; edges (`dependsOn`)
 * gate readiness. The graph is serializable so a run can be checkpointed and
 * resumed, and emits status transitions for hooks and the TUI.
 */
import { createIdGenerator, type IdGenerator } from '../ids.js';
import type { AgentRole } from '../types.js';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'needs-review'
  | 'blocked'
  | 'failed'
  | 'succeeded'
  | 'cancelled';

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export type ReplanReason =
  | 'task-failed'
  | 'review-rejected'
  | 'user-input'
  | 'criteria-edited'
  | 'new-requirement'
  | 'dependency-blocked'
  | 'manual';

export interface TaskResult {
  success: boolean;
  summary: string;
  output: string;
  agentId?: string;
  error?: string;
}

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  role: AgentRole;
  status: TaskStatus;
  dependsOn: string[];
  attempts: number;
  result?: TaskResult;
  reviewNotes?: string;
  tags: string[];
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface NewTask {
  title: string;
  description?: string;
  role?: AgentRole;
  dependsOn?: string[];
  tags?: string[];
  status?: TaskStatus;
  metadata?: Record<string, unknown>;
  id?: string;
}

export interface PlanGraphSnapshot {
  tasks: TaskNode[];
  seq: number;
}

export type StatusChangeListener = (change: {
  task: TaskNode;
  from: TaskStatus;
  to: TaskStatus;
}) => void;

export interface PlanGraphOptions {
  idGenerator?: IdGenerator;
  clock?: () => number;
  onStatusChange?: StatusChangeListener;
}

export class PlanGraph {
  private readonly nodes = new Map<string, TaskNode>();
  private readonly order: string[] = [];
  private readonly ids: IdGenerator;
  private readonly clock: () => number;
  private listener: StatusChangeListener | undefined;

  constructor(options: PlanGraphOptions = {}) {
    this.ids = options.idGenerator ?? createIdGenerator();
    this.clock = options.clock ?? (() => Date.now());
    this.listener = options.onStatusChange;
  }

  setStatusListener(listener: StatusChangeListener | undefined): void {
    this.listener = listener;
  }

  addTask(task: NewTask): TaskNode {
    const id = task.id ?? this.ids.next('task');
    if (this.nodes.has(id)) throw new Error(`Duplicate task id: ${id}`);
    const node: TaskNode = {
      id,
      title: task.title,
      description: task.description ?? task.title,
      role: task.role ?? 'worker',
      status: task.status ?? 'pending',
      dependsOn: [...(task.dependsOn ?? [])],
      attempts: 0,
      tags: [...(task.tags ?? [])],
      createdAt: this.clock(),
      metadata: { ...(task.metadata ?? {}) },
    };
    this.nodes.set(id, node);
    this.order.push(id);
    return node;
  }

  get(id: string): TaskNode | undefined {
    return this.nodes.get(id);
  }

  require(id: string): TaskNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown task id: ${id}`);
    return node;
  }

  tasks(): TaskNode[] {
    return this.order.map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  get size(): number {
    return this.nodes.size;
  }

  setStatus(id: string, to: TaskStatus): TaskNode {
    const node = this.require(id);
    const from = node.status;
    if (from === to) return node;
    node.status = to;
    this.listener?.({ task: node, from, to });
    return node;
  }

  setResult(id: string, result: TaskResult): TaskNode {
    const node = this.require(id);
    node.result = result;
    return node;
  }

  incrementAttempts(id: string): number {
    const node = this.require(id);
    node.attempts += 1;
    return node.attempts;
  }

  /** Refund an attempt that didn't really run (e.g. a sibling-aborted task). */
  decrementAttempts(id: string): number {
    const node = this.require(id);
    if (node.attempts > 0) node.attempts -= 1;
    return node.attempts;
  }

  /** True when every dependency of `id` has succeeded. */
  dependenciesSatisfied(id: string): boolean {
    const node = this.require(id);
    return node.dependsOn.every((dep) => this.nodes.get(dep)?.status === 'succeeded');
  }

  /**
   * True when a dependency has failed, been cancelled, or is itself blocked —
   * so blocking propagates transitively down the dependency chain rather than
   * leaving a deeper task stuck `pending` forever.
   */
  dependenciesBroken(id: string): boolean {
    const node = this.require(id);
    return node.dependsOn.some((dep) => {
      const s = this.nodes.get(dep)?.status;
      return s === 'failed' || s === 'cancelled' || s === 'blocked';
    });
  }

  /**
   * Recompute readiness: pending tasks whose deps all succeeded become `ready`;
   * pending tasks with a broken (failed/cancelled/blocked) dependency become
   * `blocked`. Iterates to a fixpoint so transitive blocking propagates in one
   * call regardless of task insertion order. Returns the tasks that are `ready`.
   */
  refreshReadiness(): TaskNode[] {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.tasks()) {
        if (node.status !== 'pending') continue;
        if (this.dependenciesBroken(node.id)) {
          this.setStatus(node.id, 'blocked');
          changed = true;
        } else if (this.dependenciesSatisfied(node.id)) {
          this.setStatus(node.id, 'ready');
          changed = true;
        }
      }
    }
    return this.tasks().filter((t) => t.status === 'ready');
  }

  readyTasks(): TaskNode[] {
    return this.tasks().filter((t) => t.status === 'ready');
  }

  pendingOrActive(): TaskNode[] {
    return this.tasks().filter(
      (t) => !TERMINAL_STATUSES.includes(t.status),
    );
  }

  isComplete(): boolean {
    return this.tasks().every((t) => TERMINAL_STATUSES.includes(t.status));
  }

  succeeded(): boolean {
    const all = this.tasks();
    return all.length > 0 && all.every((t) => t.status === 'succeeded');
  }

  dependents(id: string): TaskNode[] {
    return this.tasks().filter((t) => t.dependsOn.includes(id));
  }

  /** Detect dependency cycles; returns the first cycle found as an id list, or null. */
  findCycle(): string[] | null {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    for (const id of this.order) color.set(id, WHITE);

    const visit = (id: string): string[] | null => {
      color.set(id, GRAY);
      stack.push(id);
      for (const dep of this.nodes.get(id)?.dependsOn ?? []) {
        if (!this.nodes.has(dep)) continue;
        const c = color.get(dep);
        if (c === GRAY) {
          const cycleStart = stack.indexOf(dep);
          return stack.slice(cycleStart).concat(dep);
        }
        if (c === WHITE) {
          const found = visit(dep);
          if (found) return found;
        }
      }
      stack.pop();
      color.set(id, BLACK);
      return null;
    };

    for (const id of this.order) {
      if (color.get(id) === WHITE) {
        const found = visit(id);
        if (found) return found;
      }
    }
    return null;
  }

  /** Topological order (dependencies first). Throws if the graph has a cycle. */
  topologicalOrder(): TaskNode[] {
    const cycle = this.findCycle();
    if (cycle) throw new Error(`Plan graph has a cycle: ${cycle.join(' -> ')}`);
    const visited = new Set<string>();
    const result: TaskNode[] = [];
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dep of this.nodes.get(id)?.dependsOn ?? []) {
        if (this.nodes.has(dep)) visit(dep);
      }
      const node = this.nodes.get(id);
      if (node) result.push(node);
    };
    for (const id of this.order) visit(id);
    return result;
  }

  snapshot(): PlanGraphSnapshot {
    return {
      tasks: this.tasks().map((t) => ({
        ...t,
        dependsOn: [...t.dependsOn],
        tags: [...t.tags],
        metadata: { ...t.metadata },
        ...(t.result ? { result: { ...t.result } } : {}),
      })),
      seq: this.order.length,
    };
  }

  static fromSnapshot(
    snapshot: PlanGraphSnapshot,
    options: PlanGraphOptions = {},
  ): PlanGraph {
    // Seed the id generator past the highest numeric suffix so new ids don't collide.
    let maxSeq = 0;
    for (const t of snapshot.tasks) {
      const m = /-(\d+)$/.exec(t.id);
      if (m) maxSeq = Math.max(maxSeq, Number.parseInt(m[1]!, 10));
    }
    const graph = new PlanGraph({
      ...options,
      idGenerator: options.idGenerator ?? createIdGenerator(maxSeq),
    });
    // Bypass addTask validation/clock to restore exactly.
    for (const task of snapshot.tasks) {
      graph['nodes'].set(task.id, {
        ...task,
        dependsOn: [...task.dependsOn],
        tags: [...(task.tags ?? [])],
        metadata: { ...(task.metadata ?? {}) },
      });
      graph['order'].push(task.id);
    }
    return graph;
  }

  stats(): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      'needs-review': 0,
      blocked: 0,
      failed: 0,
      succeeded: 0,
      cancelled: 0,
    };
    for (const t of this.tasks()) counts[t.status] += 1;
    return counts;
  }
}
