/**
 * Cross-run knowledge persistence. The orchestrator seeds its {@link ProjectWiki}
 * (and optionally its {@link CodeGraph}) from a {@link KnowledgeStore} at run
 * start and saves back at each checkpoint, so facts/decisions/risks/task records
 * accumulate across runs instead of starting empty every time.
 *
 * {@link FileKnowledgeStore} writes `wiki.json` / `codegraph.json` under a
 * directory (conventionally `<project>/.omakase`), atomically.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CodeGraphSnapshot } from './codegraph.js';
import { ProjectWiki, type WikiEntry, type WikiSnapshot } from './wiki.js';
import { renderKnowledgeEventsMarkdown, type KnowledgeEvent } from './events.js';
import { buildWikiPages, renderWikiPagesMarkdown, type WikiPage } from './pages.js';

export interface KnowledgeStore {
  loadWiki(): Promise<WikiSnapshot | null>;
  saveWiki(snapshot: WikiSnapshot): Promise<void>;
  /**
   * Atomically union `entries` into the persisted wiki (incoming entries win
   * on id collision) under a writer lock, so concurrent runs that both checkpoint
   * can't clobber each other's contributions via load-merge-save races. Optional:
   * stores that don't implement it fall back to caller-side load+merge+save.
   */
  mergeWiki?(entries: WikiEntry[]): Promise<void>;
  loadKnowledgeEvents(): Promise<KnowledgeEvent[]>;
  saveKnowledgeEvents(events: KnowledgeEvent[]): Promise<void>;
  loadWikiPages(): Promise<WikiPage[]>;
  saveWikiPages(pages: WikiPage[]): Promise<void>;
  loadCodegraph(): Promise<CodeGraphSnapshot | null>;
  saveCodegraph(snapshot: CodeGraphSnapshot): Promise<void>;
}

/**
 * Per-directory write locks. Concurrent {@link FileKnowledgeStore} instances
 * (e.g. several orchestrators under one Supervisor) pointed at the same
 * `.omakase` dir serialize their read-merge-write cycles through one chain,
 * so an interleaving can't drop entries. Keyed by resolved dir; bounded by the
 * number of distinct project dirs touched in-process.
 */
const wikiWriteLocks = new Map<string, Promise<unknown>>();

function isWikiSnapshot(value: unknown): value is WikiSnapshot {
  return Boolean(value) && Array.isArray((value as WikiSnapshot).entries);
}

function isCodegraphSnapshot(value: unknown): value is CodeGraphSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snap = value as CodeGraphSnapshot;
  if (typeof snap.root !== 'string' || !Array.isArray(snap.nodes)) return false;
  // Validate node element shape too, so a well-formed-JSON-but-wrong-shape file
  // (e.g. from an external codegraph producer) can't pass and then crash
  // dependencies()/cycles()/stats() on undefined arrays at query time.
  return snap.nodes.every(
    (n) =>
      Boolean(n) &&
      typeof (n as { path?: unknown }).path === 'string' &&
      Array.isArray((n as { imports?: unknown }).imports) &&
      Array.isArray((n as { exports?: unknown }).exports) &&
      Array.isArray((n as { symbols?: unknown }).symbols),
  );
}

function isKnowledgeEventArray(value: unknown): value is KnowledgeEvent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (event) =>
        Boolean(event) &&
        typeof (event as KnowledgeEvent).id === 'string' &&
        typeof (event as KnowledgeEvent).runId === 'string' &&
        typeof (event as KnowledgeEvent).kind === 'string' &&
        typeof (event as KnowledgeEvent).title === 'string' &&
        typeof (event as KnowledgeEvent).body === 'string' &&
        typeof (event as KnowledgeEvent).createdAt === 'number',
    )
  );
}

