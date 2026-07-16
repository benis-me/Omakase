import { parseArgs, flagNum } from '../args.ts';
import { openContext } from '../context.ts';
import { print, printErr, c, sym } from '../ui.ts';

const STATUS_COLOR: Record<string, (s: string) => string> = {
  succeeded: c.green,
  failed: c.red,
  cancelled: c.yellow,
  running: c.cyan,
  paused: c.yellow,
  pending: c.dim,
};

export async function cmdRuns(rawArgs: string[]): Promise<number> {
  const sub = rawArgs[0] === 'show' ? 'show' : 'list';
  const args = parseArgs(sub === 'show' ? rawArgs.slice(1) : rawArgs, { value: ['limit'] });
  const { store } = openContext();

  if (sub === 'show') {
    const id = args.positionals[0];
    if (!id) {
      printErr('Usage: omks runs show <runId>');
      return 1;
    }
    const run = store.getRun(id);
    if (!run) {
      printErr(c.red(`No such run: ${id}`));
      return 1;
    }
    const col = STATUS_COLOR[run.status] ?? c.dim;
    print(`\n${c.bold(run.title)}`);
    print(`  ${col(run.status)}  ${c.dim('·')}  workflow ${c.cyan(run.workflow)}  ${c.dim('·')}  ${run.spentAgents} agent(s)  ${c.dim('·')}  $${run.spentCostUsd.toFixed(4)}`);
    if (run.summary) print(`  ${run.summary}`);
    const reports = store.listReports(id);
    if (reports.length) {
      print(c.bold('\n  Reports'));
      for (const r of reports) print(`    ${sym.bullet} ${c.dim(r.kind)} ${r.title} — ${r.summary.slice(0, 80)}`);
    }
    const events = store.getEvents(id);
    print(c.dim(`\n  ${events.length} events · resume with: omks resume ${id}`));
    return 0;
  }

  const limit = flagNum(args, 'limit') ?? 20;
  const runs = store.listRuns({ limit });
  if (!runs.length) {
    print(c.dim('No runs yet. Try: omks run "your goal"'));
    return 0;
  }
  print(c.bold('\nRecent runs'));
  for (const r of runs) {
    const col = STATUS_COLOR[r.status] ?? c.dim;
    const when = new Date(r.updatedAt).toLocaleString();
    print(`  ${c.dim(r.id)}  ${col(r.status.padEnd(9))}  ${c.cyan(r.workflow.padEnd(10))}  ${c.dim(when)}\n    ${r.title.slice(0, 76)}`);
  }
  return 0;
}
