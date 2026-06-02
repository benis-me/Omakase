import { describe, expect, it } from 'vitest';
import {
  WorkspaceDirtyError,
  assertSafeWorkspace,
  buildSelfImproveRequest,
  readGitStatus,
  summarizeChanges,
  type GitRunner,
} from '../src/self-improve.js';
import { RulePlanner } from '../src/plan/planner.js';
import { createIdGenerator } from '../src/ids.js';

const dirtyRunner: GitRunner = async (args) => {
  if (args[0] === 'status') return { stdout: ' M src/a.ts\n?? new.ts\nR  old.ts -> renamed.ts\n', code: 0 };
  if (args[0] === 'rev-parse') return { stdout: 'main\n', code: 0 };
  return { stdout: '', code: 0 };
};
const cleanRunner: GitRunner = async (args) => {
  if (args[0] === 'status') return { stdout: '', code: 0 };
  if (args[0] === 'rev-parse') return { stdout: 'main\n', code: 0 };
  return { stdout: '', code: 0 };
};
const notRepoRunner: GitRunner = async () => ({ stdout: 'fatal: not a git repository', code: 128 });

describe('readGitStatus', () => {
  it('parses porcelain output including renames and untracked files', async () => {
    const status = await readGitStatus('/x', dirtyRunner);
    expect(status.isRepo).toBe(true);
    expect(status.clean).toBe(false);
    expect(status.changedFiles).toEqual(['src/a.ts', 'new.ts', 'renamed.ts']);
    expect(status.branch).toBe('main');
  });

  it('treats a non-repo as a clean, non-repo workspace', async () => {
    const status = await readGitStatus('/x', notRepoRunner);
    expect(status.isRepo).toBe(false);
    expect(status.clean).toBe(true);
  });
});

describe('assertSafeWorkspace', () => {
  it('throws on a dirty repo', async () => {
    await expect(assertSafeWorkspace('/x', dirtyRunner)).rejects.toBeInstanceOf(WorkspaceDirtyError);
  });
  it('passes with allowDirty', async () => {
    const status = await assertSafeWorkspace('/x', dirtyRunner, { allowDirty: true });
    expect(status.changedFiles.length).toBeGreaterThan(0);
  });
  it('passes on a clean repo and on a non-repo', async () => {
    await expect(assertSafeWorkspace('/x', cleanRunner)).resolves.toBeDefined();
    await expect(assertSafeWorkspace('/x', notRepoRunner)).resolves.toBeDefined();
  });
});

describe('buildSelfImproveRequest', () => {
  it('frames a 5-phase pipeline that the planner expands into tasks', () => {
    const request = buildSelfImproveRequest('speed up detection', '/repo');
    expect(request.prompt).toContain('Diagnose');
    expect(request.prompt).toContain('Retrospective');
    expect(request.metadata).toMatchObject({ kind: 'self-improvement' });

    const graph = new RulePlanner().plan({
      request,
      idGenerator: createIdGenerator(),
      clock: () => 0,
    });
    expect(graph.tasks().filter((t) => t.role === 'worker')).toHaveLength(5);
  });
});

describe('summarizeChanges', () => {
  it('reports files changed during the session', () => {
    const before = { isRepo: true, clean: true, changedFiles: [], branch: 'main' };
    const after = { isRepo: true, clean: false, changedFiles: ['src/x.ts'], branch: 'main' };
    const summary = summarizeChanges(before, after);
    expect(summary).toContain('src/x.ts');
    expect(summary).toContain('1');
  });
});
