/**
 * Run persistence for the resumable supervisor. A {@link RunRecord} captures
 * everything needed to resume a run after a pause or crash: the request, the
 * route decision, the plan-graph snapshot, the wiki, the inbox, and the event
 * log. {@link MemoryRunStore} is for tests and ephemeral use; {@link FileRunStore}
 * writes one JSON file per run.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlanGraphSnapshot } from '../plan/plan-graph.js';
import type { RouteDecision } from '../router/router.js';
import type { WikiSnapshot } from '../knowledge/wiki.js';
import type { InboxItemSnapshot, OrchestratorEvent, RunStatus } from '../run-events.js';
import type { OrchestrationRequest, WorkMode } from '../types.js';

export interface RunRecord {
  id: string;
  request: OrchestrationRequest;
  mode: WorkMode;
  status: RunStatus;
  routeDecision?: RouteDecision;
  plan: PlanGraphSnapshot;
  wiki: WikiSnapshot;
  inbox: InboxItemSnapshot[];
  events: OrchestratorEvent[];
  summary: string;
  /** Cumulative token/cost spend, persisted so a budget ceiling survives resume. */
  spentTokens?: number;
  spentCostUsd?: number;
  /**
   * Last cross-process control command seq applied, persisted so a daemon
   * restart neither re-applies an already-honored command nor drops a pending
   * one (see {@link ControlSource}). Optional for backward compatibility.
   */
  lastControlSeq?: number;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  checkpointSeq: number;
}

export interface RunStore {
  save(record: RunRecord): Promise<void>;
  load(id: string): Promise<RunRecord | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

/** Structural validation of a parsed run record before it is used to resume. */
export function isValidRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<RunRecord>;
  if (
    !(
      typeof r.id === 'string' &&
      typeof r.status === 'string' &&
      typeof r.request === 'object' &&
      r.request !== null &&
      typeof r.plan === 'object' &&
      r.plan !== null &&
      Array.isArray((r.plan as { tasks?: unknown }).tasks) &&
      Array.isArray(r.inbox) &&
      Array.isArray(r.events) &&
      typeof r.checkpointSeq === 'number'
    )
  ) {
    return false;
  }
  // The wiki and every task must be the shape resume() deserializes, or
  // ProjectWiki.fromJSON / PlanGraph.fromSnapshot throw synchronously inside the
  // RunController constructor — before run()'s try/catch exists. Validate them
  // here so a partial/stale file "fails cleanly" (returns null) as documented,
  // rather than crashing the resume path.
  const wiki = (r as { wiki?: unknown }).wiki;
  if (!wiki || typeof wiki !== 'object' || !Array.isArray((wiki as { entries?: unknown }).entries)) {
    return false;
  }
  const tasks = (r.plan as { tasks: unknown[] }).tasks;
  return tasks.every(
    (t) =>
      Boolean(t) &&
      typeof (t as { id?: unknown }).id === 'string' &&
      Array.isArray((t as { dependsOn?: unknown }).dependsOn),
  );
}

export class MemoryRunStore implements RunStore {
  private readonly records = new Map<string, RunRecord>();

  async save(record: RunRecord): Promise<void> {
    // Deep clone so later mutations of the live record don't leak in.
    this.records.set(record.id, structuredClone(record));
  }

  async load(id: string): Promise<RunRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(): Promise<string[]> {
    return [...this.records.keys()];
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export class FileRunStore implements RunStore {
  private tmpSeq = 0;
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async save(record: RunRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Write to a unique temp file then atomically rename into place, so a crash
    // mid-write can never truncate the canonical run file (checkpoints are
    // frequent — once per task) and concurrent checkpoints don't collide.
    const target = this.file(record.id);
    this.tmpSeq += 1;
    const tmp = `${target}.${this.tmpSeq}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, target);
  }

  async load(id: string): Promise<RunRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(id), 'utf8')) as unknown;
      // Validate the shape before handing it to PlanGraph.fromSnapshot /
      // Inbox.restore, so a partial/stale file fails cleanly rather than throwing.
      return isValidRunRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries
        .filter((e) => e.endsWith('.json') && !e.endsWith('.control.json'))
        .map((e) => e.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
