import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgent,
  createSpec,
  createWorkflow,
  deleteSpec,
  ensureWorkspace,
  isWorkspace,
  listAgents,
  listSpecs,
  listWorkflows,
  openWorkspace,
  readAgent,
  readAgentsMd,
  readCommand,
  readSpec,
  writeAgentsMd,
  writeCommand,
  writeSpec,
  type OpenWorkspace,
} from '../src/index.js';
import { makeRecord } from './fixtures.js';

describe('omks workspace', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omks-ws-'));
  });

  it('scaffolds the workspace directories and manifest, idempotently', () => {
    const manifest = ensureWorkspace(root, { name: 'My Project', now: 1000 });
    expect(manifest.name).toBe('My Project');
    expect(isWorkspace(root)).toBe(true);
    for (const dir of ['specs', 'agents', 'memory', 'memory/rules', 'commands', 'workflows']) {
      expect(existsSync(join(root, '.omks', dir))).toBe(true);
    }
    expect(existsSync(join(root, '.omks', '.gitignore'))).toBe(true);
    expect(readFileSync(join(root, '.omks', 'memory', 'AGENTS.md'), 'utf8')).toContain('AGENTS.md');
    // Idempotent: a second ensure keeps the same id.
    expect(ensureWorkspace(root, { now: 2000 }).id).toBe(manifest.id);
  });

  it('opens a workspace, persists runs in omks.db, and reopens with the same id', async () => {
    const ws: OpenWorkspace = openWorkspace(root, { name: 'Demo', now: 1000 });
    const id = ws.manifest.id;
    await ws.runStore.save(makeRecord('run-1', { summary: 'persisted' }));
    ws.close();

    const reopened = openWorkspace(root);
    expect(reopened.manifest.id).toBe(id);
    expect((await reopened.runStore.load('run-1'))?.summary).toBe('persisted');
    expect(existsSync(join(root, '.omks', 'omks.db'))).toBe(true);
    reopened.close();
  });
});

describe('omks authored documents', () => {
  let root: string;

  beforeEach(() => {
    ensureWorkspaceRoot();
  });

  function ensureWorkspaceRoot(): void {
    root = mkdtempSync(join(tmpdir(), 'omks-docs-'));
    ensureWorkspace(root, { now: 1000 });
  }

  it('creates, lists, updates, and deletes specs with frontmatter', () => {
    const spec = createSpec(root, { title: 'Add Login', tags: ['auth'], now: 1000 });
    expect(spec.id).toMatch(/^add-login-/);
    expect(listSpecs(root).map((s) => s.id)).toContain(spec.id);

    const updated = { ...spec, phase: 'acceptance' as const, status: 'ready' as const, updatedAt: 2000 };
    writeSpec(root, updated);
    const reloaded = readSpec(root, spec.id);
    expect(reloaded?.phase).toBe('acceptance');
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.tags).toEqual(['auth']);
    // Frontmatter is human-readable in the file.
    expect(readFileSync(join(root, '.omks', 'specs', `${spec.id}.md`), 'utf8')).toContain(
      'phase: acceptance',
    );

    deleteSpec(root, spec.id);
    expect(readSpec(root, spec.id)).toBeNull();
  });

  it('creates and reads agent definitions, preserving null model/reasoning', () => {
    const agent = createAgent(root, { name: 'Reviewer', role: 'reviewer', agentId: 'claude', now: 1000 });
    const loaded = readAgent(root, agent.id);
    expect(loaded?.name).toBe('Reviewer');
    expect(loaded?.role).toBe('reviewer');
    expect(loaded?.agentId).toBe('claude');
    expect(loaded?.model).toBeNull();
    expect(listAgents(root).map((a) => a.id)).toContain(agent.id);
  });

  it('reads and writes the AGENTS.md briefing', () => {
    expect(readAgentsMd(root)).toContain('AGENTS.md');
    writeAgentsMd(root, '# Custom briefing\n');
    expect(readAgentsMd(root)).toBe('# Custom briefing\n');
  });

  it('writes and reads custom commands with a description', () => {
    writeCommand(root, { name: 'remember', description: 'Append to memory', body: 'Remember: $ARGUMENTS' });
    const cmd = readCommand(root, 'remember');
    expect(cmd?.description).toBe('Append to memory');
    expect(cmd?.body.trim()).toBe('Remember: $ARGUMENTS');
  });

  it('creates workflows and derives the name from a // name: hint', () => {
    const wf = createWorkflow(root, 'Nightly Audit');
    expect(wf.id).toBe('nightly-audit');
    expect(listWorkflows(root)[0].name).toBe('Nightly Audit');
  });
});
