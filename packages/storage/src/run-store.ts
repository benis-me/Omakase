/**
 * SQLite-backed {@link RunStore}. A {@link RunRecord} is decomposed on save and
 * reassembled on load so the high-volume event log becomes append-only (cheap
 * checkpoints, live tailing) while the record still round-trips exactly:
 *
 *   - `runs.record_json` holds the full record MINUS its events.
 *   - `run_events` holds the events, one row per event, keyed by (run_id, seq).
 *   - `tasks` / `reports` / `run_knowledge_events` are denormalized read models
 *     rebuilt from the record on every save (for cross-run queries by the UI).
 *
 * `load()` rebuilds the record from `record_json` + the ordered event rows and
 * validates it with the same {@link isValidRunRecord} guard as the file store,
 * so a corrupt/partial row "fails clean" (returns null) instead of throwing.
 */
import {
  isValidRunRecord,
  type KnowledgeEvent,
  type OrchestratorEvent,
  type ReportArtifact,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type TaskNode,
  type WorkMode,
} from '@omakase/core';
import type { Db } from './db/database.js';

/** Lightweight per-run row for list views, without parsing the full record. */
export interface RunSummary {
  id: string;
  mode: WorkMode;
  status: RunStatus;
  summary: string;
  owner: string | null;
  spentTokens: number | null;
  spentCostUsd: number | null;
  /** Wall-clock ms a usage limit resets at, when the run is parked on one. */
  rateLimitedUntil: number | null;
  checkpointSeq: number;
  eventsCount: number;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
}

