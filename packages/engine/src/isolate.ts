// Git worktree isolation: run a unit of work in its own worktree/branch, then
// merge the result back into the base. Lets parallel agents edit even the same
// files without clobbering each other. No-op outside a git repo.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shortId, slugify } from '@omakase/core';

interface GitResult {
  code: number;
  out: string;
  err: string;
}

function git(args: string[], cwd: string): GitResult {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

export function isGitRepo(cwd: string): boolean {
  return git(['rev-parse', '--is-inside-work-tree'], cwd).code === 0;
}

export interface Worktree {
  path: string;
  branch: string;
}

/** Create a detached worktree on a fresh branch off HEAD. */
export function createWorktree(baseCwd: string, label: string): Worktree {
  const id = shortId(6);
  const branch = `omks/${slugify(label)}-${id}`;
  const path = join(tmpdir(), `omks-wt-${id}`);
  const r = git(['worktree', 'add', '-b', branch, path, 'HEAD'], baseCwd);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.err.trim() || r.out.trim()}`);
  return { path, branch };
}

/** Commit everything in the worktree, then merge it into the base branch. */
export function commitAndMerge(baseCwd: string, wt: Worktree, label: string): { merged: boolean } {
  git(['add', '-A'], wt.path);
  git(
    ['-c', 'user.name=Omakase', '-c', 'user.email=omks@local', 'commit', '-m', `omks: ${label}`, '--allow-empty', '--no-verify'],
    wt.path,
  );
  const m = git(['merge', '--no-edit', '--no-ff', wt.branch], baseCwd);
  if (m.code !== 0) {
    git(['merge', '--abort'], baseCwd);
    return { merged: false };
  }
  return { merged: true };
}

/** Remove the worktree; delete the branch only if it was merged. */
export function removeWorktree(baseCwd: string, wt: Worktree, deleteBranch: boolean): void {
  git(['worktree', 'remove', wt.path, '--force'], baseCwd);
  if (deleteBranch) git(['branch', '-D', wt.branch], baseCwd);
}

/**
 * A serializer for git mutations on one repo. `fn` (the real work) runs
 * concurrently; only the git steps are serialized to avoid index.lock races.
 */
export class GitSerializer {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  }
}
