/**
 * SQLite-backed {@link SessionStore}. A session groups serial runs into one
 * conversation; it stores only run-id references plus a rolling summary that
 * bridges context between runs (the heavy run state lives in the RunStore).
 */
import { isValidSession, type Session, type SessionStore } from '@omakase/core';
import type { Db } from './db/database.js';

interface SessionRow {
  id: string;
  title: string;
  run_ids_json: string;
  rolling_summary: string;
  created_at: number;
  updated_at: number;
}

function rowToSession(row: SessionRow): Session | null {
  let runIds: string[];
  try {
    const parsed = JSON.parse(row.run_ids_json) as unknown;
    runIds = Array.isArray(parsed) ? (parsed.filter((r) => typeof r === 'string') as string[]) : [];
  } catch {
    runIds = [];
  }
  const session: Session = {
    id: row.id,
    title: row.title,
    runIds,
    rollingSummary: row.rolling_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return isValidSession(session) ? session : null;
}

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async create(input: { id: string; title: string; now: number }): Promise<Session> {
    const session: Session = {
      id: input.id,
      title: input.title,
      runIds: [],
      rollingSummary: '',
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, run_ids_json, rolling_summary, created_at, updated_at)
         VALUES (?, ?, '[]', '', ?, ?)`,
      )
      .run(session.id, session.title, session.createdAt, session.updatedAt);
    return session;
  }

  async load(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  async list(): Promise<Session[]> {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
      .all() as SessionRow[];
    return rows.map(rowToSession).filter((s): s is Session => s !== null);
  }

  async appendRun(id: string, runId: string, now: number): Promise<void> {
    const session = await this.load(id);
    if (!session) return;
    if (!session.runIds.includes(runId)) session.runIds.push(runId);
    this.db
      .prepare('UPDATE sessions SET run_ids_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(session.runIds), now, id);
  }

  async updateSummary(id: string, summary: string, now: number): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET rolling_summary = ?, updated_at = ? WHERE id = ?')
      .run(summary, now, id);
  }

  async updateTitle(id: string, title: string, now: number): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, now, id);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
