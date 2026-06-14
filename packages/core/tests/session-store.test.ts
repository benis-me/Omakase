import { describe, expect, it } from 'vitest';
import { MemorySessionStore, isValidSession } from '../src/session/store.js';

describe('MemorySessionStore', () => {
  it('creates, appends runs, updates summary/title, lists newest-first', async () => {
    const store = new MemorySessionStore();
    const a = await store.create({ id: 's1', title: 'first', now: 1000 });
    expect(a).toMatchObject({ id: 's1', title: 'first', runIds: [], rollingSummary: '' });

    await store.appendRun('s1', 'run-1', 1100);
    await store.appendRun('s1', 'run-1', 1150); // idempotent: no duplicate
    await store.updateSummary('s1', 'did X', 1200);
    await store.updateTitle('s1', 'renamed', 1250);

    const loaded = await store.load('s1');
    expect(loaded).toMatchObject({
      title: 'renamed',
      runIds: ['run-1'],
      rollingSummary: 'did X',
      updatedAt: 1250,
    });

    await store.create({ id: 's2', title: 'second', now: 2000 });
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(['s2', 's1']); // newest updatedAt first
  });

  it('returns null for unknown ids and after delete', async () => {
    const store = new MemorySessionStore();
    await store.create({ id: 's1', title: 't', now: 1 });
    await store.delete('s1');
    expect(await store.load('s1')).toBeNull();
    expect(await store.load('nope')).toBeNull();
  });

  it('isValidSession rejects malformed shapes', () => {
    expect(isValidSession({ id: 's', title: 't', runIds: [], rollingSummary: '', createdAt: 1, updatedAt: 1 })).toBe(true);
    expect(isValidSession({ id: 's', runIds: [], rollingSummary: '' })).toBe(false); // missing title/timestamps
    expect(isValidSession({ id: 's', title: 't', runIds: 'x', rollingSummary: '', createdAt: 1, updatedAt: 1 })).toBe(false);
    expect(isValidSession(null)).toBe(false);
  });
});
