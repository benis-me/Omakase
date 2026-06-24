import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Session } from '@omakase/core';
import { hasLegacyOmakase, importLegacyOmakase } from '../src/import-legacy.js';
import { openWorkspace } from '../src/omks/workspace.js';
import { heartbeat, makeRecord, makeWikiEntry } from './fixtures.js';

function seedLegacy(root: string): void {
  const legacy = join(root, '.omakase');
  mkdirSync(join(legacy, 'runs'), { recursive: true });
  mkdirSync(join(legacy, 'sessions'), { recursive: true });

  writeFileSync(
    join(legacy, 'runs', 'run-1.json'),
    JSON.stringify(makeRecord('run-1', { summary: 'legacy run', events: [heartbeat(1)] })),
  );
  // A stale/partial run that must be skipped, not crash the import.
  writeFileSync(join(legacy, 'runs', 'broken.json'), '{ not valid');
  // A control sidecar that must be ignored.
  writeFileSync(join(legacy, 'runs', 'run-1.control.json'), JSON.stringify({ seq: 1, command: 'stop' }));

  const session: Session = {
    id: 'ses-1',
    title: 'Legacy Session',
    runIds: ['run-1'],
    rollingSummary: 'carried context',
    createdAt: 100,
    updatedAt: 200,
  };
  writeFileSync(join(legacy, 'sessions', 'ses-1.json'), JSON.stringify(session));

  writeFileSync(
    join(legacy, 'wiki.json'),
    JSON.stringify({ entries: [makeWikiEntry('w1'), makeWikiEntry('w2')] }),
  );
}

describe('importLegacyOmakase', () => {
  it('detects and imports a legacy .omakase directory non-destructively', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omks-import-'));
    seedLegacy(root);
    expect(await hasLegacyOmakase(root)).toBe(true);

    const ws = openWorkspace(root, { now: 1000 });
    const result = await importLegacyOmakase(root, {
      runStore: ws.runStore,
      sessionStore: ws.sessionStore,
      knowledgeStore: ws.knowledgeStore,
    });

    expect(result.runs).toBe(1);
    expect(result.sessions).toBe(1);
    expect(result.wikiEntries).toBe(2);

    const run = await ws.runStore.load('run-1');
    expect(run?.summary).toBe('legacy run');
    expect(run?.events).toHaveLength(1);

    const session = await ws.sessionStore.load('ses-1');
    expect(session?.runIds).toEqual(['run-1']);
    expect(session?.rollingSummary).toBe('carried context');

    expect((await ws.knowledgeStore.loadWiki())?.entries).toHaveLength(2);
    ws.close();
  });

  it('reports no legacy dir when absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omks-noimport-'));
    expect(await hasLegacyOmakase(root)).toBe(false);
  });
});
