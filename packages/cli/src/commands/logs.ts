import { sleep } from '@omakase/core';
import { parseArgs, flagBool } from '../args.ts';
import { openContext } from '../context.ts';
import { print, printErr, renderEvent, c } from '../ui.ts';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export async function cmdLogs(rawArgs: string[]): Promise<number> {
  const args = parseArgs(rawArgs, { alias: { f: 'follow' } });
  const runId = args.positionals[0];
  if (!runId) {
    printErr(`Usage: ${c.cyan('omks logs <runId> [-f]')}`);
    return 1;
  }
  const { store } = openContext();
  const run = store.getRun(runId);
  if (!run) {
    printErr(c.red(`No such run: ${runId}`));
    return 1;
  }

  let lastSeq = 0;
  const dump = () => {
    for (const e of store.getEvents(runId, lastSeq)) {
      lastSeq = e.seq;
      const line = renderEvent(e);
      if (line !== null) print(line);
    }
  };

  dump();
  if (!flagBool(args, 'follow')) return 0;

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  try {
    while (!TERMINAL.has(store.getRun(runId)?.status ?? 'failed')) {
      if (controller.signal.aborted) break;
      await sleep(500, controller.signal).catch(() => {});
      dump();
    }
    dump();
  } finally {
    store.close();
  }
  return 0;
}
