// The omks command dispatcher.

import { cmdInit } from './commands/init.ts';
import { parseArgs } from './args.ts';
import { cmdRun } from './commands/run.ts';
import { cmdResume } from './commands/resume.ts';
import { cmdWorkflow } from './commands/workflow.ts';
import { cmdAgent } from './commands/agent.ts';
import { cmdSession } from './commands/session.ts';
import { cmdRuns } from './commands/runs.ts';
import { cmdConfig } from './commands/config.ts';
import { cmdDoctor } from './commands/doctor.ts';
import { cmdWeb } from './commands/web.ts';
import { cmdMcp } from './commands/mcp.ts';
import { cmdLogs } from './commands/logs.ts';
import { cmdHelp, VERSION } from './commands/help.ts';
import { print, printErr, c } from './ui.ts';

const KNOWN = new Set([
  'init', 'run', 'goal', 'resume', 'workflow', 'wf', 'flow', 'agent', 'agents',
  'providers', 'session', 'sessions', 'runs', 'history', 'config', 'doctor',
  'health', 'tui', 'web', 'mcp', 'logs', 'help', 'version',
]);

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  // Global flags.
  if (command === '--version' || command === '-v' || command === 'version') {
    print(`omks ${VERSION}`);
    return 0;
  }
  if (command === '--help' || command === '-h' || command === 'help' || command === undefined && !process.stdout.isTTY) {
    return cmdHelp();
  }

  try {
    switch (command) {
      case undefined:
      case 'tui':
        return await launchTui(rest);
      case 'init':
        return await cmdInit(parseArgs(rest, {}));
      case 'run':
      case 'goal':
        return await cmdRun(rest);
      case 'resume':
        return await cmdResume(rest);
      case 'workflow':
      case 'wf':
      case 'flow':
        return await cmdWorkflow(rest);
      case 'agent':
      case 'agents':
      case 'providers':
        return await cmdAgent(rest);
      case 'session':
      case 'sessions':
        return await cmdSession(rest);
      case 'runs':
      case 'history':
        return await cmdRuns(rest);
      case 'logs':
        return await cmdLogs(rest);
      case 'config':
        return await cmdConfig(rest);
      case 'doctor':
      case 'health':
        return await cmdDoctor();
      case 'web':
        return await cmdWeb(rest);
      case 'mcp':
        return await cmdMcp();
      default:
        // Unknown first token → treat the whole argv as a goal: `omks "build X"`.
        if (!KNOWN.has(command) && command.length > 0) {
          return await cmdRun(argv);
        }
        printErr(c.red(`Unknown command: ${command}`));
        cmdHelp();
        return 1;
    }
  } catch (err) {
    printErr(c.red(`\nError: ${(err as Error).message}`));
    if (process.env.OMKS_DEBUG) printErr(c.dim((err as Error).stack ?? ''));
    return 1;
  }
}

async function launchTui(rest: string[]): Promise<number> {
  if (!process.stdout.isTTY) {
    printErr(c.yellow('No interactive terminal — showing help instead.\n'));
    return cmdHelp();
  }
  try {
    // Computed specifier: keeps the TUI's OpenTUI-JSX types out of the root
    // typecheck program (the TUI is typechecked separately with its own tsconfig).
    const tuiModule = '@omakase/tui';
    const mod = (await import(tuiModule)) as {
      launchTUI?: (opts?: { initialGoal?: string }) => Promise<number>;
    };
    if (!mod.launchTUI) throw new Error('TUI not available');
    const initialGoal = rest.filter((a) => !a.startsWith('-')).join(' ').trim();
    return await mod.launchTUI(initialGoal ? { initialGoal } : {});
  } catch (err) {
    printErr(c.yellow(`TUI unavailable: ${(err as Error).message}`));
    printErr(c.dim('Install the TUI deps (bun install) or use the headless commands.\n'));
    return cmdHelp();
  }
}