interface RunScalarRow {
  events_count: number;
}

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: Db) {}

  async save(record: RunRecord): Promise<void> {
    this.saveSync(record);
  }

  /** Synchronous core of {@link save}; also used directly by the legacy importer. */
  saveSync(record: RunRecord): void {
    const tx = this.db.transaction((rec: RunRecord) => {
      const prev = this.db
        .prepare('SELECT events_count FROM runs WHERE id = ?')
        .get(rec.id) as RunScalarRow | undefined;
      const prevCount = prev?.events_count ?? 0;
      const events = rec.events ?? [];
      const recordWithoutEvents: RunRecord = { ...rec, events: [] };

      this.db
        .prepare(
          `INSERT INTO runs
             (id, mode, status, summary, spent_tokens, spent_cost_usd,
              rate_limited_until, checkpoint_seq, last_control_seq, events_count,
              record_json, created_at, updated_at, heartbeat_at)
           VALUES
             (@id, @mode, @status, @summary, @spent_tokens, @spent_cost_usd,
              @rate_limited_until, @checkpoint_seq, @last_control_seq, @events_count,
              @record_json, @created_at, @updated_at, @heartbeat_at)
           ON CONFLICT(id) DO UPDATE SET
             mode = excluded.mode,
             status = excluded.status,
             summary = excluded.summary,
             spent_tokens = excluded.spent_tokens,
             spent_cost_usd = excluded.spent_cost_usd,
             rate_limited_until = excluded.rate_limited_until,
             checkpoint_seq = excluded.checkpoint_seq,
             last_control_seq = excluded.last_control_seq,
             events_count = excluded.events_count,
             record_json = excluded.record_json,
             updated_at = excluded.updated_at,
             heartbeat_at = excluded.heartbeat_at`,
        )
        .run({
          id: rec.id,
          mode: rec.mode,
          status: rec.status,
          summary: rec.summary ?? '',
          spent_tokens: rec.spentTokens ?? null,
          spent_cost_usd: rec.spentCostUsd ?? null,
          rate_limited_until: rec.rateLimitedUntil ?? null,
          checkpoint_seq: rec.checkpointSeq ?? 0,
          last_control_seq: rec.lastControlSeq ?? null,
          events_count: events.length,
          record_json: JSON.stringify(recordWithoutEvents),
          created_at: rec.createdAt,
          updated_at: rec.updatedAt,
          heartbeat_at: rec.heartbeatAt,
        });

      // Events are append-only in normal operation: insert only the new tail.
      // If the incoming log is somehow shorter (a rewound/replaced run), fall
      // back to a full rewrite so the persisted log always matches the record.
      if (events.length >= prevCount) {
        const insert = this.db.prepare(
          `INSERT OR REPLACE INTO run_events (run_id, seq, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (let i = prevCount; i < events.length; i += 1) {
          insert.run(rec.id, i, events[i].type, JSON.stringify(events[i]), rec.updatedAt);
        }
      } else {
        this.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(rec.id);
        const insert = this.db.prepare(
          `INSERT INTO run_events (run_id, seq, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (let i = 0; i < events.length; i += 1) {
          insert.run(rec.id, i, events[i].type, JSON.stringify(events[i]), rec.updatedAt);
        }
      }

      this.rebuildProjections(rec);
    });
    tx(record);
  }

  private rebuildProjections(rec: RunRecord): void {
    this.db.prepare('DELETE FROM tasks WHERE run_id = ?').run(rec.id);
    this.db.prepare('DELETE FROM reports WHERE run_id = ?').run(rec.id);
    this.db.prepare('DELETE FROM run_knowledge_events WHERE run_id = ?').run(rec.id);

    const tasks: TaskNode[] = rec.plan?.tasks ?? [];
    const insertTask = this.db.prepare(
      `INSERT INTO tasks (run_id, id, title, role, status, attempts, depends_on_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of tasks) {
      insertTask.run(
        rec.id,
        t.id,
        t.title ?? '',
        t.role ?? '',
        t.status ?? '',
        t.attempts ?? 0,
        JSON.stringify(t.dependsOn ?? []),
        t.createdAt ?? 0,
      );
    }

    const reports: ReportArtifact[] = rec.reports ?? [];
    const insertReport = this.db.prepare(
      `INSERT INTO reports (run_id, id, kind, title, summary, task_id, author_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of reports) {
      insertReport.run(
        rec.id,
        r.id,
        r.kind ?? '',
        r.title ?? '',
        r.summary ?? '',
        r.taskId ?? null,
        r.authorAgentId ?? null,
        r.createdAt ?? 0,
      );
    }

    const events: KnowledgeEvent[] = rec.knowledgeEvents ?? [];
    const insertKnow = this.db.prepare(
      `INSERT INTO run_knowledge_events (run_id, id, kind, title, body, task_id, author_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of events) {
      insertKnow.run(
        rec.id,
        e.id,
        e.kind ?? '',
        e.title ?? '',
        e.body ?? '',
        e.taskId ?? null,
        e.authorAgentId ?? null,
        e.createdAt ?? 0,
      );
    }
  }

  async load(id: string): Promise<RunRecord | null> {
    const row = this.db.prepare('SELECT record_json FROM runs WHERE id = ?').get(id) as
      | { record_json: string }
      | undefined;
    if (!row) return null;
    let record: RunRecord;
    try {
      record = JSON.parse(row.record_json) as RunRecord;
    } catch {
      return null;
    }
    const eventRows = this.db
      .prepare('SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq ASC')
      .all(id) as { payload_json: string }[];
    try {
      record.events = eventRows.map((e) => JSON.parse(e.payload_json) as OrchestratorEvent);
    } catch {
      return null;
    }
    return isValidRunRecord(record) ? record : null;
  }

  async list(): Promise<string[]> {
    const rows = this.db.prepare('SELECT id FROM runs ORDER BY updated_at DESC').all() as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction((runId: string) => {
      this.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM tasks WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM reports WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM run_knowledge_events WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    });
    tx(id);
  }

  // ── Read models (for the cockpit / list views) ───────────────────────────

  /** Run summaries, newest first — cheap list view without parsing records. */
  summaries(): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, mode, status, summary, owner, spent_tokens, spent_cost_usd,
                rate_limited_until, checkpoint_seq, events_count, created_at, updated_at, heartbeat_at
         FROM runs ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      id: string;
      mode: string;
      status: string;
      summary: string;
      owner: string | null;
      spent_tokens: number | null;
      spent_cost_usd: number | null;
      rate_limited_until: number | null;
      checkpoint_seq: number;
      events_count: number;
      created_at: number;
      updated_at: number;
      heartbeat_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      mode: r.mode as WorkMode,
      status: r.status as RunStatus,
      summary: r.summary,
      owner: r.owner,
      spentTokens: r.spent_tokens,
      spentCostUsd: r.spent_cost_usd,
      rateLimitedUntil: r.rate_limited_until,
      checkpointSeq: r.checkpoint_seq,
      eventsCount: r.events_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      heartbeatAt: r.heartbeat_at,
    }));
  }

  /** Events for a run from `sinceSeq` (exclusive of nothing — seq >= sinceSeq). */
  events(runId: string, sinceSeq = 0): OrchestratorEvent[] {
    const rows = this.db
      .prepare(
        'SELECT payload_json FROM run_events WHERE run_id = ? AND seq >= ? ORDER BY seq ASC',
      )
      .all(runId, sinceSeq) as { payload_json: string }[];
    return rows.map((e) => JSON.parse(e.payload_json) as OrchestratorEvent);
  }

  /** Number of persisted events for a run (the next seq to append at). */
  countEvents(runId: string): number {
    const row = this.db
      .prepare('SELECT events_count FROM runs WHERE id = ?')
      .get(runId) as RunScalarRow | undefined;
    return row?.events_count ?? 0;
  }

  /** Set the owning process for a run ('app' | 'daemon' | null) for handoff. */
  setOwner(runId: string, owner: string | null): void {
    this.db.prepare('UPDATE runs SET owner = ? WHERE id = ?').run(owner, runId);
  }
}
