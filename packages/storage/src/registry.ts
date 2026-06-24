/**
 * The global workspace registry — the app-level database (in the desktop app's
 * userData dir, or a path the CLI chooses) listing every known `.omks`
 * workspace, app settings, and a cache of detected "open with" apps. This is the
 * equivalent of DevDock's `~/.config/devdock/config.json`, but queryable.
 */
import { openDatabase, type Db } from './db/database.js';
import { REGISTRY_MIGRATIONS } from './db/migrations.js';

export interface WorkspaceEntry {
  path: string;
  id: string;
  name: string;
  pinned: boolean;
  sortOrder: number;
  lastOpened: number;
  addedAt: number;
  missing: boolean;
}

export interface AppEntry {
  id: string;
  name: string;
  path: string;
  kind: string;
  icon: string | null;
}

interface WorkspaceRow {
  path: string;
  id: string;
  name: string;
  pinned: number;
  sort_order: number;
  last_opened: number;
  added_at: number;
  missing: number;
}

const rowToEntry = (r: WorkspaceRow): WorkspaceEntry => ({
  path: r.path,
  id: r.id,
  name: r.name,
  pinned: r.pinned === 1,
  sortOrder: r.sort_order,
  lastOpened: r.last_opened,
  addedAt: r.added_at,
  missing: r.missing === 1,
});

export class Registry {
  constructor(private readonly db: Db) {}

  static open(file: string): Registry {
    return new Registry(openDatabase(file, { migrations: REGISTRY_MIGRATIONS }));
  }

  close(): void {
    this.db.close();
  }

  // ── Workspaces ──────────────────────────────────────────────────────────

  listWorkspaces(): WorkspaceEntry[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM workspaces ORDER BY pinned DESC, sort_order ASC, last_opened DESC',
      )
      .all() as WorkspaceRow[];
    return rows.map(rowToEntry);
  }

  getWorkspace(workspacePath: string): WorkspaceEntry | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(workspacePath) as
      | WorkspaceRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Register (or refresh) a workspace. New rows sort after existing ones. */
  addWorkspace(input: { path: string; id: string; name: string; now?: number }): WorkspaceEntry {
    const now = input.now ?? Date.now();
    const existing = this.getWorkspace(input.path);
    if (existing) {
      this.db
        .prepare('UPDATE workspaces SET id = ?, name = ?, missing = 0 WHERE path = ?')
        .run(input.id, input.name, input.path);
    } else {
      const nextOrder =
        (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM workspaces').get() as {
          n: number;
        }).n;
      this.db
        .prepare(
          `INSERT INTO workspaces (path, id, name, pinned, sort_order, last_opened, added_at, missing)
           VALUES (?, ?, ?, 0, ?, ?, ?, 0)`,
        )
        .run(input.path, input.id, input.name, nextOrder, now, now);
    }
    return this.getWorkspace(input.path)!;
  }

  removeWorkspace(workspacePath: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE path = ?').run(workspacePath);
  }

  setPinned(workspacePath: string, pinned: boolean): void {
    this.db
      .prepare('UPDATE workspaces SET pinned = ? WHERE path = ?')
      .run(pinned ? 1 : 0, workspacePath);
  }

  /** Reorder workspaces to match the given path order (index → sort_order). */
  reorder(paths: string[]): void {
    const update = this.db.prepare('UPDATE workspaces SET sort_order = ? WHERE path = ?');
    const tx = this.db.transaction((ordered: string[]) => {
      ordered.forEach((p, index) => update.run(index, p));
    });
    tx(paths);
  }

  /** Mark a workspace opened now (updates ordering tie-breaks). */
  touch(workspacePath: string, now?: number): void {
    this.db
      .prepare('UPDATE workspaces SET last_opened = ?, missing = 0 WHERE path = ?')
      .run(now ?? Date.now(), workspacePath);
  }

  setMissing(workspacePath: string, missing: boolean): void {
    this.db
      .prepare('UPDATE workspaces SET missing = ? WHERE path = ?')
      .run(missing ? 1 : 0, workspacePath);
  }

  // ── Settings ────────────────────────────────────────────────────────────

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }

  allSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as Array<{
      key: string;
      value_json: string;
    }>;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value_json);
      } catch {
        // skip corrupt setting
      }
    }
    return out;
  }

  // ── "Open with" apps cache ──────────────────────────────────────────────

  setAppsCache(apps: AppEntry[], now?: number): void {
    const at = now ?? Date.now();
    const tx = this.db.transaction((items: AppEntry[]) => {
      this.db.prepare('DELETE FROM apps_cache').run();
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO apps_cache (id, name, path, kind, icon, cached_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const app of items) insert.run(app.id, app.name, app.path, app.kind, app.icon, at);
    });
    tx(apps);
  }

  getAppsCache(): AppEntry[] {
    const rows = this.db
      .prepare('SELECT id, name, path, kind, icon FROM apps_cache ORDER BY name ASC')
      .all() as Array<{ id: string; name: string; path: string; kind: string; icon: string | null }>;
    return rows.map((r) => ({ id: r.id, name: r.name, path: r.path, kind: r.kind, icon: r.icon }));
  }
}
