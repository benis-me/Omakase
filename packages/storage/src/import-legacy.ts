/**
 * One-shot, non-destructive importer from the legacy `.omakase/` JSON layout
 * into a new `.omks` workspace's stores. Leaves the old directory untouched, and
 * validates each record with core's guards so a partial/stale file is skipped
 * rather than crashing the import.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  isValidRunRecord,
  isValidSession,
  type CodeGraphSnapshot,
  type KnowledgeEvent,
  type WikiSnapshot,
} from '@omakase/core';
import type { SqliteKnowledgeStore } from './knowledge-store.js';
import type { SqliteRunStore } from './run-store.js';
import type { SqliteSessionStore } from './session-store.js';

export interface LegacyImportTarget {
  runStore: SqliteRunStore;
  sessionStore: SqliteSessionStore;
  knowledgeStore: SqliteKnowledgeStore;
}

export interface LegacyImportResult {
  runs: number;
  sessions: number;
  wikiEntries: number;
  knowledgeEvents: number;
  codegraph: boolean;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** True if `<projectRoot>/.omakase` exists with importable content. */
export async function hasLegacyOmakase(projectRoot: string): Promise<boolean> {
  const legacy = path.join(projectRoot, '.omakase');
  const runs = await safeReaddir(path.join(legacy, 'runs'));
  if (runs.some((f) => f.endsWith('.json') && !f.endsWith('.control.json'))) return true;
  const top = await safeReaddir(legacy);
  return top.includes('wiki.json') || top.includes('sessions');
}

export async function importLegacyOmakase(
  projectRoot: string,
  target: LegacyImportTarget,
): Promise<LegacyImportResult> {
  const legacy = path.join(projectRoot, '.omakase');
  const result: LegacyImportResult = {
    runs: 0,
    sessions: 0,
    wikiEntries: 0,
    knowledgeEvents: 0,
    codegraph: false,
  };

  // Runs
  for (const file of await safeReaddir(path.join(legacy, 'runs'))) {
    if (!file.endsWith('.json') || file.endsWith('.control.json')) continue;
    const record = await readJson(path.join(legacy, 'runs', file));
    if (isValidRunRecord(record)) {
      await target.runStore.save(record);
      result.runs += 1;
    }
  }

  // Sessions (reconstructed through the store interface, preserving run order).
  for (const file of await safeReaddir(path.join(legacy, 'sessions'))) {
    if (!file.endsWith('.json')) continue;
    const session = await readJson(path.join(legacy, 'sessions', file));
    if (!isValidSession(session)) continue;
    await target.sessionStore.create({
      id: session.id,
      title: session.title,
      now: session.createdAt,
    });
    for (const runId of session.runIds) {
      await target.sessionStore.appendRun(session.id, runId, session.updatedAt);
    }
    if (session.rollingSummary) {
      await target.sessionStore.updateSummary(session.id, session.rollingSummary, session.updatedAt);
    }
    result.sessions += 1;
  }

  // Wiki
  const wiki = await readJson(path.join(legacy, 'wiki.json'));
  if (isWikiSnapshot(wiki)) {
    await target.knowledgeStore.saveWiki(wiki);
    result.wikiEntries = wiki.entries.length;
  }

  // Knowledge events
  const events = await readJson(path.join(legacy, 'knowledge-events.json'));
  if (isKnowledgeEventArray(events)) {
    await target.knowledgeStore.saveKnowledgeEvents(events);
    result.knowledgeEvents = events.length;
  }

  // Codegraph
  const codegraph = await readJson(path.join(legacy, 'codegraph.json'));
  if (isCodegraphSnapshot(codegraph)) {
    await target.knowledgeStore.saveCodegraph(codegraph);
    result.codegraph = true;
  }

  return result;
}

function isWikiSnapshot(value: unknown): value is WikiSnapshot {
  return Boolean(value) && Array.isArray((value as WikiSnapshot).entries);
}

function isKnowledgeEventArray(value: unknown): value is KnowledgeEvent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        Boolean(e) &&
        typeof (e as KnowledgeEvent).id === 'string' &&
        typeof (e as KnowledgeEvent).runId === 'string' &&
        typeof (e as KnowledgeEvent).createdAt === 'number',
    )
  );
}

function isCodegraphSnapshot(value: unknown): value is CodeGraphSnapshot {
  return (
    Boolean(value) &&
    typeof (value as CodeGraphSnapshot).root === 'string' &&
    Array.isArray((value as CodeGraphSnapshot).nodes)
  );
}
