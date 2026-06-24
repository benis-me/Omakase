import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database.js';
import { WORKSPACE_MIGRATIONS } from '../src/db/migrations.js';
import { SqliteRunStore } from '../src/run-store.js';
import { heartbeat, makeKnowledgeEvent, makeRecord, makeReport, makeTask } from './fixtures.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'omks-runstore-'));
}

describe('SqliteRunStore', () => {
  let db: Db;
  let store: SqliteRunStore;

  beforeEach(() => {
    db = openDatabase(':memory:', { migrations: WORKSPACE_MIGRATIONS });
    store = new SqliteRunStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a record including its events', async () => {
    const record = makeRecord('run-1', {
      events: [
        { type: 'run-started', runId: 'run-1', request: { prompt: 'x' }, mode: 'normal' },
        heartbeat(1),
      ],
      summary: 'in progress',
      spentTokens: 4200,
      spentCostUsd: 0.12,
      checkpointSeq: 3,
    });
    await store.save(record);
    const loaded = await store.load('run-1');
    expect(loaded).toEqual(record);
  });

  it('appends only new events across checkpoints and preserves earlier ones', async () => {
    const record = makeRecord('run-1', { events: [heartbeat(1)] });
    await store.save(record);
    expect(store.countEvents('run-1')).toBe(1);

    // Simulate the orchestrator pushing more events and checkpointing again.
    record.events.push(heartbeat(2), heartbeat(3));
    record.updatedAt = 2000;
    await store.save(record);

    expect(store.countEvents('run-1')).toBe(3);
    const loaded = await store.load('run-1');
    expect(loaded?.events.map((e) => (e as { at: number }).at)).toEqual([1, 2, 3]);
    // The appended tail can also be fetched incrementally for live tailing.
    expect(store.events('run-1', 1).map((e) => (e as { at: number }).at)).toEqual([2, 3]);
  });

  it('rebuilds a shorter/replaced event log instead of leaving stale rows', async () => {
    await store.save(makeRecord('run-1', { events: [heartbeat(1), heartbeat(2), heartbeat(3)] }));
    await store.save(makeRecord('run-1', { events: [heartbeat(9)] }));
    expect(store.countEvents('run-1')).toBe(1);
    const loaded = await store.load('run-1');
    expect(loaded?.events.map((e) => (e as { at: number }).at)).toEqual([9]);
  });

  it('projects tasks, reports, and knowledge events for cross-run queries', async () => {
    const record = makeRecord('run-1', {
      plan: { tasks: [makeTask('t1'), makeTask('t2', { dependsOn: ['t1'] })], seq: 2 },
      reports: [makeReport('r1')],
      knowledgeEvents: [makeKnowledgeEvent('k1')],
    });
    await store.save(record);
    expect(db.prepare('SELECT count(*) AS n FROM tasks WHERE run_id = ?').get('run-1')).toEqual({
      n: 2,
    });
    expect(db.prepare('SELECT count(*) AS n FROM reports WHERE run_id = ?').get('run-1')).toEqual({
      n: 1,
    });
    expect(
      db.prepare('SELECT count(*) AS n FROM run_knowledge_events WHERE run_id = ?').get('run-1'),
    ).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT depends_on_json FROM tasks WHERE run_id = ? AND id = ?').get('run-1', 't2'),
    ).toEqual({ depends_on_json: '["t1"]' });
  });

  it('lists run ids newest-first and exposes summaries', async () => {
    await store.save(makeRecord('a', { createdAt: 1, updatedAt: 1 }));
    await store.save(makeRecord('b', { createdAt: 2, updatedAt: 2, status: 'succeeded' }));
    expect(await store.list()).toEqual(['b', 'a']);
    const summaries = store.summaries();
    expect(summaries.map((s) => s.id)).toEqual(['b', 'a']);
    expect(summaries[0].status).toBe('succeeded');
  });

  it('deletes a run and its events/projections', async () => {
    await store.save(makeRecord('run-1', { events: [heartbeat(1)], reports: [makeReport('r1')] }));
    await store.delete('run-1');
    expect(await store.load('run-1')).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM run_events').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM reports').get()).toEqual({ n: 0 });
  });

  it('returns null for missing or corrupt rows', async () => {
    expect(await store.load('nope')).toBeNull();
    db.prepare(
      `INSERT INTO runs (id, mode, status, events_count, record_json, created_at, updated_at, heartbeat_at)
       VALUES ('bad', 'normal', 'running', 0, '{not json', 0, 0, 0)`,
    ).run();
    expect(await store.load('bad')).toBeNull();
  });

  it('persists across reopening the same database file (WAL)', async () => {
    const file = `${makeTmpDir()}/omks.db`;
    const first = openDatabase(file, { migrations: WORKSPACE_MIGRATIONS });
    await new SqliteRunStore(first).save(makeRecord('run-1', { events: [heartbeat(7)] }));
    first.close();

    const second = openDatabase(file, { migrations: WORKSPACE_MIGRATIONS });
    const loaded = await new SqliteRunStore(second).load('run-1');
    second.close();
    expect((loaded?.events[0] as { at: number }).at).toBe(7);
  });
});
