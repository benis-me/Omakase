import { createInterface } from 'node:readline';
import { Workspace, Store, type Goal, type SuccessCriterion } from '@omakase/core';
import { runGoal } from '@omakase/engine';
import { parseArgs, type ParsedArgs, flagStr, flagNum, flagBool } from '../args.ts';
import { openOrInit } from './shared.ts';
import { print, printErr, renderEvent, c, banner } from '../ui.ts';

const SPEC = {
  value: ['workflow', 'provider', 'model', 'cwd', 'max-agents', 'max-rounds', 'concurrency', 'session', 'max-usd', 'max-time'],
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

export async function cmdRun(rawArgs: string[], preset?: { workflow?: string }): Promise<number> {
  const args = parseArgs(rawArgs, SPEC);
  const goalText = args.positionals.join(' ').trim();
  if (!goalText) {
    printErr(`Usage: ${c.cyan('omks run "<goal>"')} [--workflow name] [--provider id] [--check "cmd"]`);
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
      ...(flagNum(args, 'max-agents') ? { maxAgents: flagNum(args, 'max-agents') } : {}),
      ...(flagNum(args, 'max-usd') ? { maxUsd: flagNum(args, 'max-usd') } : {}),
      ...(flagNum(args, 'max-time') ? { maxWallClockMs: flagNum(args, 'max-time')! * 1000 } : {}),
      ...(flagNum(args, 'max-rounds') ? { maxRounds: flagNum(args, 'max-rounds') } : {}),
      ...(flagNum(args, 'concurrency') ? { maxConcurrent: flagNum(args, 'concurrency') } : {}),
      ...(process.stdin.isTTY && !json ? { ask: stdinAnswerer } : {}),
      onEvent: (e) => {
        if (json) print(JSON.stringify(e));
        else {
          const line = renderEvent(e);
          if (line !== null) print(line);
        }
      },
    });
    if (!json) {
      const sid = store.getRun(outcome.runId)?.sessionId;
      print(c.dim(`\nrun ${outcome.runId}${sid ? ` · session ${sid}` : ''} · resume: omks resume ${outcome.runId}`));
    }
    return outcome.status === 'succeeded' ? 0 : outcome.status === 'cancelled' ? 130 : 1;
  } catch (err) {
    printErr(c.red(`Error: ${(err as Error).message}`));
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    store.close();
  }
}
