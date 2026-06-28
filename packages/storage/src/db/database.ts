/**
 * SQLite connection helpers built on Node's built-in `node:sqlite` (DatabaseSync) —
 * NOT a native module, so there's no node-vs-Electron ABI to rebuild. Available
 * unflagged in Electron's Node 24; on Node 22 (CLI/tests) it needs
 * `--experimental-sqlite` (wired into the bin + vitest).
 *
 * Every Omakase database (a per-workspace `omks.db` or the global registry) opens the
 * same way: WAL journaling so a reader (the desktop app tailing a run) can read while
 * the owner writes, foreign keys on, and ordered idempotent migrations under
 * `PRAGMA user_version`.
 *
 * `Db` is a thin shim presenting the small slice of the better-sqlite3 API the stores
 * use (prepare → run/get/all, exec, pragma, transaction) so the rest of the package is
 * unchanged. node:sqlite already matches `@name`-bound params, positional `get(?)`,
 * `all()`, and `run()`'s `{ changes, lastInsertRowid }`; only pragma + transaction are
 * shimmed.
 */
import { DatabaseSync } from 'node:sqlite';

/** The slice of the better-sqlite3 Statement API the stores use. Returns are `any` so
 *  the existing `.all() as Row[]` / `.get() as Row` casts keep working unchanged. */
export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(...params: unknown[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all(...params: unknown[]): any[];
}

/** A transaction function with better-sqlite3's begin-mode variants. */
export interface TransactionFn<A extends unknown[], R> {
  (...args: A): R;
  deferred(...args: A): R;
  immediate(...args: A): R;
  exclusive(...args: A): R;
}

export interface OpenDatabaseOptions {
  /** Ordered migration SQL; index i is applied to move `user_version` i → i+1. */
  migrations: readonly string[];
  /** Open read-only (a non-owner tailing the DB). Skips journal/migration writes. */
  readonly?: boolean;
}

export class Db {
  private readonly db: DatabaseSync;

  constructor(file: string, opts: { readonly?: boolean } = {}) {
    this.db = new DatabaseSync(file, { readOnly: opts.readonly ?? false });
  }

  prepare(sql: string): Statement {
    return this.db.prepare(sql) as unknown as Statement;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** better-sqlite3-style pragma: `pragma('x = y')` to set, `pragma('x', {simple:true})`
   *  to read the scalar value. */
  pragma(statement: string, opts?: { simple?: boolean }): unknown {
    if (opts?.simple) {
      const name = statement.trim().split(/[\s=]/)[0]!;
      const row = this.db.prepare(`PRAGMA ${statement}`).get() as Record<string, unknown> | undefined;
      return row ? row[name] : undefined;
    }
    this.db.exec(`PRAGMA ${statement}`);
    return undefined;
  }

  /** Wrap `fn` so calling the returned function runs it inside a transaction
   *  (BEGIN/COMMIT, ROLLBACK on throw) — mirrors better-sqlite3's `db.transaction`,
   *  including the `.deferred`/`.immediate`/`.exclusive` begin-mode variants. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TransactionFn<A, R> {
    const run =
      (begin: string) =>
      (...args: A): R => {
        this.db.exec(begin);
        try {
          const result = fn(...args);
          this.db.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            /* the BEGIN may not have opened; nothing to roll back */
          }
          throw err;
        }
      };
    const main = run('BEGIN') as TransactionFn<A, R>;
    main.deferred = run('BEGIN DEFERRED');
    main.immediate = run('BEGIN IMMEDIATE');
    main.exclusive = run('BEGIN EXCLUSIVE');
    return main;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (creating if needed) a SQLite database and bring its schema up to date.
 * Read-only opens skip all writes — they assume the owner has already migrated.
 */
export function openDatabase(file: string, options: OpenDatabaseOptions): Db {
  const readonly = options.readonly ?? false;
  const db = new Db(file, { readonly });
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
    const sql = migrations[version]!;
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
