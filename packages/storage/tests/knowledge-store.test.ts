import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeGraphSnapshot, WikiPage } from '@omakase/core';
import { openDatabase, type Db } from '../src/db/database.js';
import { WORKSPACE_MIGRATIONS } from '../src/db/migrations.js';
import { SqliteKnowledgeStore } from '../src/knowledge-store.js';
import { makeKnowledgeEvent, makeWikiEntry } from './fixtures.js';

describe('SqliteKnowledgeStore', () => {
  let db: Db;
  let store: SqliteKnowledgeStore;

  beforeEach(() => {
    db = openDatabase(':memory:', { migrations: WORKSPACE_MIGRATIONS });
    store = new SqliteKnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns null wiki before first save, snapshot after (even when empty)', async () => {
    expect(await store.loadWiki()).toBeNull();
    await store.saveWiki({ entries: [] });
    expect(await store.loadWiki()).toEqual({ entries: [] });
  });

  it('round-trips wiki entries', async () => {
    const snapshot = { entries: [makeWikiEntry('w1'), makeWikiEntry('w2', { tags: [] })] };
    await store.saveWiki(snapshot);
    expect(await store.loadWiki()).toEqual(snapshot);
  });

  it('merges wiki entries with incoming winning on id collision', async () => {
    await store.saveWiki({ entries: [makeWikiEntry('w1', { title: 'old' })] });
    await store.mergeWiki([
      makeWikiEntry('w1', { title: 'new' }),
      makeWikiEntry('w2', { title: 'added' }),
    ]);
    const wiki = await store.loadWiki();
    const byId = new Map(wiki?.entries.map((e) => [e.id, e.title]));
    expect(byId.get('w1')).toBe('new');
    expect(byId.get('w2')).toBe('added');
    expect(wiki?.entries).toHaveLength(2);
  });

  it('round-trips knowledge events', async () => {
    const events = [makeKnowledgeEvent('k1'), makeKnowledgeEvent('k2', { kind: 'decision' })];
    await store.saveKnowledgeEvents(events);
    expect(await store.loadKnowledgeEvents()).toEqual(events);
  });

  it('round-trips wiki pages directly', async () => {
    const page: WikiPage = {
      id: 'overview',
      title: 'Overview',
      body: 'the body',
      sourceKind: 'agent',
      sourceEventIds: ['k1'],
      sourceRunIds: ['run-1'],
      authorAgentIds: ['claude'],
      updatedAt: 9,
    };
    await store.saveWikiPages([page]);
    expect(await store.loadWikiPages()).toEqual([page]);
  });

  it('round-trips a codegraph snapshot', async () => {
    const snapshot: CodeGraphSnapshot = { root: '/project', nodes: [] };
    expect(await store.loadCodegraph()).toBeNull();
    await store.saveCodegraph(snapshot);
    expect(await store.loadCodegraph()).toEqual(snapshot);
  });

  it('refreshes derived wiki pages without throwing on save', async () => {
    await store.saveWiki({ entries: [makeWikiEntry('w1')] });
    await store.saveKnowledgeEvents([makeKnowledgeEvent('k1', { kind: 'decision' })]);
    expect(Array.isArray(await store.loadWikiPages())).toBe(true);
  });

  it('renders git-friendly markdown projections when a renderDir is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omks-knowledge-'));
    const rendered = new SqliteKnowledgeStore(db, { renderDir: dir });
    await rendered.saveWiki({ entries: [makeWikiEntry('w1', { title: 'Persisted Fact' })] });
    await rendered.saveKnowledgeEvents([makeKnowledgeEvent('k1', { title: 'A Decision' })]);
    expect(readFileSync(join(dir, 'wiki.md'), 'utf8')).toContain('Persisted Fact');
    expect(readFileSync(join(dir, 'knowledge-events.md'), 'utf8')).toContain('A Decision');
  });
});
