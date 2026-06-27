import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgent,
  createSpec,
  createWorkflow,
  deleteSpec,
  deleteTrigger,
  ensureWorkspace,
  isWorkspace,
  listAgents,
  listSpecs,
  listTriggers,
  listWorkflows,
  openWorkspace,
  WORKFLOW_TEMPLATES,
  saveTrigger,
  readAgent,
  readAgentsMd,
  readCommand,
  readSpec,
  writeAgentsMd,
  writeCommand,
  writeSpec,
  type OpenWorkspace,
} from '../src/index.js';
import { validateWorkflowScriptSource } from '@omakase/core';
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

  it('ships workflow templates that pass the dynamic-workflow validator', () => {
    // Templates are offered via the "New" menu (not auto-seeded); they must still
    // satisfy the runner contract: a default export and no forbidden globals.
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of WORKFLOW_TEMPLATES) {
      expect(t.source).toMatch(/export default async function/);
      expect(() => validateWorkflowScriptSource(t.source)).not.toThrow();
    }
  });

  it('does not auto-seed workflow files into a fresh workspace', () => {
    ensureWorkspace(root, { name: 'WF', now: 1 });
    expect(listWorkflows(root)).toEqual([]);
  });

  it('persists triggers (automations) with defaults, upserts, and deletes', () => {
    ensureWorkspace(root, { now: 1 });
    expect(listTriggers(root)).toEqual([]);

    const t = saveTrigger(root, { name: 'Nightly', kind: 'interval', specId: 's1' });
    expect(t.enabled).toBe(false); // disabled until armed
    expect(t.intervalMinutes).toBe(30);
    expect(t.autonomy).toBe('medium');
    expect(listTriggers(root)).toHaveLength(1);

    const updated = saveTrigger(root, {
      id: t.id,
      name: 'Nightly',
      kind: 'interval',
      enabled: true,
      intervalMinutes: 15,
    });
    expect(updated.enabled).toBe(true);
    expect(updated.intervalMinutes).toBe(15);
    expect(listTriggers(root)).toHaveLength(1); // upsert, not append

    deleteTrigger(root, t.id);
    expect(listTriggers(root)).toEqual([]);
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

  it('round-trips the structured phase artifacts and transition history', () => {
    const spec = createSpec(root, { title: 'Add Search', now: 1000 });
    // A freshly created spec starts with empty artifacts and no history.
    expect(spec.acceptanceCriteria).toEqual([]);
    expect(spec.testPlan).toEqual([]);
    expect(spec.tasks).toEqual([]);
    expect(spec.history).toEqual([]);

    // Persist the structured state a guided advance would produce.
    const populated = {
      ...spec,
      phase: 'tasks' as const,
      acceptanceCriteria: ['Results appear within 200ms', 'Empty query shows recents'],
      testPlan: ['unit: tokenizer', 'e2e: type-and-see'],
      tasks: ['Build index', 'Wire the input'],
      history: [
        { from: 'idea' as const, to: 'spec' as const, at: 1100 },
        { from: 'spec' as const, to: 'acceptance' as const, at: 1200 },
      ],
      updatedAt: 2000,
    };
    writeSpec(root, populated);

    const reloaded = readSpec(root, spec.id);
    expect(reloaded?.phase).toBe('tasks');
    expect(reloaded?.acceptanceCriteria).toEqual(populated.acceptanceCriteria);
    expect(reloaded?.testPlan).toEqual(populated.testPlan);
    expect(reloaded?.tasks).toEqual(populated.tasks);
    expect(reloaded?.history).toEqual(populated.history);
    // The arrays/history are human-readable in the frontmatter.
    const raw = readFileSync(join(root, '.omks', 'specs', `${spec.id}.md`), 'utf8');
    expect(raw).toContain('acceptanceCriteria:');
    expect(raw).toContain('history:');

    // Malformed history entries are filtered defensively on read.
    const corrupted = { ...populated, history: [{ from: 'bogus', to: 'spec', at: 5 }] as never };
    writeSpec(root, corrupted);
    expect(readSpec(root, spec.id)?.history).toEqual([]);
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

  it('creates a workflow and reads its name from the // name: hint', () => {
    const wf = createWorkflow(root, 'Nightly Audit');
    expect(wf.id).toBe('nightly-audit');
    expect(listWorkflows(root).map((w) => w.name)).toContain('Nightly Audit');
  });
});
