import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { FileKnowledgeStore, projectKnowledgeStore } from '../src/knowledge/store.js';
import { ProjectWiki } from '../src/knowledge/wiki.js';
import { CodeGraph } from '../src/knowledge/codegraph.js';
import { createModelPolicy, type Router } from '../src/index.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 't', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

function runtime() {
  const exec = createScriptedAgent((input) =>
    String(input.metadata?.role) === 'reviewer'
      ? [{ type: 'text_delta', delta: 'APPROVE' }]
      : [{ type: 'text_delta', delta: 'done' }],
  );
  return createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
}

describe('FileKnowledgeStore', () => {
  it('round-trips wiki and codegraph snapshots, ignoring corrupt files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-knowledge-'));
    const store = new FileKnowledgeStore(dir);
    expect(await store.loadWiki()).toBeNull();

    const wiki = new ProjectWiki({ clock: () => 0 });
    wiki.addFact({ title: 'Uses pnpm' });
    await store.saveWiki(wiki.toJSON());
    expect((await store.loadWiki())?.entries).toHaveLength(1);
    expect(existsSync(path.join(dir, 'wiki.json'))).toBe(true);

    const cg = new CodeGraph(dir);
    await store.saveCodegraph(cg.toJSON());
    expect((await store.loadCodegraph())?.root).toBe(dir);
  });
});

describe('orchestrator cross-run knowledge persistence', () => {
  it('accumulates wiki knowledge across runs via .omakase/', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-proj-'));
    const knowledgeStore = projectKnowledgeStore(cwd);
    const shared = runtime();

    const makeOrch = () =>
      new Orchestrator({
        runtime: shared,
        router: complexRouter,
        policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
        store: new MemoryRunStore(),
        knowledgeStore,
        clock: () => 0,
        detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      });

    const first = await makeOrch().start({ prompt: '- task a\n- task b' }).result;
    expect(first.status).toBe('succeeded');
    const firstEntries = first.wiki.entries.length;
    expect(firstEntries).toBeGreaterThan(0);
    expect(existsSync(path.join(cwd, '.omakase', 'wiki.json'))).toBe(true);

    // A second run loads the persisted wiki and adds to it.
    const second = await makeOrch().start({ prompt: '- task c' }).result;
    expect(second.wiki.entries.length).toBeGreaterThan(firstEntries);
  });
});
