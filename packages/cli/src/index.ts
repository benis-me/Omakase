// @omakase/cli — public entrypoint + library surface.
import { createCli } from './cli.js';

export const CLI_VERSION = '0.1.0';

export { createCli, parseArgs } from './cli.js';
export type { Cli, CliDeps, ParsedArgs } from './cli.js';
export { formatAgentsTable, formatRunSummary } from './render.js';
export {
  initialRunView,
  reduceRunView,
  buildRunView,
  formatEventLine,
} from './view-model.js';
export type { RunView, RunViewStatus, TaskView } from './view-model.js';

/** Process entrypoint used by bin/omakase.mjs. Returns the desired exit code. */
export async function main(argv: string[]): Promise<void> {
  const code = await createCli().main(argv);
  if (code !== 0) process.exitCode = code;
}
