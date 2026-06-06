import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { FileKnowledgeStore, projectKnowledgeStore } from '../src/knowledge/store.js';
import { ProjectWiki, type WikiEntry } from '../src/knowledge/wiki.js';
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

  const entry = (id: string, title = id): WikiEntry => ({
    id,
    kind: 'fact',
    title,
    body: '',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  });

  it('mergeWiki unions concurrent writers without clobbering', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-merge-'));
    // Two independent store instances merge disjoint entries at the same time.
    // A naive load-merge-save would race (both read empty, last write wins) and
    // drop one writer's entries; the per-dir lock serializes the cycles.
    const a = new FileKnowledgeStore(dir);
    const b = new FileKnowledgeStore(dir);
    await Promise.all([
      a.mergeWiki([entry('wiki-1'), entry('wiki-2')]),
      b.mergeWiki([entry('wiki-3'), entry('wiki-4')]),
    ]);
    const ids = (await a.loadWiki())!.entries.map((e) => e.id).sort();
    expect(ids).toEqual(['wiki-1', 'wiki-2', 'wiki-3', 'wiki-4']);
  });

  it('mergeWiki lets incoming entries win on id collision', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-merge-'));
    const store = new FileKnowledgeStore(dir);
    await store.mergeWiki([entry('x', 'old')]);
    await store.mergeWiki([entry('x', 'new')]);
    const entries = (await store.loadWiki())!.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('new');
  });

  it('writes a human-readable wiki.md beside wiki.json', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-wiki-md-'));
    const store = new FileKnowledgeStore(dir);
    await store.mergeWiki([entry('wiki-1', 'Uses pnpm')]);
    expect(readFileSync(path.join(dir, 'wiki.md'), 'utf8')).toContain('Uses pnpm');
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

  it('keeps task wiki entries distinct when task ids repeat across runs', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-proj-tasks-'));
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

    await makeOrch().start({ prompt: '- first durable task' }).result;
    await makeOrch().start({ prompt: '- second durable task' }).result;

    const stored = await knowledgeStore.loadWiki();
    const taskTitles = (stored?.entries ?? [])
      .filter((entry) => entry.kind === 'task')
      .map((entry) => entry.title);
    expect(taskTitles.join('\n')).toContain('first durable task');
    expect(taskTitles.join('\n')).toContain('second durable task');
  });

  it('emits codegraph stats with knowledge updates', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-proj-codegraph-'));
    const src = path.join(cwd, 'src');
    await import('node:fs/promises').then((fs) => fs.mkdir(src, { recursive: true }));
    writeFileSync(path.join(src, 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(path.join(src, 'b.ts'), 'export const b = 1;\n');
    const codegraph = await CodeGraph.scan({ root: cwd });

    const orch = new Orchestrator({
      runtime: runtime(),
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      knowledgeStore: projectKnowledgeStore(cwd),
      codegraph,
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });
    const result = await orch.start({ prompt: '- task a' }).result;
    const event = result.events.findLast((e) => e.type === 'knowledge-updated') as
      | { type: 'knowledge-updated'; codegraph?: unknown }
      | undefined;
    expect(event?.codegraph).toMatchObject({
      files: 2,
      internalEdges: 1,
      symbols: 2,
      cycles: 0,
    });
  });

  it('auto-scans codegraph for project runs with a knowledge store', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-proj-auto-codegraph-'));
    const src = path.join(cwd, 'src');
    await import('node:fs/promises').then((fs) => fs.mkdir(src, { recursive: true }));
    writeFileSync(path.join(src, 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(path.join(src, 'b.ts'), 'export const b = 1;\n');

    const orch = new Orchestrator({
      runtime: runtime(),
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      knowledgeStore: projectKnowledgeStore(cwd),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });
    const result = await orch.start({ prompt: '- task a', cwd }).result;
    const event = result.events.find((e) => e.type === 'knowledge-updated') as
      | { type: 'knowledge-updated'; codegraph?: unknown }
      | undefined;
    expect(event?.codegraph).toMatchObject({
      files: 2,
      internalEdges: 1,
      symbols: 2,
      cycles: 0,
    });
    expect(existsSync(path.join(cwd, '.omakase', 'codegraph.json'))).toBe(true);
  });

  it('refreshes stale persisted codegraph snapshots at run start', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-proj-refresh-codegraph-'));
    const knowledgeStore = projectKnowledgeStore(cwd);
    await knowledgeStore.saveCodegraph(new CodeGraph(cwd).toJSON());
    const src = path.join(cwd, 'src');
    await import('node:fs/promises').then((fs) => fs.mkdir(src, { recursive: true }));
    writeFileSync(path.join(src, 'fresh.ts'), 'export const fresh = 1;\n');

    const orch = new Orchestrator({
      runtime: runtime(),
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      knowledgeStore,
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });
    const result = await orch.start({ prompt: '- task a', cwd }).result;
    const event = result.events.find((e) => e.type === 'knowledge-updated') as
      | { type: 'knowledge-updated'; codegraph?: { files?: number } | null }
      | undefined;
    expect(event?.codegraph?.files).toBe(1);
    expect((await knowledgeStore.loadCodegraph())?.nodes.map((node) => node.path)).toContain('src/fresh.ts');
  });

  it('records useful agent metadata in task wiki entries', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-proj-wiki-agent-'));
    const exec = createScriptedAgent((input) =>
      String(input.metadata?.role) === 'reviewer'
        ? [{ type: 'text_delta', delta: 'APPROVE' }]
        : [
            { type: 'text_delta', delta: 'implemented durable state' },
            { type: 'tool_use', id: 'read-1', name: 'read', input: {} },
            { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
          ],
    );
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store: new MemoryRunStore(),
      knowledgeStore: projectKnowledgeStore(cwd),
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });
    const result = await orch.start({ prompt: '- task a' }).result;
    const task = result.wiki.entries.find((e) => e.kind === 'task');
    expect(task?.body).toContain('Agent: scripted');
    expect(task?.body).toContain('Tokens: 7');
    expect(task?.body).toContain('Tools: 1');
  });
});
