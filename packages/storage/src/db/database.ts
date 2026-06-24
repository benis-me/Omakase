/**
 * better-sqlite3 connection helpers. Every Omakase database (a per-workspace
 * `omks.db` or the global registry) is opened the same way: WAL journaling so a
 * reader process (e.g. the desktop app tailing a run) can read while the owner
 * process (e.g. a detached daemon) writes, foreign keys on, and an ordered set
 * of idempotent migrations applied under `PRAGMA user_version`.
 */
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  /** Ordered migration SQL; index i is applied to move `user_version` i → i+1. */
  migrations: readonly string[];
  /** Open read-only (a non-owner tailing the DB). Skips journal/migration writes. */
  readonly?: boolean;
}

/**
 * Open (creating if needed) a SQLite database and bring its schema up to date.
 * Read-only opens skip all writes — they assume the owner has already migrated.
 */
export function openDatabase(file: string, options: OpenDatabaseOptions): Db {
  const readonly = options.readonly ?? false;
  const db = new Database(file, { readonly });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    runMigrations(db, options.migrations);
  }
  return db;
}

/**
 * Apply any migrations the database hasn't seen yet. Each migration runs in its
 * own transaction together with the `user_version` bump, so a failure rolls the
 * schema back to a consistent version rather than leaving it half-migrated.
 */
export function runMigrations(db: Db, migrations: readonly string[]): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  for (let version = current; version < migrations.length; version += 1) {
    const sql = migrations[version];
    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    });
    apply();
  }
}

/** Current schema version (number of applied migrations). */
export function schemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}
