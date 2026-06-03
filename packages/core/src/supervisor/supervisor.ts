/**
 * The Supervisor is the process-level counterpart to the per-run resumable
 * orchestrator: it owns a {@link RunStore}, drives an {@link Orchestrator}
 * through a queue of requests with bounded concurrency, can resume runs that a
 * crash left non-terminal, and exposes a heartbeat/health snapshot. This is how
 * "24/7" operation is modeled — a host wires `drain()`/`heartbeat()` to its own
 * loop or timer; the core stays timer-free and deterministic.
 */
import { Orchestrator, type RunHandle } from '../orchestrator.js';
import type { RunStatus } from '../run-events.js';
import type { RunStore } from './run-store.js';
import type { OrchestrationRequest } from '../types.js';

export type SupervisorState = 'idle' | 'running' | 'paused' | 'stopped';

/** Persisted statuses that can be picked back up after a crash. */
export const RESUMABLE_STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'paused',
  'incomplete',
];

export interface SupervisorOptions {
  orchestrator: Orchestrator;
  store: RunStore;
  /** How many runs to drive concurrently (default 1). */
  concurrency?: number;
  clock?: () => number;
  onRunFinished?: (id: string, status: RunStatus) => void;
}

export interface SupervisorHealth {
  state: SupervisorState;
  queued: number;
  active: number;
  completed: number;
  lastHeartbeatAt: number;
  runs: Array<{ id: string; status: RunStatus | 'running' }>;
}

export class Supervisor {
  private readonly queue: OrchestrationRequest[] = [];
  private readonly resumeQueue: string[] = [];
  private readonly active = new Map<string, RunHandle>();
  private readonly completed: Array<{ id: string; status: RunStatus }> = [];
  /** Run ids this supervisor has already taken responsibility for (active, queued to resume, or done) — never resume them again. */
  private readonly handled = new Set<string>();
  private state: SupervisorState = 'idle';
  private lastHeartbeatAt = 0;
  private readonly clock: () => number;

  constructor(private readonly options: SupervisorOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  enqueue(request: OrchestrationRequest): this {
    this.queue.push(request);
    return this;
  }

  /**
   * Scan the store for non-terminal runs and queue them to resume. Runs this
   * supervisor is already driving or has already handled (active, queued, or
   * completed) are skipped, so a live run is never double-resumed and a
   * repeatedly-`incomplete` run is not re-queued every cycle (no livelock).
   */
  async resumeInterrupted(): Promise<string[]> {
    const ids = await this.options.store.list();
    const toResume: string[] = [];
    for (const id of ids) {
      if (this.handled.has(id) || this.active.has(id) || this.resumeQueue.includes(id)) continue;
      const record = await this.options.store.load(id);
      if (record && RESUMABLE_STATUSES.includes(record.status)) {
        this.handled.add(id);
        toResume.push(id);
      }
    }
    this.resumeQueue.push(...toResume);
    return toResume;
  }

  /** Process queued requests and resumes until both are empty (or paused/stopped). */
  async drain(): Promise<SupervisorHealth> {
    if (this.state === 'stopped' || this.state === 'paused') return this.health();
    this.state = 'running';
    this.heartbeat();
    const lanes = Math.max(1, this.options.concurrency ?? 1);
    await Promise.all(Array.from({ length: lanes }, () => this.worker()));
    if (this.state === 'running') this.state = 'idle';
    return this.health();
  }

  private async worker(): Promise<void> {
    while (this.state === 'running') {
      const resumeId = this.resumeQueue.shift();
      if (resumeId !== undefined) {
        const handle = await this.options.orchestrator.resume(resumeId);
        if (handle) await this.track(handle);
        continue;
      }
      const request = this.queue.shift();
      if (request === undefined) break;
      await this.track(this.options.orchestrator.start(request));
    }
  }

  private async track(handle: RunHandle): Promise<void> {
    this.handled.add(handle.id);
    this.active.set(handle.id, handle);
    this.heartbeat();
    try {
      const result = await handle.result;
      this.completed.push({ id: handle.id, status: result.status });
      this.options.onRunFinished?.(handle.id, result.status);
    } finally {
      this.active.delete(handle.id);
      this.heartbeat();
    }
  }

  /** Stop pulling new work (in-flight runs finish). Call drain() again after resume(). */
  pause(): void {
    if (this.state === 'running' || this.state === 'idle') this.state = 'paused';
  }

  resume(): void {
    if (this.state === 'paused') this.state = 'idle';
  }

  /** Hard stop: cancel in-flight runs and refuse further work. */
  stop(): void {
    this.state = 'stopped';
    for (const handle of this.active.values()) handle.cancel();
  }

  /** Stamp and return a health snapshot (a host can call this on a timer). */
  heartbeat(): SupervisorHealth {
    this.lastHeartbeatAt = this.clock();
    return this.health();
  }

  health(): SupervisorHealth {
    return {
      state: this.state,
      queued: this.queue.length + this.resumeQueue.length,
      active: this.active.size,
      completed: this.completed.length,
      lastHeartbeatAt: this.lastHeartbeatAt,
      runs: [
        ...[...this.active.keys()].map((id) => ({ id, status: 'running' as const })),
        ...this.completed.map((c) => ({ id: c.id, status: c.status })),
      ],
    };
  }
}