function isWikiPageArray(value: unknown): value is WikiPage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (page) =>
        Boolean(page) &&
        typeof (page as WikiPage).id === 'string' &&
        typeof (page as WikiPage).title === 'string' &&
        typeof (page as WikiPage).body === 'string' &&
        Array.isArray((page as WikiPage).sourceEventIds) &&
        Array.isArray((page as WikiPage).sourceRunIds) &&
        Array.isArray((page as WikiPage).authorAgentIds) &&
        typeof (page as WikiPage).updatedAt === 'number',
    )
  );
}

export class FileKnowledgeStore implements KnowledgeStore {
  private seq = 0;
  constructor(private readonly dir: string) {}

  private async readJson(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, file), 'utf8'));
    } catch {
      return null;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, file);
    this.seq += 1;
    const tmp = `${target}.${this.seq}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, target);
  }

  private async writeText(file: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, file);
    this.seq += 1;
    const tmp = `${target}.${this.seq}.tmp`;
    await writeFile(tmp, value, 'utf8');
    await rename(tmp, target);
  }

  private async writeWikiArtifacts(snapshot: WikiSnapshot): Promise<void> {
    await this.writeJson('wiki.json', snapshot);
    await this.writeText('wiki.md', `${ProjectWiki.fromJSON(snapshot).toMarkdown()}\n`);
    await this.refreshWikiPages();
  }

  async loadWiki(): Promise<WikiSnapshot | null> {
    const value = await this.readJson('wiki.json');
    return isWikiSnapshot(value) ? value : null;
  }

  async saveWiki(snapshot: WikiSnapshot): Promise<void> {
    await this.writeWikiArtifacts(snapshot);
  }

  async mergeWiki(entries: WikiEntry[]): Promise<void> {
    const key = path.resolve(this.dir);
    const prev = wikiWriteLocks.get(key) ?? Promise.resolve();
    // Chain regardless of whether the previous merge resolved or rejected, so
    // one failed write doesn't stall the lock for every later writer.
    const run = prev.then(
      () => this.doMergeWiki(entries),
      () => this.doMergeWiki(entries),
    );
    wikiWriteLocks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  private async doMergeWiki(entries: WikiEntry[]): Promise<void> {
    const onDisk = await this.loadWiki();
    const byId = new Map((onDisk?.entries ?? []).map((e) => [e.id, e] as const));
    for (const entry of entries) byId.set(entry.id, entry);
    await this.saveWiki({ entries: [...byId.values()] });
  }

  async loadKnowledgeEvents(): Promise<KnowledgeEvent[]> {
    const value = await this.readJson('knowledge-events.json');
    return isKnowledgeEventArray(value) ? value : [];
  }

  async saveKnowledgeEvents(events: KnowledgeEvent[]): Promise<void> {
    await this.writeJson('knowledge-events.json', events);
    await this.writeText('knowledge-events.md', renderKnowledgeEventsMarkdown(events));
    await this.refreshWikiPages();
  }

  async loadWikiPages(): Promise<WikiPage[]> {
    const value = await this.readJson('wiki-pages.json');
    return isWikiPageArray(value) ? value : [];
  }

  async saveWikiPages(pages: WikiPage[]): Promise<void> {
    await this.writeJson('wiki-pages.json', pages);
    await this.writeText('wiki-pages.md', renderWikiPagesMarkdown(pages));
  }

  private async refreshWikiPages(): Promise<void> {
    const events = await this.loadKnowledgeEvents();
    const wiki = await this.loadWiki();
    const pages = buildWikiPages(events, wiki);
    await this.saveWikiPages(pages);
  }

  async loadCodegraph(): Promise<CodeGraphSnapshot | null> {
    const value = await this.readJson('codegraph.json');
    return isCodegraphSnapshot(value) ? value : null;
  }

  async saveCodegraph(snapshot: CodeGraphSnapshot): Promise<void> {
    await this.writeJson('codegraph.json', snapshot);
  }
}

/** Convenience: a {@link FileKnowledgeStore} rooted at `<cwd>/.omakase`. */
export function projectKnowledgeStore(cwd: string): FileKnowledgeStore {
  return new FileKnowledgeStore(path.join(cwd, '.omakase'));
}
