/**
 * Self-improvement support: the core can run on its own project, but only
 * behind guardrails. Before any self-modifying run we check `git status` and
 * refuse to proceed on a dirty workspace (so we never clobber the user's
 * uncommitted work), frame the work as an explicit diagnose → plan → modify →
 * test → retrospective pipeline, and produce a change summary afterwards.
 */
import { createNodeTransport, execCollect, type Transport } from '@omakase/daemon';
import type { OrchestrationRequest } from './types.js';

export interface GitStatus {
  isRepo: boolean;
  clean: boolean;
  changedFiles: string[];
  branch: string | null;
}

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; code: number | null }>;

export function createGitRunner(transport: Transport = createNodeTransport()): GitRunner {
  return async (args, cwd) => {
    const result = await execCollect(
      transport,
      { command: 'git', args, cwd },
      { timeoutMs: 5000 },
    );
    return { stdout: result.stdout, code: result.exit.code };
  };
}

function parsePorcelainLine(line: string): string | null {
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) return null;
  const path = trimmed.length > 3 ? trimmed.slice(3) : trimmed;
  const renameIdx = path.indexOf(' -> ');
  return (renameIdx !== -1 ? path.slice(renameIdx + 4) : path).trim();
}

export async function readGitStatus(cwd: string, run: GitRunner): Promise<GitStatus> {
  try {
    // Distinguish "not a git repo" from "git failed". A genuine non-repo lets
    // self-modify proceed; any other failure (held index.lock, perms, corruption)
    // must fail closed — treat it as a dirty repo so we never clobber changes.
    const inside = await run(['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return { isRepo: false, clean: true, changedFiles: [], branch: null };
    }
    const status = await run(['status', '--porcelain'], cwd);
    if (status.code !== 0) {
      return { isRepo: true, clean: false, changedFiles: [], branch: null };
    }
    const changedFiles = status.stdout
      .split('\n')
      .map(parsePorcelainLine)
      .filter((p): p is string => Boolean(p));
    let branch: string | null = null;
    try {
      const b = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      if (b.code === 0) branch = b.stdout.trim() || null;
    } catch {
      /* ignore */
    }
    return { isRepo: true, clean: changedFiles.length === 0, changedFiles, branch };
  } catch {
    // Could not run git at all (missing binary, spawn failure): we cannot
    // verify safety, so fail closed.
    return { isRepo: true, clean: false, changedFiles: [], branch: null };
  }
}

export class WorkspaceDirtyError extends Error {
  readonly changedFiles: string[];
  constructor(changedFiles: string[]) {
    super(
      `Workspace has ${changedFiles.length} uncommitted change(s); refusing to self-modify. ` +
        'Commit or stash first, or pass { allowDirty: true }.',
    );
    this.name = 'WorkspaceDirtyError';
    this.changedFiles = changedFiles;
  }
}

export interface SelfImproveGuardOptions {
  allowDirty?: boolean;
}

/** Throw {@link WorkspaceDirtyError} if the repo has uncommitted changes. */
export async function assertSafeWorkspace(
  cwd: string,
  run: GitRunner,
  options: SelfImproveGuardOptions = {},
): Promise<GitStatus> {
  const status = await readGitStatus(cwd, run);
  if (status.isRepo && !status.clean && !options.allowDirty) {
    throw new WorkspaceDirtyError(status.changedFiles);
  }
  return status;
}

export const SELF_IMPROVE_PHASES = [
  'diagnose',
  'plan',
  'modify',
  'test',
  'retrospective',
] as const;
export type SelfImprovePhase = (typeof SELF_IMPROVE_PHASES)[number];

/** Frame a self-improvement goal as an explicit guarded pipeline request. */
export function buildSelfImproveRequest(goal: string, cwd?: string): OrchestrationRequest {
  const prompt = [
    `Self-improvement goal: ${goal}`,
    'Work through these phases, one task each:',
    '1. Diagnose the root cause or opportunity with concrete evidence.',
    '2. Plan the change and call out its risks and blast radius.',
    '3. Modify the code to implement the change.',
    '4. Test: run the test suite and verify it passes.',
    '5. Retrospective: summarize what changed and what to watch next.',
  ].join('\n');
  return {
    prompt,
    ...(cwd ? { cwd } : {}),
    metadata: { kind: 'self-improvement', goal },
  };
}

export function summarizeChanges(before: GitStatus, after: GitStatus): string {
  const beforeSet = new Set(before.changedFiles);
  const newlyChanged = after.changedFiles.filter((f) => !beforeSet.has(f));
  const lines = [
    `Branch: ${after.branch ?? '(unknown)'}`,
    `Files changed during this session: ${newlyChanged.length}`,
  ];
  for (const file of newlyChanged.slice(0, 50)) lines.push(`  - ${file}`);
  return lines.join('\n');
}

export interface PrepareSelfImprovementOptions {
  gitRunner?: GitRunner;
  allowDirty?: boolean;
}

/**
 * Pre-flight a self-improvement run: assert the workspace is safe and return
 * the framed orchestration request plus the baseline git status.
 */
export async function prepareSelfImprovement(
  cwd: string,
  goal: string,
  options: PrepareSelfImprovementOptions = {},
): Promise<{ request: OrchestrationRequest; status: GitStatus }> {
  const run = options.gitRunner ?? createGitRunner();
  const status = await assertSafeWorkspace(cwd, run, { allowDirty: options.allowDirty });
  return { request: buildSelfImproveRequest(goal, cwd), status };
}
