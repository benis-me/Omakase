import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRunStore, MemoryRunStore, isValidRunRecord } from '../src/supervisor/run-store.js';
import type { RunRecord } from '../src/supervisor/run-store.js';

function record(id: string): RunRecord {
  return {
    id,
    request: { prompt: 'do a thing' },
    mode: 'normal',
    status: 'running',
    plan: { tasks: [], seq: 0 },
    wiki: { entries: [] },
    inbox: [],
    events: [],
    summary: '',
    createdAt: 0,
    updatedAt: 0,
    heartbeatAt: 0,
    checkpointSeq: 1,
  };
}

describe('MemoryRunStore', () => {
  it('round-trips and isolates stored records', async () => {
    const store = new MemoryRunStore();
    await store.save(record('r1'));
    const loaded = await store.load('r1');
    expect(loaded?.id).toBe('r1');
    // Mutating the loaded copy must not affect the stored one.
    loaded!.summary = 'mutated';
    expect((await store.load('r1'))?.summary).toBe('');
    expect(await store.list()).toEqual(['r1']);
    await store.delete('r1');
    expect(await store.load('r1')).toBeNull();
  });
});

describe('FileRunStore', () => {
  it('saves atomically and round-trips', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-runstore-'));
    const store = new FileRunStore(dir);
    await store.save(record('run-7'));
    expect(await store.list()).toEqual(['run-7']);
    expect((await store.load('run-7'))?.id).toBe('run-7');
    // No leftover temp file.
    expect((await store.list()).every((id) => !id.includes('.tmp'))).toBe(true);
  });

  it('does not report control files as runs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-runstore-control-'));
    const store = new FileRunStore(dir);
    await store.save(record('run-1'));
    writeFileSync(path.join(dir, 'run-1.control.json'), '{"seq":1,"command":"stop"}');

    expect(await store.list()).toEqual(['run-1']);
  });

  it('returns null for a corrupt or partial file instead of throwing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-runstore-bad-'));
    const store = new FileRunStore(dir);
    writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');
    writeFileSync(path.join(dir, 'partial.json'), JSON.stringify({ id: 'partial' }));
    expect(await store.load('broken')).toBeNull();
    expect(await store.load('partial')).toBeNull();
    expect(await store.load('missing')).toBeNull();
  });
});

describe('isValidRunRecord', () => {
  it('accepts a well-formed record and rejects malformed ones', () => {
    expect(isValidRunRecord(record('ok'))).toBe(true);
    expect(isValidRunRecord({ id: 'x' })).toBe(false);
    expect(isValidRunRecord(null)).toBe(false);
    expect(isValidRunRecord({ ...record('x'), plan: { seq: 0 } })).toBe(false);
  });

  it('rejects records that would crash resume() — bad wiki or malformed task', () => {
    // These pass the old field checks but would throw synchronously in
    // ProjectWiki.fromJSON / PlanGraph.fromSnapshot inside the RunController ctor.
    expect(isValidRunRecord({ ...record('x'), wiki: undefined })).toBe(false);
    expect(isValidRunRecord({ ...record('x'), wiki: {} })).toBe(false); // no entries[]
    expect(
      isValidRunRecord({ ...record('x'), plan: { tasks: [{ title: 'no id' }], seq: 0 } }),
    ).toBe(false);
    expect(
      isValidRunRecord({
        ...record('x'),
        plan: { tasks: [{ id: 't', dependsOn: [] }], seq: 0 },
      }),
    ).toBe(true);
  });
});
