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
export type { RunView, RunViewStatus, TaskView, PhaseView } from './view-model.js';

// The serve composition: a file-backed Supervisor host. Exported so downstream
// code (and tests) can spin up the same daemon the CLI does.
export { createServer } from './serve.js';
export type { ServeConfig, ServeDeps, Server } from './serve.js';

// The detached-daemon client seam — the same pieces the TUI is built on, so any
// client (e.g. the Electron desktop app) can drive a project's runs over the
// filesystem protocol without owning an Orchestrator.
export { RunControllerClient } from './run-client.js';
export type { RunSummary, RunControllerClientOptions } from './run-client.js';
export {
  ensureDaemon,
  daemonStatus,
  stopDaemon,
  isDaemonAlive,
  writeDaemonInfo,
  touchHeartbeat,
} from './daemon-control.js';
export type {
  DaemonInfo,
  DaemonStatus,
  SpawnedDaemon,
  DaemonSpawn,
  EnsureDaemonDeps,
  EnsureDaemonOptions,
} from './daemon-control.js';

/** Process entrypoint used by bin/omakase.mjs. Returns the desired exit code. */
export async function main(argv: string[]): Promise<void> {
  const code = await createCli().main(argv);
  if (code !== 0) process.exitCode = code;
}
