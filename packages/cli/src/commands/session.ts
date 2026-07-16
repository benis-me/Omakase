import { parseArgs } from '../args.ts';
import { openContext } from '../context.ts';
import { print, printErr, c, sym } from '../ui.ts';

export async function cmdSession(rawArgs: string[]): Promise<number> {
  const sub = rawArgs[0] ?? 'list';
  const args = parseArgs(rawArgs.slice(1), {});
  const { store } = openContext();

  if (sub === 'show') {
    const id = args.positionals[0];
    if (!id) return usage();
    const s = store.getSession(id);
    if (!s) {
      printErr(c.red(`No such session: ${id}`));
      return 1;
    }
    print(`\n${c.bold(s.title)}  ${c.dim(s.id)}`);
    if (s.rollingSummary) print(`  ${s.rollingSummary}`);
    print(c.bold('\n  Runs'));
    for (const rid of s.runIds) {
      const run = store.getRun(rid);
      if (run) print(`    ${sym.bullet} ${c.dim(rid)}  ${run.status}  ${run.title.slice(0, 60)}`);
    }
    return 0;
  }

  const sessions = store.listSessions();
  if (!sessions.length) {
    print(c.dim('No sessions yet.'));
    return 0;
  }
  print(c.bold('\nSessions'));
  for (const s of sessions) {
    print(`  ${c.dim(s.id)}  ${c.bold(s.title.slice(0, 50))}  ${c.dim(`${s.runIds.length} run(s)`)}`);
  }
  return 0;

  function usage(): number {
    printErr('Usage: omks session [list|show <id>]');
    return 1;
  }
}
