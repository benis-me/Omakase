/**
 * SQLite-backed {@link KnowledgeStore} — the cross-run memory the orchestrator
 * seeds at run start and saves back at each checkpoint: the curated wiki, the
 * agent knowledge log, derived wiki pages, and the codegraph snapshot.
 *
 * SQLite is the source of truth. When a `renderDir` is given (conventionally
 * `<workspace>/.omks/memory`), the store also writes git-friendly markdown
 * projections (`wiki.md`, `knowledge-events.md`, `wiki-pages.md`) so the
 * accumulated knowledge is diffable and reviewable, mirroring the file store.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildWikiPages,
  ProjectWiki,
  renderKnowledgeEventsMarkdown,
  renderWikiPagesMarkdown,
  type CodeGraphSnapshot,
  type KnowledgeEvent,
  type KnowledgeStore,
  type WikiEntry,
  type WikiPage,
  type WikiSnapshot,
} from '@omakase/core';
import type { Db } from './db/database.js';

export interface SqliteKnowledgeStoreOptions {
  /** Directory to render markdown projections into (e.g. `<ws>/.omks/memory`). */
  renderDir?: string;
}

interface WikiEntryRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  tags_json: string;
  source: string | null;
  created_at: number;
  updated_at: number;
}

export class SqliteKnowledgeStore implements KnowledgeStore {
  private readonly renderDir?: string;

  constructor(
    private readonly db: Db,
    options: SqliteKnowledgeStoreOptions = {},
  ) {
    this.renderDir = options.renderDir;
  }

  // ── Wiki ──────────────────────────────────────────────────────────────────

  async loadWiki(): Promise<WikiSnapshot | null> {
    // rowid order preserves the saved array order (an explicit, index-independent
    // tiebreak), so the snapshot round-trips exactly like the file store.
    const rows = this.db
      .prepare('SELECT * FROM wiki_entries ORDER BY rowid ASC')
      .all() as WikiEntryRow[];
    if (rows.length === 0) {
      // Distinguish "never saved" (null) from "saved empty" via a marker key.
      const marker = this.db
        .prepare("SELECT value_json FROM kv WHERE key = 'wiki:initialized'")
        .get() as { value_json: string } | undefined;
      if (!marker) return null;
    }
    return { entries: rows.map(rowToWikiEntry) };
  }

  async saveWiki(snapshot: WikiSnapshot): Promise<void> {
    const write = this.db.transaction((entries: WikiEntry[]) => {
      this.db.prepare('DELETE FROM wiki_entries').run();
      this.replaceEntries(entries);
      this.db
        .prepare("INSERT OR REPLACE INTO kv (key, value_json) VALUES ('wiki:initialized', 'true')")
        .run();
    });
    write(snapshot.entries);
    await this.renderWiki(snapshot);
    await this.refreshWikiPages();
  }

  async mergeWiki(entries: WikiEntry[]): Promise<void> {
    // IMMEDIATE so concurrent mergers (e.g. app + daemon) serialize their
    // read-merge-write instead of racing and dropping each other's entries.
    const merge = this.db.transaction((incoming: WikiEntry[]) => {
      const existing = this.db
        .prepare('SELECT * FROM wiki_entries')
        .all() as WikiEntryRow[];
      const byId = new Map<string, WikiEntry>(existing.map((r) => [r.id, rowToWikiEntry(r)]));
      for (const entry of incoming) byId.set(entry.id, entry);
      this.db.prepare('DELETE FROM wiki_entries').run();
      this.replaceEntries([...byId.values()]);
      this.db
        .prepare("INSERT OR REPLACE INTO kv (key, value_json) VALUES ('wiki:initialized', 'true')")
        .run();
    });
    merge.immediate(entries);
    const snapshot = await this.loadWiki();
    if (snapshot) {
      await this.renderWiki(snapshot);
      await this.refreshWikiPages();
    }
  }

