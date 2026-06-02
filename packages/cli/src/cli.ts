/**
 * The omakase CLI. Three commands — `agents`, `run`, `tui` — all built on top
 * of @omakase/core (never reaching around it). Dependencies (output sink,
 * runtime, orchestrator factory) are injectable so the commands are testable
 * without real binaries, models, or a TTY.
 */
import {
  createAgentRuntime,
  type AgentRuntime,
  type DetectionOptions,
} from '@omakase/daemon';
import {
  MemoryRunStore,
  Orchestrator,
  type OrchestrationRequest,
  type WorkMode,
} from '@omakase/core';
import { formatAgentsTable, formatRunSummary } from './render.js';
import { buildRunView, formatEventLine } from './view-model.js';

export const CLI_VERSION = '0.1.0';

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  options: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      options[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0], positionals, options };
}

export interface CliDeps {
  write?: (text: string) => void;
  error?: (text: string) => void;
  createRuntime?: () => AgentRuntime;
  createOrchestrator?: (runtime: AgentRuntime, mode: WorkMode) => Orchestrator;
  detectionOptions?: DetectionOptions;
  /** Launch the TUI; injected so headless tests don't import Ink. */
  launchTui?: (opts: {
    task?: string;
    cwd?: string;
    mode: WorkMode;
    runtime: AgentRuntime;
    orchestrator: Orchestrator;
  }) => Promise<void>;
}

function resolveMode(value: unknown): WorkMode {
  return value === 'max-power' || value === 'custom' ? value : 'normal';
}

const HELP = `omakase — agent runtime + multi-agent orchestration

Usage:
  omakase agents [--json]              List detected agent CLIs
  omakase run "<task>" [options]       Run a task through the orchestrator
  omakase tui ["<task>"] [options]     Open the interactive TUI
  omakase --version

Options:
  --mode <max-power|normal|custom>     Work mode (default: normal)
  --cwd <path>                         Working directory (default: cwd)
  --json                               Machine-readable output (agents/run)
`;

export interface Cli {
  main(argv: string[]): Promise<number>;
}

export function createCli(deps: CliDeps = {}): Cli {
  const write = deps.write ?? ((t: string) => process.stdout.write(`${t}\n`));
  const error = deps.error ?? ((t: string) => process.stderr.write(`${t}\n`));
  const createRuntime =
    deps.createRuntime ?? (() => createAgentRuntime({ fallbackToBuiltin: true }));
  const createOrchestrator =
    deps.createOrchestrator ??
    ((runtime: AgentRuntime, mode: WorkMode) =>
      new Orchestrator({ runtime, store: new MemoryRunStore(), defaultMode: mode }));

  async function agentsCommand(options: ParsedArgs['options']): Promise<number> {
    const runtime = createRuntime();
    const agents = await runtime.detect(deps.detectionOptions);
    if (options.json) {
      write(JSON.stringify(agents, null, 2));
    } else {
      write(formatAgentsTable(agents));
    }
    return 0;
  }

  async function runCommand(task: string, options: ParsedArgs['options']): Promise<number> {
    if (!task.trim()) {
      error('omakase run: a task description is required, e.g. omakase run "summarize this project"');
      return 1;
    }
    const mode = resolveMode(options.mode);
    const runtime = createRuntime();
    const orchestrator = createOrchestrator(runtime, mode);
    const request: OrchestrationRequest = {
      prompt: task,
      cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
      mode,
    };
    const handle = orchestrator.start(request);
    for await (const event of handle.events) {
      if (options.json) {
        write(JSON.stringify(event));
      } else {
        const line = formatEventLine(event);
        if (line) write(line);
      }
    }
    const result = await handle.result;
    if (!options.json) {
      write('');
      write(formatRunSummary(buildRunView(result.events, mode)));
      const answers = result.plan.tasks
        .filter((t) => t.role === 'worker' && t.result?.output)
        .map((t) => t.result!.output.trim())
        .filter(Boolean);
      if (answers.length > 0) {
        write('');
        write('── Output ──');
        write(answers.join('\n\n'));
      }
    }
    return result.status === 'succeeded' ? 0 : 1;
  }

  async function tuiCommand(task: string, options: ParsedArgs['options']): Promise<number> {
    const mode = resolveMode(options.mode);
    const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
    const runtime = createRuntime();
    const orchestrator = createOrchestrator(runtime, mode);
    const launch =
      deps.launchTui ??
      (async (opts) => {
        const { launchTui } = await import('./tui/index.js');
        await launchTui(opts);
      });
    await launch({ task: task.trim() || undefined, cwd, mode, runtime, orchestrator });
    return 0;
  }

  return {
    async main(argv: string[]): Promise<number> {
      const { command, positionals, options } = parseArgs(argv);
      try {
        switch (command) {
          case undefined:
            if (options.version || options.v) {
              write(`omakase ${CLI_VERSION}`);
              return 0;
            }
            write(HELP);
            return 0;
          case 'help':
            write(HELP);
            return 0;
          case 'version':
            write(`omakase ${CLI_VERSION}`);
            return 0;
          case 'agents':
            return await agentsCommand(options);
          case 'run':
            return await runCommand(positionals.slice(1).join(' '), options);
          case 'tui':
          case 'dev':
            return await tuiCommand(positionals.slice(1).join(' '), options);
          default:
            if (options.version) {
              write(`omakase ${CLI_VERSION}`);
              return 0;
            }
            error(`omakase: unknown command "${command}". Run "omakase help".`);
            return 1;
        }
      } catch (err) {
        error(`omakase: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    },
  };
}
