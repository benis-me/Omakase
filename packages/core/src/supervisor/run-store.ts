/**
 * Run persistence for the resumable supervisor. A {@link RunRecord} captures
 * everything needed to resume a run after a pause or crash: the request, the
 * route decision, the plan-graph snapshot, the wiki, the inbox, and the event
 * log. {@link MemoryRunStore} is for tests and ephemeral use; {@link FileRunStore}
 * writes one JSON file per run.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async save(record: RunRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(record.id), JSON.stringify(record, null, 2), 'utf8');
  }

  async load(id: string): Promise<RunRecord | null> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as RunRecord;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries
        .filter((e) => e.endsWith('.json'))
        .map((e) => e.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
