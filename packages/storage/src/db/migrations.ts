/**
 * Ordered, append-only schema migrations. NEVER edit or reorder an existing
 * entry once it has shipped — only append. The array index is the schema
 * version: `WORKSPACE_MIGRATIONS[0]` moves a fresh DB from version 0 → 1.
 *
 * Source-of-truth split (see the design spec):
 *   - `runs.record_json` + `run_events` reconstruct an exact `RunRecord`.
 *   - The remaining tables are denormalized read models / cross-run knowledge,
 *     rebuilt from the record on each save; they exist for queries, not resume.
 */

/** Per-workspace `omks.db` schema. */
export const WORKSPACE_MIGRATIONS: readonly string[] = [
  // v1 — runs, events, sessions, projections, cross-run knowledge.
  /* sql */ `
    CREATE TABLE runs (
      id               TEXT PRIMARY KEY,
      mode             TEXT NOT NULL,
      status           TEXT NOT NULL,
      summary          TEXT NOT NULL DEFAULT '',
      owner            TEXT,
      spent_tokens     INTEGER,
      spent_cost_usd   REAL,
      checkpoint_seq   INTEGER NOT NULL DEFAULT 0,
      last_control_seq INTEGER,
      events_count     INTEGER NOT NULL DEFAULT 0,
      record_json      TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      heartbeat_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_runs_status ON runs(status);
    CREATE INDEX idx_runs_updated ON runs(updated_at DESC);

    CREATE TABLE run_events (
      run_id       TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      type         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE INDEX idx_run_events_type ON run_events(type);

    CREATE TABLE sessions (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      run_ids_json    TEXT NOT NULL DEFAULT '[]',
      rolling_summary TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

    -- Read-model projections (rebuilt per run on save).
    CREATE TABLE tasks (
      run_id          TEXT NOT NULL,
      id              TEXT NOT NULL,
      title           TEXT NOT NULL DEFAULT '',
      role            TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT '',
      attempts        INTEGER NOT NULL DEFAULT 0,
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, id)
    );
    CREATE INDEX idx_tasks_status ON tasks(status);

    CREATE TABLE reports (
      run_id          TEXT NOT NULL,
      id              TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT '',
      title           TEXT NOT NULL DEFAULT '',
      summary         TEXT NOT NULL DEFAULT '',
      task_id         TEXT,
      author_agent_id TEXT,
      created_at      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, id)
    );
    CREATE INDEX idx_reports_kind ON reports(kind);
    CREATE INDEX idx_reports_created ON reports(created_at DESC);

    CREATE TABLE run_knowledge_events (
      run_id          TEXT NOT NULL,
      id              TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT '',
      title           TEXT NOT NULL DEFAULT '',
      body            TEXT NOT NULL DEFAULT '',
      task_id         TEXT,
      author_agent_id TEXT,
      created_at      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, id)
    );

    -- Cross-run knowledge (the KnowledgeStore: wiki + knowledge log + pages + codegraph).
    CREATE TABLE wiki_entries (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL DEFAULT 'note',
      title      TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      tags_json  TEXT NOT NULL DEFAULT '[]',
      source     TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE knowledge_log (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL DEFAULT '',
      kind            TEXT NOT NULL DEFAULT '',
      title           TEXT NOT NULL DEFAULT '',
      body            TEXT NOT NULL DEFAULT '',
      task_id         TEXT,
      criterion_id    TEXT,
      report_id       TEXT,
      author_agent_id TEXT,
      created_at      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_knowledge_log_created ON knowledge_log(created_at DESC);

    CREATE TABLE wiki_pages (
      id        TEXT PRIMARY KEY,
      page_json TEXT NOT NULL
    );

    -- Single-value blobs (codegraph snapshot, misc).
    CREATE TABLE kv (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `,
];

/** Global registry DB schema (lives in the app's userData dir). */
export const REGISTRY_MIGRATIONS: readonly string[] = [
  // v1 — known workspaces + app settings + detected "open with" apps cache.
  /* sql */ `
    CREATE TABLE workspaces (
      path        TEXT PRIMARY KEY,
      id          TEXT NOT NULL,
      name        TEXT NOT NULL,
      pinned      INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      last_opened INTEGER NOT NULL DEFAULT 0,
      added_at    INTEGER NOT NULL DEFAULT 0,
      missing     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_workspaces_order ON workspaces(sort_order);

    CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE apps_cache (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'editor',
      icon       TEXT,
      cached_at  INTEGER NOT NULL DEFAULT 0
    );
  `,
];
