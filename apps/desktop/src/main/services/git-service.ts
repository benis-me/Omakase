/**
 * Read git status (branch, dirty, ahead/behind, change count) for a directory.
 * Ported from DevDock. Runner injectable for tests; parsers are pure.
 */
import { execFile } from 'node:child_process';
import type { GitInfo } from '@shared/types';

export type GitRunner = (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>;

const defaultRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 4000 }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout ?? '').toString() });
    });
  });

export function parsePorcelain(out: string): number {
  return out.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

/** Parse `rev-list --count --left-right @{upstream}...HEAD` → "<behind>\t<ahead>". */
export function parseAheadBehind(out: string): { ahead: number; behind: number } {
  const m = out.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return { ahead: 0, behind: 0 };
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

export class GitService {
  constructor(private readonly run: GitRunner = defaultRunner) {}

  /** Status for `cwd`, or null if it is not a git work tree. */
  async info(cwd: string): Promise<GitInfo | null> {
    const inside = await this.run(['rev-parse', '--is-inside-work-tree'], cwd);
    if (!inside.ok || inside.out.trim() !== 'true') return null;
    const [branchR, statusR, abR] = await Promise.all([
      this.run(['branch', '--show-current'], cwd),
      this.run(['status', '--porcelain'], cwd),
      this.run(['rev-list', '--count', '--left-right', '@{upstream}...HEAD'], cwd),
    ]);
    const branch = branchR.ok ? branchR.out.trim() || null : null;
    const changes = statusR.ok ? parsePorcelain(statusR.out) : 0;
    const { ahead, behind } = abR.ok ? parseAheadBehind(abR.out) : { ahead: 0, behind: 0 };
    return { branch, dirty: changes > 0, changes, ahead, behind };
  }

  /** Working-tree diff vs HEAD (what a run changed). '' if clean or not a repo. */
  async diff(cwd: string): Promise<string> {
    const inside = await this.run(['rev-parse', '--is-inside-work-tree'], cwd);
    if (!inside.ok || inside.out.trim() !== 'true') return '';
    const head = await this.run(['diff', 'HEAD'], cwd);
    if (head.ok) return head.out;
    // No commit yet (HEAD invalid) — fall back to the unstaged diff.
    const unstaged = await this.run(['diff'], cwd);
    return unstaged.ok ? unstaged.out : '';
  }
}
