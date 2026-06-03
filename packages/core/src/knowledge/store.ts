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
import type { WikiSnapshot } from './wiki.js';

export interface KnowledgeStore {
  loadWiki(): Promise<WikiSnapshot | null>;
  saveWiki(snapshot: WikiSnapshot): Promise<void>;
  loadCodegraph(): Promise<CodeGraphSnapshot | null>;
  saveCodegraph(snapshot: CodeGraphSnapshot): Promise<void>;
}

function isWikiSnapshot(value: unknown): value is WikiSnapshot {
  return Boolean(value) && Array.isArray((value as WikiSnapshot).entries);
}

function isCodegraphSnapshot(value: unknown): value is CodeGraphSnapshot {
  return (
    Boolean(value) &&
    typeof (value as CodeGraphSnapshot).root === 'string' &&
    Array.isArray((value as CodeGraphSnapshot).nodes)
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

  async loadWiki(): Promise<WikiSnapshot | null> {
    const value = await this.readJson('wiki.json');
    return isWikiSnapshot(value) ? value : null;
  }

  async saveWiki(snapshot: WikiSnapshot): Promise<void> {
    await this.writeJson('wiki.json', snapshot);
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
