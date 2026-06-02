// @omakase/cli — public entrypoint.
import { CORE_VERSION } from '@omakase/core';

export const CLI_VERSION = '0.1.0';

/**
 * CLI entrypoint. The real command router is wired in the CLI slice; during
 * scaffolding this prints the resolved package versions so the bin launcher
 * and `pnpm --filter @omakase/cli omakase` path can be exercised end to end.
 */
export async function main(argv: string[]): Promise<void> {
  const [command] = argv;
  if (command === '--version' || command === undefined) {
    process.stdout.write(`omakase ${CLI_VERSION} (core ${CORE_VERSION})\n`);
    return;
  }
  process.stdout.write(`omakase: unknown command "${command}"\n`);
}
