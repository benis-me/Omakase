import { resumeRun } from '@omakase/engine';
import { parseArgs, flagBool } from '../args.ts';
import { openContext } from '../context.ts';
import { print, printErr, renderEvent, c, banner } from '../ui.ts';

export async function cmdResume(rawArgs: string[]): Promise<number> {
  const args = parseArgs(rawArgs, {});
  const runId = args.positionals[0];
  if (!runId) {
    printErr(`Usage: ${c.cyan('omks resume <runId>')}  (see ${c.cyan('omks runs')})`);
    return 1;
  }
  const { workspace, store } = openContext();
  const prior = store.getRun(runId);
  if (!prior) {
    printErr(c.red(`No such run: ${runId}`));
    return 1;
  }
  const json = flagBool(args, 'json');
  if (!json) print(banner() + c.dim(`  resuming ${runId}\n`));

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  try {
    const outcome = await resumeRun(runId, {
      workspace,
      store,
      signal: controller.signal,
      onEvent: (e) => {
        if (json) print(JSON.stringify(e));
        else {
          const line = renderEvent(e);
          if (line !== null) print(line);
        }
      },
    });
    return outcome.status === 'succeeded' ? 0 : 1;
  } catch (err) {
    printErr(c.red(`Error: ${(err as Error).message}`));
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    store.close();
  }
}
