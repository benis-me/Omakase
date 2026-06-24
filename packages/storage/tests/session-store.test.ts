import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database.js';
import { WORKSPACE_MIGRATIONS } from '../src/db/migrations.js';
import { SqliteSessionStore } from '../src/session-store.js';

describe('SqliteSessionStore', () => {
  let db: Db;
  let store: SqliteSessionStore;

  beforeEach(() => {
    db = openDatabase(':memory:', { migrations: WORKSPACE_MIGRATIONS });
    store = new SqliteSessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and loads a session', async () => {
    const created = await store.create({ id: 's1', title: 'First', now: 100 });
    expect(created).toEqual({
      id: 's1',
      title: 'First',
      runIds: [],
      rollingSummary: '',
      createdAt: 100,
      updatedAt: 100,
    });
    expect(await store.load('s1')).toEqual(created);
  });

  it('appends runs without duplicates and bumps updatedAt', async () => {
    await store.create({ id: 's1', title: 'First', now: 100 });
    await store.appendRun('s1', 'run-a', 200);
    await store.appendRun('s1', 'run-a', 250); // duplicate ignored
    await store.appendRun('s1', 'run-b', 300);
    const session = await store.load('s1');
    expect(session?.runIds).toEqual(['run-a', 'run-b']);
    expect(session?.updatedAt).toBe(300);
  });

  it('updates summary and title', async () => {
    await store.create({ id: 's1', title: 'First', now: 100 });
    await store.updateSummary('s1', 'carried context', 400);
    await store.updateTitle('s1', 'Renamed', 500);
    const session = await store.load('s1');
    expect(session?.rollingSummary).toBe('carried context');
    expect(session?.title).toBe('Renamed');
    expect(session?.updatedAt).toBe(500);
  });

  it('lists sessions newest-first and deletes', async () => {
    await store.create({ id: 's1', title: 'A', now: 100 });
    await store.create({ id: 's2', title: 'B', now: 200 });
    expect((await store.list()).map((s) => s.id)).toEqual(['s2', 's1']);
    await store.delete('s1');
    expect((await store.list()).map((s) => s.id)).toEqual(['s2']);
    expect(await store.load('s1')).toBeNull();
  });
});