  private replaceEntries(entries: WikiEntry[]): void {
    const insert = this.db.prepare(
      `INSERT INTO wiki_entries (id, kind, title, body, tags_json, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      insert.run(
        e.id,
        e.kind,
        e.title,
        e.body,
        JSON.stringify(e.tags ?? []),
        e.source ?? null,
        e.createdAt,
        e.updatedAt,
      );
    }
  }

  // ── Knowledge log ───────────────────────────────────────────────────────────

  async loadKnowledgeEvents(): Promise<KnowledgeEvent[]> {
    const rows = this.db
      .prepare('SELECT * FROM knowledge_log ORDER BY rowid ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToKnowledgeEvent);
  }

  async saveKnowledgeEvents(events: KnowledgeEvent[]): Promise<void> {
    const write = this.db.transaction((items: KnowledgeEvent[]) => {
      this.db.prepare('DELETE FROM knowledge_log').run();
      const insert = this.db.prepare(
        `INSERT INTO knowledge_log
           (id, run_id, kind, title, body, task_id, criterion_id, report_id, author_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of items) {
        insert.run(
          e.id,
          e.runId,
          e.kind,
          e.title,
          e.body,
          e.taskId ?? null,
          e.criterionId ?? null,
          e.reportId ?? null,
          e.authorAgentId ?? null,
          e.createdAt,
        );
      }
    });
    write(events);
    if (this.renderDir) {
      await this.renderText('knowledge-events.md', renderKnowledgeEventsMarkdown(events));
    }
    await this.refreshWikiPages();
  }

  // ── Wiki pages (derived) ────────────────────────────────────────────────────

  async loadWikiPages(): Promise<WikiPage[]> {
    const rows = this.db.prepare('SELECT page_json FROM wiki_pages').all() as {
      page_json: string;
    }[];
    return rows.map((r) => JSON.parse(r.page_json) as WikiPage);
  }

  async saveWikiPages(pages: WikiPage[]): Promise<void> {
    const write = this.db.transaction((items: WikiPage[]) => {
      this.db.prepare('DELETE FROM wiki_pages').run();
      const insert = this.db.prepare('INSERT INTO wiki_pages (id, page_json) VALUES (?, ?)');
      for (const p of items) insert.run(p.id, JSON.stringify(p));
    });
    write(pages);
    if (this.renderDir) {
      await this.renderText('wiki-pages.md', renderWikiPagesMarkdown(pages));
    }
  }

  private async refreshWikiPages(): Promise<void> {
    const events = await this.loadKnowledgeEvents();
    const wiki = await this.loadWiki();
    const codegraph = await this.loadCodegraph();
    await this.saveWikiPages(buildWikiPages(events, wiki, codegraph));
  }

  // ── Codegraph ─────────────────────────────────────────────────────────────

  async loadCodegraph(): Promise<CodeGraphSnapshot | null> {
    const row = this.db
      .prepare("SELECT value_json FROM kv WHERE key = 'codegraph'")
      .get() as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as CodeGraphSnapshot;
    } catch {
      return null;
    }
  }

  async saveCodegraph(snapshot: CodeGraphSnapshot): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO kv (key, value_json) VALUES ('codegraph', ?)")
      .run(JSON.stringify(snapshot));
    await this.refreshWikiPages();
  }

  // ── Markdown projections ────────────────────────────────────────────────────

  private async renderWiki(snapshot: WikiSnapshot): Promise<void> {
    if (!this.renderDir) return;
    await this.renderText('wiki.md', `${ProjectWiki.fromJSON(snapshot).toMarkdown()}\n`);
  }

  private async renderText(file: string, value: string): Promise<void> {
    if (!this.renderDir) return;
    await mkdir(this.renderDir, { recursive: true });
    await writeFile(path.join(this.renderDir, file), value, 'utf8');
  }
}

function rowToWikiEntry(row: WikiEntryRow): WikiEntry {
  let tags: string[];
  try {
    const parsed = JSON.parse(row.tags_json) as unknown;
    tags = Array.isArray(parsed) ? (parsed.filter((t) => typeof t === 'string') as string[]) : [];
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    kind: row.kind as WikiEntry['kind'],
    title: row.title,
    body: row.body,
    tags,
    source: row.source ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToKnowledgeEvent(row: Record<string, unknown>): KnowledgeEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    kind: row.kind as KnowledgeEvent['kind'],
    title: String(row.title),
    body: String(row.body),
    taskId: row.task_id == null ? undefined : String(row.task_id),
    criterionId: row.criterion_id == null ? undefined : String(row.criterion_id),
    reportId: row.report_id == null ? undefined : String(row.report_id),
    authorAgentId: row.author_agent_id == null ? undefined : String(row.author_agent_id),
    createdAt: Number(row.created_at),
  };
}
