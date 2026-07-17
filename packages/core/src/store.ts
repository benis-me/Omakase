// Event-sourced SQLite persistence for Omakase, backed by bun:sqlite.
//
// The store is the durable record of every run: its metadata (runs), its
// append-only event log (run_events), its task DAG (tasks), reports, sessions
// and a small wiki + kv. Resume is implemented by replaying run_events.

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  RunRecord,
  RunId,
  RunStatus,
  RunEvent,
  AnyRunEvent,
  RunEventType,
  RunEventPayloadMap,
  TaskRecord,
  TaskId,
  TaskStatus,
  Report,
  SessionRecord,
  SessionId,
  WikiEntry,
} from './types.ts';

/** Values SQLite can bind. */
type Bind = string | number | bigint | boolean | null | Uint8Array;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  mode TEXT NOT NULL,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL,
  goal_json TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  spent_agents INTEGER NOT NULL DEFAULT 0,
  budget_agents INTEGER,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  spent_cost_usd REAL NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  checkpoint_seq INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  rate_limited_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_updated ON runs(updated_at DESC);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS tasks (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS reports (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  task_id TEXT,
  author_agent_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_reports_run ON reports(run_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  run_ids_json TEXT NOT NULL DEFAULT '[]',
  rolling_summary TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wiki_entries (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface RunRow {
  id: string;
  session_id: string | null;
  mode: string;
  workflow: string;
  status: string;
  goal_json: string;
  title: string;
  summary: string | null;
  spent_agents: number;
  budget_agents: number | null;
  spent_tokens: number;
  spent_cost_usd: number;
  last_seq: number;
  checkpoint_seq: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  heartbeat_at: number;
  rate_limited_until: number | null;
}

interface SessionRow {
  id: string;
  title: string;
  run_ids_json: string;
  rolling_summary: string;
  cwd: string;
  created_at: number;
  updated_at: number;
}

function rowToRun(r: RunRow): RunRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    mode: r.mode as RunRecord['mode'],
    workflow: r.workflow,
    status: r.status as RunStatus,
    goal: JSON.parse(r.goal_json),
    title: r.title,
    summary: r.summary,
    spentAgents: r.spent_agents,
    budgetAgents: r.budget_agents,
    spentTokens: r.spent_tokens,
    spentCostUsd: r.spent_cost_usd,
    lastSeq: r.last_seq,
    checkpointSeq: r.checkpoint_seq,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    heartbeatAt: r.heartbeat_at,
    rateLimitedUntil: r.rate_limited_until,
  };
}

export interface ListRunsQuery {
  status?: RunStatus;
  sessionId?: SessionId;
  limit?: number;
}

export class Store {
  readonly db: Database;
  private readonly appendTx: (args: {
    runId: string;
    type: string;
    payloadJson: string;
    now: number;
  }) => number;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = OFF;');
    this.db.exec(SCHEMA);
    this.appendTx = this.db.transaction((args: {
      runId: string;
      type: string;
      payloadJson: string;
      now: number;
    }) => {
      const row = this.db
        .query('SELECT last_seq FROM runs WHERE id = $id')
        .get({ $id: args.runId }) as { last_seq: number } | null;
      const seq = (row?.last_seq ?? 0) + 1;
      this.db
        .query(
          `INSERT INTO run_events (run_id, seq, type, payload_json, created_at)
           VALUES ($run_id,$seq,$type,$payload,$created_at)`,
        )
        .run({
          $run_id: args.runId,
          $seq: seq,
          $type: args.type,
          $payload: args.payloadJson,
          $created_at: args.now,
        });
      if (row) {
        this.db
          .query('UPDATE runs SET last_seq = $seq, heartbeat_at = $now, updated_at = $now WHERE id = $id')
          .run({ $id: args.runId, $seq: seq, $now: args.now });
      }
      return seq;
    });
  }

  close(): void {
    this.db.close();
  }

  // --- Runs ---------------------------------------------------------------

  createRun(run: RunRecord): RunRecord {
    this.db
      .query(
        `INSERT INTO runs (id, session_id, mode, workflow, status, goal_json, title, summary,
           spent_agents, budget_agents, spent_tokens, spent_cost_usd, last_seq, checkpoint_seq,
           error, created_at, updated_at, heartbeat_at, rate_limited_until)
         VALUES ($id,$session_id,$mode,$workflow,$status,$goal_json,$title,$summary,
           $spent_agents,$budget_agents,$spent_tokens,$spent_cost_usd,$last_seq,$checkpoint_seq,
           $error,$created_at,$updated_at,$heartbeat_at,$rate_limited_until)`,
      )
      .run({
        $id: run.id,
        $session_id: run.sessionId,
        $mode: run.mode,
        $workflow: run.workflow,
        $status: run.status,
        $goal_json: JSON.stringify(run.goal),
        $title: run.title,
        $summary: run.summary,
        $spent_agents: run.spentAgents,
        $budget_agents: run.budgetAgents,
        $spent_tokens: run.spentTokens,
        $spent_cost_usd: run.spentCostUsd,
        $last_seq: run.lastSeq,
        $checkpoint_seq: run.checkpointSeq,
        $error: run.error,
        $created_at: run.createdAt,
        $updated_at: run.updatedAt,
        $heartbeat_at: run.heartbeatAt,
        $rate_limited_until: run.rateLimitedUntil,
      });
    return run;
  }

  getRun(id: RunId): RunRecord | null {
    const row = this.db.query('SELECT * FROM runs WHERE id = $id').get({ $id: id }) as RunRow | null;
    return row ? rowToRun(row) : null;
  }

  listRuns(q: ListRunsQuery = {}): RunRecord[] {
    const clauses: string[] = [];
    const params: Record<string, Bind> = {};
    if (q.status) {
      clauses.push('status = $status');
      params.$status = q.status;
    }
    if (q.sessionId) {
      clauses.push('session_id = $session_id');
      params.$session_id = q.sessionId;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = q.limit ? `LIMIT ${Math.max(1, Math.floor(q.limit))}` : '';
    const rows = this.db
      .query(`SELECT * FROM runs ${where} ORDER BY updated_at DESC ${limit}`)
      .all(params) as RunRow[];
    return rows.map(rowToRun);
  }

  /** Partial update of run metadata; also bumps updated_at. */
  updateRun(id: RunId, patch: Partial<Omit<RunRecord, 'id'>>): void {
    const map: Record<string, string> = {
      sessionId: 'session_id',
      status: 'status',
      summary: 'summary',
      title: 'title',
      spentAgents: 'spent_agents',
      budgetAgents: 'budget_agents',
      spentTokens: 'spent_tokens',
      spentCostUsd: 'spent_cost_usd',
      checkpointSeq: 'checkpoint_seq',
      error: 'error',
      heartbeatAt: 'heartbeat_at',
      rateLimitedUntil: 'rate_limited_until',
    };
    const sets: string[] = ['updated_at = $updated_at'];
    const params: Record<string, Bind> = { $id: id, $updated_at: Date.now() };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        const v = (patch as Record<string, unknown>)[k];
        sets.push(`${col} = $${col}`);
        params[`$${col}`] = v as Bind;
      }
    }
    if ('goal' in patch) {
      sets.push('goal_json = $goal_json');
      params.$goal_json = JSON.stringify(patch.goal);
    }
    this.db.query(`UPDATE runs SET ${sets.join(', ')} WHERE id = $id`).run(params);
  }

  /** Add to spend counters atomically. */
  addSpend(id: RunId, delta: { agents?: number; tokens?: number; costUsd?: number }): void {
    this.db
      .query(
        `UPDATE runs SET spent_agents = spent_agents + $a,
            spent_tokens = spent_tokens + $t, spent_cost_usd = spent_cost_usd + $c,
            updated_at = $now WHERE id = $id`,
      )
      .run({
        $id: id,
        $a: delta.agents ?? 0,
        $t: delta.tokens ?? 0,
        $c: delta.costUsd ?? 0,
        $now: Date.now(),
      });
  }

  /** Mark still-"running"/"pending" runs as failed on boot (crash recovery). */
  markInterruptedRuns(reason = 'process exited'): RunId[] {
    const rows = this.db
      .query(`SELECT id FROM runs WHERE status IN ('running','pending','paused')`)
      .all() as { id: string }[];
    for (const { id } of rows) {
      this.updateRun(id, { status: 'failed', error: reason });
    }
    return rows.map((r) => r.id);
  }

  // --- Events (event log) -------------------------------------------------

  appendEvent<T extends RunEventType>(
    runId: RunId,
    type: T,
    payload: RunEventPayloadMap[T],
  ): RunEvent<T> {
    const now = Date.now();
    const seq = this.appendTx({ runId, type, payloadJson: JSON.stringify(payload), now });
    return { runId, seq, type, payload, createdAt: now };
  }

  getEvents(runId: RunId, afterSeq = 0, types?: readonly RunEventType[]): AnyRunEvent[] {
    // A caller that only reads a few event types (resume) shouldn't fetch and
    // JSON.parse the whole log — a run is mostly agent:activity. Filter in SQL;
    // the (run_id, seq) PK still drives the scan. Bind each type, never
    // interpolate, and treat an empty list as "no rows" rather than a syntax error.
    const params: Record<string, Bind> = { $id: runId, $after: afterSeq };
    let typeClause = '';
    if (types) {
      if (types.length === 0) return [];
      const names = types.map((t, i) => {
        params[`$t${i}`] = t;
        return `$t${i}`;
      });
      typeClause = ` AND type IN (${names.join(', ')})`;
    }
    const rows = this.db
      .query(
        `SELECT run_id, seq, type, payload_json, created_at FROM run_events
         WHERE run_id = $id AND seq > $after${typeClause} ORDER BY seq ASC`,
      )
      .all(params) as {
      run_id: string;
      seq: number;
      type: string;
      payload_json: string;
      created_at: number;
    }[];
    return rows.map(
      (r) =>
        ({
          runId: r.run_id,
          seq: r.seq,
          type: r.type as RunEventType,
          payload: JSON.parse(r.payload_json),
          createdAt: r.created_at,
        }) as AnyRunEvent,
    );
  }

  // --- Tasks --------------------------------------------------------------

  upsertTask(task: TaskRecord): void {
    this.db
      .query(
        `INSERT INTO tasks (run_id, id, title, role, status, attempts, depends_on_json, created_at, updated_at)
         VALUES ($run_id,$id,$title,$role,$status,$attempts,$depends_on,$created_at,$updated_at)
         ON CONFLICT(run_id, id) DO UPDATE SET
           title=$title, role=$role, status=$status, attempts=$attempts,
           depends_on_json=$depends_on, updated_at=$updated_at`,
      )
      .run({
        $run_id: task.runId,
        $id: task.id,
        $title: task.title,
        $role: task.role,
        $status: task.status,
        $attempts: task.attempts,
        $depends_on: JSON.stringify(task.dependsOn),
        $created_at: task.createdAt,
        $updated_at: task.updatedAt,
      });
  }

  updateTaskStatus(runId: RunId, id: TaskId, status: TaskStatus, attempts?: number): void {
    const sets = ['status = $status', 'updated_at = $now'];
    const params: Record<string, Bind> = {
      $run_id: runId,
      $id: id,
      $status: status,
      $now: Date.now(),
    };
    if (attempts !== undefined) {
      sets.push('attempts = $attempts');
      params.$attempts = attempts;
    }
    this.db
      .query(`UPDATE tasks SET ${sets.join(', ')} WHERE run_id = $run_id AND id = $id`)
      .run(params);
  }

  listTasks(runId: RunId): TaskRecord[] {
    const rows = this.db
      .query('SELECT * FROM tasks WHERE run_id = $id ORDER BY created_at ASC')
      .all({ $id: runId }) as {
      run_id: string;
      id: string;
      title: string;
      role: string;
      status: string;
      attempts: number;
      depends_on_json: string;
      created_at: number;
      updated_at: number;
    }[];
    return rows.map((r) => ({
      runId: r.run_id,
      id: r.id,
      title: r.title,
      role: r.role,
      status: r.status as TaskStatus,
      attempts: r.attempts,
      dependsOn: JSON.parse(r.depends_on_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // --- Reports ------------------------------------------------------------

  addReport(report: Report): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO reports (run_id, id, kind, title, summary, task_id, author_agent_id, created_at)
         VALUES ($run_id,$id,$kind,$title,$summary,$task_id,$author,$created_at)`,
      )
      .run({
        $run_id: report.runId,
        $id: report.id,
        $kind: report.kind,
        $title: report.title,
        $summary: report.summary,
        $task_id: report.taskId,
        $author: report.authorAgentId,
        $created_at: report.createdAt,
      });
  }

  listReports(runId: RunId): Report[] {
    const rows = this.db
      .query('SELECT * FROM reports WHERE run_id = $id ORDER BY created_at ASC')
      .all({ $id: runId }) as {
      run_id: string;
      id: string;
      kind: string;
      title: string;
      summary: string;
      task_id: string | null;
      author_agent_id: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      runId: r.run_id,
      id: r.id,
      kind: r.kind as Report['kind'],
      title: r.title,
      summary: r.summary,
      taskId: r.task_id,
      authorAgentId: r.author_agent_id,
      createdAt: r.created_at,
    }));
  }

  // --- Sessions -----------------------------------------------------------

  createSession(s: SessionRecord): SessionRecord {
    this.db
      .query(
        `INSERT INTO sessions (id, title, run_ids_json, rolling_summary, cwd, created_at, updated_at)
         VALUES ($id,$title,$runs,$summary,$cwd,$created_at,$updated_at)`,
      )
      .run({
        $id: s.id,
        $title: s.title,
        $runs: JSON.stringify(s.runIds),
        $summary: s.rollingSummary,
        $cwd: s.cwd,
        $created_at: s.createdAt,
        $updated_at: s.updatedAt,
      });
    return s;
  }

  private toSession(r: SessionRow): SessionRecord {
    return {
      id: r.id,
      title: r.title,
      runIds: JSON.parse(r.run_ids_json),
      rollingSummary: r.rolling_summary,
      cwd: r.cwd,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  getSession(id: SessionId): SessionRecord | null {
    const r = this.db.query('SELECT * FROM sessions WHERE id = $id').get({ $id: id }) as SessionRow | null;
    return r ? this.toSession(r) : null;
  }

  updateSession(id: SessionId, patch: Partial<Pick<SessionRecord, 'title' | 'runIds' | 'rollingSummary'>>): void {
    const sets: string[] = ['updated_at = $now'];
    const params: Record<string, Bind> = { $id: id, $now: Date.now() };
    if (patch.title !== undefined) {
      sets.push('title = $title');
      params.$title = patch.title;
    }
    if (patch.runIds !== undefined) {
      sets.push('run_ids_json = $runs');
      params.$runs = JSON.stringify(patch.runIds);
    }
    if (patch.rollingSummary !== undefined) {
      sets.push('rolling_summary = $summary');
      params.$summary = patch.rollingSummary;
    }
    this.db.query(`UPDATE sessions SET ${sets.join(', ')} WHERE id = $id`).run(params);
  }

  listSessions(limit = 50): SessionRecord[] {
    // One SELECT, not a SELECT-id then getSession per row: the sidebar reads the
    // whole list on every render.
    const rows = this.db
      .query('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT $limit')
      .all({ $limit: limit }) as SessionRow[];
    return rows.map((r) => this.toSession(r));
  }

  // --- Wiki ---------------------------------------------------------------

  upsertWiki(entry: WikiEntry): void {
    this.db
      .query(
        `INSERT INTO wiki_entries (slug, title, body, updated_at)
         VALUES ($slug,$title,$body,$updated_at)
         ON CONFLICT(slug) DO UPDATE SET title=$title, body=$body, updated_at=$updated_at`,
      )
      .run({ $slug: entry.slug, $title: entry.title, $body: entry.body, $updated_at: entry.updatedAt });
  }

  getWiki(slug: string): WikiEntry | null {
    const r = this.db.query('SELECT * FROM wiki_entries WHERE slug = $slug').get({ $slug: slug }) as
      | { slug: string; title: string; body: string; updated_at: number }
      | null;
    return r ? { slug: r.slug, title: r.title, body: r.body, updatedAt: r.updated_at } : null;
  }

  listWiki(): WikiEntry[] {
    const rows = this.db.query('SELECT * FROM wiki_entries ORDER BY updated_at DESC').all() as {
      slug: string;
      title: string;
      body: string;
      updated_at: number;
    }[];
    return rows.map((r) => ({ slug: r.slug, title: r.title, body: r.body, updatedAt: r.updated_at }));
  }

  // --- KV -----------------------------------------------------------------

  kvSet(key: string, value: unknown): void {
    this.db
      .query(
        `INSERT INTO kv (key, value_json, updated_at) VALUES ($k,$v,$now)
         ON CONFLICT(key) DO UPDATE SET value_json=$v, updated_at=$now`,
      )
      .run({ $k: key, $v: JSON.stringify(value), $now: Date.now() });
  }

  kvGet<T = unknown>(key: string): T | null {
    const r = this.db.query('SELECT value_json FROM kv WHERE key = $k').get({ $k: key }) as
      | { value_json: string }
      | null;
    return r ? (JSON.parse(r.value_json) as T) : null;
  }
}
