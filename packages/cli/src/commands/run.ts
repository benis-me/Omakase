import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workspace, Store, PERMISSION_MODES, type Goal, type SuccessCriterion, type PermissionMode } from '@omakase/core';
import { runGoal, crystallize } from '@omakase/engine';
import { parseArgs, type ParsedArgs, flagStr, flagBool } from '../args.ts';
import { openOrInit } from './shared.ts';
import { print, printErr, streamPrinter, exitCodeFor, sym, c, banner } from '../ui.ts';

const SPEC = {
  value: ['workflow', 'provider', 'model', 'cwd', 'max-agents', 'max-rounds', 'concurrency', 'session', 'max-usd', 'max-time', 'save-as', 'permission'],
  repeatable: ['criteria', 'check', 'param'],
  alias: { w: 'workflow', p: 'provider', m: 'model', s: 'session' },
};

/** Prompt the user on the terminal and read one line (for w.ask). */
async function stdinAnswerer(req: { question: string; options?: string[]; default?: string }): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const opts = req.options?.length ? c.dim(` [${req.options.join('/')}]`) : '';
  const def = req.default ? c.dim(` (${req.default})`) : '';
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${c.magenta('?')} ${req.question}${opts}${def} `, resolve));
    return answer.trim() || req.default || req.options?.[0] || '';
  } finally {
    rl.close();
  }
}

const LIMITS = ['max-agents', 'max-rounds', 'concurrency', 'max-usd', 'max-time'] as const;
type Limit = (typeof LIMITS)[number];

/**
 * Read the run's ceilings. A limit flag is a promise about how far a run may
 * go, so an unparseable or non-positive value has to be an error rather than a
 * silent fall back to the default — `--max-agents 0` quietly becoming 64 is the
 * opposite of what was asked for. Zero is rejected rather than honoured because
 * it has no coherent meaning here: it would deadlock `--concurrency` and leave
 * `--max-rounds` with no round to run. Returns the offending flag's name.
 */
function readLimits(args: ParsedArgs): Partial<Record<Limit, number>> | Limit {
  const out: Partial<Record<Limit, number>> = {};
  for (const name of LIMITS) {
    const raw = args.flags[name];
    if (raw === undefined) continue;
    const n = typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n <= 0) return name;
    out[name] = n;
  }
  return out;
}

/** Parse `key=value` params; coerce numbers/booleans. */
function parseParams(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const key = p.slice(0, i);
    const raw = p.slice(i + 1);
    out[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

/**
 * Keep the run: write what just executed back out as a workflow you can run
 * again. Refuses to clobber an existing name — a saved workflow is source you
 * may have edited since, and silently overwriting it would lose that.
 */
function saveRunAsWorkflow(
  saveAs: string,
  runId: string,
  goalText: string,
  workspace: Workspace,
  store: Store,
  json: boolean,
): void {
  const run = store.getRun(runId);
  const built = crystallize({
    name: saveAs,
    goalText,
    events: store.getEvents(runId),
    sourceWorkflow: run?.workflow ?? 'goal',
  });
  if (!built) {
    printErr(c.yellow(`Not saved: the run had no agent steps to crystallise.`));
    return;
  }
  const dir = join(workspace.paths.workflows, built.name);
  if (existsSync(dir)) {
    printErr(c.yellow(`Not saved: a workflow named "${built.name}" already exists at ${dir}.`));
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.ts'), built.script);
  writeFileSync(join(dir, 'WORKFLOW.md'), built.doc);
  if (!json) {
    print(
      `\n${sym.ok} Saved as workflow ${c.cyan(built.name)} ${c.dim(`(${built.stepCount} step(s)${built.phases.length ? ` · ${built.phases.join(' → ')}` : ''})`)}\n` +
        c.dim(`  ${dir}\n  run it: `) +
        c.cyan(`omks run "<goal>" -w ${built.name}`),
    );
  }
}

export async function cmdRun(rawArgs: string[], preset?: { workflow?: string }): Promise<number> {
  const args = parseArgs(rawArgs, SPEC);
  const goalText = args.positionals.join(' ').trim();
  if (!goalText) {
    printErr(`Usage: ${c.cyan('omks run "<goal>"')} [--workflow name] [--provider id] [--check "cmd"]`);
    return 1;
  }

  const limits = readLimits(args);
  if (typeof limits === 'string') {
    printErr(c.red(`--${limits} must be a positive number.`));
    return 1;
  }

  const permission = flagStr(args, 'permission') as PermissionMode | undefined;
  if (permission && !PERMISSION_MODES.includes(permission)) {
    printErr(c.red(`--permission must be one of: ${PERMISSION_MODES.join(', ')}`));
    return 1;
  }

  const cwd = flagStr(args, 'cwd') ?? process.cwd();
  const { workspace, store, created } = openOrInit(cwd);
  if (created) print(c.dim(`Initialized workspace at ${workspace.paths.dir}`));

  const criteria = args.multi['criteria'] ?? [];
  const checks: SuccessCriterion[] = (args.multi['check'] ?? []).map((run) => ({ kind: 'command', run }));
  const params = parseParams(args.multi['param'] ?? []);

  const goal: Goal = {
    text: goalText,
    cwd,
    ...(preset?.workflow || flagStr(args, 'workflow') ? { workflow: preset?.workflow ?? flagStr(args, 'workflow') } : {}),
    ...(flagStr(args, 'provider') ? { provider: flagStr(args, 'provider') } : {}),
    ...(flagStr(args, 'model') ? { model: flagStr(args, 'model') } : {}),
    ...(criteria.length ? { successCriteria: criteria } : {}),
    ...(checks.length ? { checks } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };

  const json = flagBool(args, 'json');
  if (!json) print(banner() + '\n');

  const controller = new AbortController();
  const onSigint = () => {
    printErr(c.yellow('\n⚠ Cancelling… (press Ctrl-C again to force quit)'));
    controller.abort();
    process.once('SIGINT', () => process.exit(130));
  };
  process.on('SIGINT', onSigint);

  try {
    const outcome = await runGoal({
      goal,
      workspace,
      store,
      signal: controller.signal,
      ...(flagStr(args, 'session') ? { sessionId: flagStr(args, 'session') } : {}),
      ...(limits['max-agents'] !== undefined ? { maxAgents: limits['max-agents'] } : {}),
      ...(limits['max-usd'] !== undefined ? { maxUsd: limits['max-usd'] } : {}),
      ...(limits['max-time'] !== undefined ? { maxWallClockMs: limits['max-time'] * 1000 } : {}),
      ...(limits['max-rounds'] !== undefined ? { maxRounds: limits['max-rounds'] } : {}),
      ...(limits['concurrency'] !== undefined ? { maxConcurrent: limits['concurrency'] } : {}),
      ...(permission ? { permission } : {}),
      ...(process.stdin.isTTY && !json ? { ask: stdinAnswerer } : {}),
      onEvent: streamPrinter(json),
    });
    const saveAs = flagStr(args, 'save-as');
    if (saveAs) saveRunAsWorkflow(saveAs, outcome.runId, goalText, workspace, store, json);
    if (!json) {
      const sid = store.getRun(outcome.runId)?.sessionId;
      print(c.dim(`\nrun ${outcome.runId}${sid ? ` · session ${sid}` : ''} · resume: omks resume ${outcome.runId}`));
    }
    return exitCodeFor(outcome.status);
  } catch (err) {
    printErr(c.red(`Error: ${(err as Error).message}`));
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    store.close();
  }
}
