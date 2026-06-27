/**
 * The omakase CLI: a headless entrypoint — `agents`, `run`, `workflow`, `serve`,
 * `wiki`, `daemon` — all built on top of @omakase/core (never reaching around
 * it) and persisting through the `.omks/` workspace (@omakase/storage).
 * Dependencies (output sink, runtime, orchestrator factory, workspace) are
 * injectable so the commands are testable without real binaries or models.
 */
import {
  createAgentRuntime,
  type AgentRuntime,
  type DetectionOptions,
} from '@omakase/daemon';
import {
  BunWorkflowScriptRunner,
  DynamicWorkflowRun,
  Orchestrator,
  ProjectWiki,
  createModelPolicy,
  renderWikiPagesMarkdown,
  type OrchestrationRequest,
  type WorkMode,
  type WikiEntryKind,
} from '@omakase/core';
import { openWorkspace, authoredSpecCriteriaSince, type OpenWorkspace } from '@omakase/storage';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type ServeConfig } from './serve.js';
import {
  daemonStatus,
  stopDaemon,
  touchHeartbeat,
  writeDaemonInfo,
} from './daemon-control.js';
import { formatAgentsTable, formatRunSummary } from './render.js';
import { buildRunView, formatEventLine } from './view-model.js';

export const CLI_VERSION = '0.1.0';

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  options: Record<string, string | boolean>;
}

/** Flags that never take a value — they must not consume the following token. */
const BOOLEAN_FLAGS = new Set(['offline', 'json', 'watch', 'version', 'v', 'help', 'h']);
/** Flags that always take the next token as their value (even a `-`-leading one). */
const VALUE_FLAGS = new Set([
  'mode',
  'agent',
  'cwd',
  'max-tokens',
  'max-cost',
  'interval',
  'concurrency',
  'max-agents',
  'runs-dir',
  'queue-dir',
  'body',
  'kind',
  'tags',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  let optionsEnded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (optionsEnded) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      // Everything after `--` is positional, so a task prompt can start with a dash.
      optionsEnded = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key)) {
        // A known boolean flag must never swallow the following positional
        // (e.g. `run --offline "summarize"` must keep "summarize" as the task).
        options[key] = true;
      } else if (VALUE_FLAGS.has(key)) {
        if (next !== undefined) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = true;
        }
      } else if (next !== undefined && !next.startsWith('-')) {
        // Unknown long flag: keep the permissive "consume a value-looking token".
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
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
  createOrchestrator?: (runtime: AgentRuntime, mode: WorkMode, options?: { cwd?: string }) => Orchestrator;
  detectionOptions?: DetectionOptions;
  /** Open the `.omks` workspace for a project; injected so tests stay headless. */
  openWorkspace?: (cwd: string) => OpenWorkspace;
}

function resolveMode(value: unknown): WorkMode {
  return value === 'max-power' || value === 'custom' ? value : 'normal';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function currentDaemonSourceKey(): string {
  return `${process.execPath}|${process.argv[1] ?? ''}`;
}

interface AgentBudget {
  agentOverride?: string;
  budget?: { maxTokens?: number; maxCostUsd?: number };
  error?: string;
}

/** Resolve --offline/--agent and --max-tokens/--max-cost, validating numbers. */
function parseAgentBudget(options: ParsedArgs['options']): AgentBudget {
  if (options.agent === true) {
    return { error: '--agent requires an agent id, e.g. --agent claude' };
  }
  const agentOverride =
    typeof options.agent === 'string' ? options.agent : options.offline ? 'builtin' : undefined;
  const budget: { maxTokens?: number; maxCostUsd?: number } = {};
  const numericFlags = [
    ['max-tokens', 'maxTokens'],
    ['max-cost', 'maxCostUsd'],
  ] as const;
  for (const [flag, key] of numericFlags) {
    const raw = options[flag];
    if (raw === undefined) continue;
    const n = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(n) || n <= 0) {
      return { error: `--${flag} must be a positive number` };
    }
    budget[key] = n;
  }
  const hasBudget = budget.maxTokens !== undefined || budget.maxCostUsd !== undefined;
  return { ...(agentOverride ? { agentOverride } : {}), ...(hasBudget ? { budget } : {}) };
}

const HELP = `omakase — agent runtime + multi-agent orchestration

Usage:
  omakase agents [--json]              List detected agent CLIs
  omakase run "<task>" [options]       Run a task through the orchestrator
  omakase workflow run <script.js>     Run a JavaScript dynamic workflow script
  omakase serve ["<task>"...] [opts]   Supervise a queue of runs (24/7), resuming
                                       anything left unfinished. Reads task files
                                       from .omakase/queue. --watch to keep polling.
  omakase wiki [--cwd]                 Print the generated/editable project wiki
  omakase wiki add <title> [opts]      Add a manual wiki entry and refresh pages
  omakase daemon status|stop [--cwd]   Inspect or stop the project's run daemon
  omakase --version

Options:
  --mode <max-power|normal|custom>     Work mode (default: normal)
  --agent <id>                         Force a specific agent for every role
  --offline                            Force the built-in agent (no model calls)
  --max-tokens <n>                     Stop the run after ~n tokens are spent
  --max-cost <usd>                     Stop the run after ~usd is spent
  --watch [--interval <ms>]            (serve) keep polling the queue
  --concurrency <n>                    (serve) runs to drive in parallel
  --max-agents <n>                     (workflow) max agent invocations
  --kind <note|fact|decision|risk>     (wiki add) entry kind (default: note)
  --body <text>                        (wiki add) entry body
  --tags <a,b>                         (wiki add) additional tags
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
    deps.createRuntime ??
    (() => createAgentRuntime({ fallbackToBuiltin: true, detectionCacheTtlMs: 10_000 }));
  // The `.omks` workspace seam. Real commands persist runs + knowledge to
  // `<cwd>/.omks/omks.db` (and git-friendly markdown under `.omks/memory`);
  // tests inject a fake to stay headless.
  const resolveWorkspace = (cwd: string): OpenWorkspace =>
    (deps.openWorkspace ?? openWorkspace)(cwd);

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

  function parseWikiKind(value: string | boolean | undefined): WikiEntryKind | null {
    if (value === undefined || value === false || value === true) return 'note';
    if (value === 'note' || value === 'fact' || value === 'decision' || value === 'risk') return value;
    return null;
  }

  function normalizeWikiTags(tags: readonly string[] = []): string[] {
    return [...new Set(['knowledge', 'manual', ...tags.map((tag) => tag.trim()).filter(Boolean)])];
  }

  function parseWikiTags(value: string | boolean | undefined): string[] {
    const userTags = typeof value === 'string' ? value.split(',') : [];
    return normalizeWikiTags(userTags);
  }

  async function wikiCommand(positionals: string[], options: ParsedArgs['options']): Promise<number> {
    const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
    const sub = positionals[1];
    // Validate the subcommand and its arguments BEFORE opening the workspace, so
    // a usage error doesn't scaffold a `.omks` dir as a side effect.
    if (sub && sub !== 'add' && sub !== 'show') {
      error(`omakase wiki: unknown subcommand "${sub}"`);
      return 1;
    }
    if (sub === 'add') {
      const title = positionals.slice(2).join(' ').replace(/\s+/g, ' ').trim();
      if (!title) {
        error('omakase wiki add: a title is required');
        return 1;
      }
      const kind = parseWikiKind(options.kind);
      if (!kind) {
        error('omakase wiki add: --kind must be note, fact, decision, or risk');
        return 1;
      }
      const ws = resolveWorkspace(cwd);
      const store = ws.knowledgeStore;
      try {
        const snapshot = (await store.loadWiki()) ?? { entries: [] };
        const wiki = ProjectWiki.fromJSON(snapshot);
        const entry = wiki.add(kind, {
          title,
          body: typeof options.body === 'string' ? options.body : '',
          tags: parseWikiTags(options.tags),
          source: `manual:${Date.now()}`,
        });
        if (store.mergeWiki) await store.mergeWiki([entry]);
        else await store.saveWiki(wiki.toJSON());
        write(`wiki: added ${kind} "${entry.title}"`);
        return 0;
      } finally {
        ws.close();
      }
    }

    const ws = resolveWorkspace(cwd);
    const store = ws.knowledgeStore;
    try {
      const pages = await store.loadWikiPages();
      if (pages.length > 0) {
        write(renderWikiPagesMarkdown(pages));
        return 0;
      }
      const wiki = await store.loadWiki();
      write(wiki ? ProjectWiki.fromJSON(wiki).toMarkdown() : '# Project Knowledge Base');
      return 0;
    } finally {
      ws.close();
    }
  }

  /** Stream a run's events, print its summary, and return its exit code. */
  async function driveRun(
    orchestrator: Orchestrator,
    request: OrchestrationRequest,
    mode: WorkMode,
    options: ParsedArgs['options'],
  ): Promise<number> {
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
      if (result.spentTokens > 0 || result.spentCostUsd > 0) {
        write(`Spent: ${result.spentTokens} tokens, $${result.spentCostUsd.toFixed(4)}`);
      }
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

  async function runCommand(task: string, options: ParsedArgs['options']): Promise<number> {
    if (!task.trim()) {
      error('omakase run: a task description is required, e.g. omakase run "summarize this project"');
      return 1;
    }
    const mode = resolveMode(options.mode);
    const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
    const runtime = createRuntime();
    // --offline / --agent <id> force every role onto one agent (the built-in by
    // default), so a run completes with no model calls and no installed CLIs.
    const ab = parseAgentBudget(options);
    if (ab.error) {
      error(`omakase run: ${ab.error}`);
      return 1;
    }
    const { agentOverride, budget } = ab;
    const request: OrchestrationRequest = {
      prompt: task,
      cwd,
      mode: agentOverride ? 'custom' : mode,
    };

    // The injected-test path: a fake orchestrator factory, no override/budget.
    // Keep this purely in-memory so headless tests touch no filesystem.
    if (deps.createOrchestrator && !agentOverride && !budget) {
      return driveRun(deps.createOrchestrator(runtime, mode, { cwd }), request, mode, options);
    }

    // Every real run persists to the project's `.omks` workspace: runs land in
    // `omks.db`, knowledge renders to `.omks/memory/`.
    const ws = resolveWorkspace(cwd);
    const startedAt = Date.now();
    try {
      const orchestrator = new Orchestrator({
        runtime,
        store: ws.runStore,
        knowledgeStore: ws.knowledgeStore,
        defaultMode: agentOverride ? 'custom' : mode,
        ...(agentOverride
          ? { policy: createModelPolicy('custom', { custom: { default: { agentId: agentOverride } } }) }
          : {}),
        ...(budget ? { budget } : {}),
        // Hold the run to any spec the agent authors mid-flight.
        authoredSpecCriteria: () => authoredSpecCriteriaSince(ws.root, startedAt),
        ...(deps.detectionOptions ? { detectionOptions: deps.detectionOptions } : {}),
      });
      return await driveRun(orchestrator, request, mode, options);
    } finally {
      ws.close();
    }
  }

  function serveConfig(options: ParsedArgs['options'], ab: AgentBudget): ServeConfig {
    const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
    return {
      cwd,
      runsDir: typeof options['runs-dir'] === 'string' ? options['runs-dir'] : path.join(cwd, '.omakase', 'runs'),
      queueDir: typeof options['queue-dir'] === 'string' ? options['queue-dir'] : path.join(cwd, '.omakase', 'queue'),
      concurrency: Number(options.concurrency) || 1,
      mode: resolveMode(options.mode),
      ...(ab.agentOverride ? { agentOverride: ab.agentOverride } : {}),
      ...(ab.budget ? { budget: ab.budget } : {}),
      ...(deps.detectionOptions ? { detectionOptions: deps.detectionOptions } : {}),
    };
  }

  async function serveCommand(tasks: string[], options: ParsedArgs['options']): Promise<number> {
    const ab = parseAgentBudget(options);
    if (ab.error) {
      error(`omakase serve: ${ab.error}`);
      return 1;
    }
    const config = serveConfig(options, ab);
    const server = createServer(config, {
      write,
      ...(deps.createRuntime ? { createRuntime: deps.createRuntime } : {}),
    });
    for (const task of tasks) if (task.trim()) server.supervisor.enqueue({ prompt: task, cwd: config.cwd });

    if (options.watch) {
      const intervalMs = Number(options.interval) || 2000;
      write(`omakase serve: watching ${config.queueDir} every ${intervalMs}ms (Ctrl-C to stop)`);
      // Register as the project's daemon so a TUI/desktop client can discover and
      // attach to it (and not spawn a second one).
      await writeDaemonInfo(config.cwd, {
        pid: process.pid,
        startedAt: Date.now(),
        version: CLI_VERSION,
        cwd: config.cwd,
        sourceKey: currentDaemonSourceKey(),
      });
      // Heartbeat on an INDEPENDENT timer, not after each cycle: a control-paused
      // run blocks drain()/cycle() until resumed, and we must still look alive to
      // clients (else ensureDaemon would judge the daemon dead and respawn it).
      await touchHeartbeat(config.cwd, Date.now());
      const hbTimer = setInterval(() => {
        void touchHeartbeat(config.cwd, Date.now());
      }, Math.min(intervalMs, 2000));
      hbTimer.unref?.();
      const ac = new AbortController();
      const onSignal = (): void => {
        ac.abort();
        clearInterval(hbTimer);
        server.supervisor.stop();
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      while (!ac.signal.aborted) {
        const health = await server.cycle();
        write(`heartbeat @ ${health.lastHeartbeatAt}: ${health.completed} done, ${health.queued} queued`);
        if (ac.signal.aborted) break;
        await sleep(intervalMs, ac.signal);
      }
      clearInterval(hbTimer);
      return 0;
    }

    const health = await server.cycle();
    write(`serve: processed ${health.completed} run(s)`);
    // Only a hard failure is a non-zero exit; 'incomplete' (resumable) and
    // 'cancelled' are not errors for a queue processor.
    const failed = health.runs.filter((r) => r.status === 'failed');
    return failed.length > 0 ? 1 : 0;
  }

  async function workflowCommand(positionals: string[], options: ParsedArgs['options']): Promise<number> {
    const sub = positionals[1];
    if (sub !== 'run') {
      error('omakase workflow: expected `workflow run <script.js>`');
      return 1;
    }
    const rawScript = positionals[2];
    if (!rawScript) {
      error('omakase workflow run: a JavaScript workflow script path is required');
      return 1;
    }
    const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
    const scriptPath = path.resolve(cwd, rawScript);
    const source = await readFile(scriptPath, 'utf8');
    const ab = parseAgentBudget(options);
    if (ab.error) {
      error(`omakase workflow run: ${ab.error}`);
      return 1;
    }
    const mode = resolveMode(options.mode);
    const runtime = createRuntime();
    // Workflow runs persist to the project's `.omks` workspace, same as `run`.
    const ws = resolveWorkspace(cwd);
    try {
      const run = new DynamicWorkflowRun({
        runtime,
        store: ws.runStore,
        knowledgeStore: ws.knowledgeStore,
        policy: ab.agentOverride
          ? createModelPolicy('custom', { custom: { default: { agentId: ab.agentOverride } } })
          : createModelPolicy(mode),
        scriptRunner: new BunWorkflowScriptRunner({ cwd }),
        script: {
          id: `workflow-script-${Date.now()}`,
          path: scriptPath,
          source,
          runtime: 'bun',
          createdAt: Date.now(),
        },
        request: {
          prompt: `Run workflow script ${path.basename(scriptPath)}`,
          cwd,
          mode: ab.agentOverride ? 'custom' : mode,
        },
        ...(deps.detectionOptions ? { detectionOptions: deps.detectionOptions } : {}),
        maxConcurrency: Number(options.concurrency) || 16,
        maxAgents: Number(options['max-agents']) || 1000,
      });
      const handle = run.start();
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
        if (result.spentTokens > 0 || result.spentCostUsd > 0) {
          write(`Spent: ${result.spentTokens} tokens, $${result.spentCostUsd.toFixed(4)}`);
        }
      }
      return result.status === 'succeeded' ? 0 : 1;
    } finally {
      ws.close();
    }
  }

  async function daemonCommand(sub: string | undefined, options: ParsedArgs['options']): Promise<number> {
    const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
    if (sub === 'stop') {
      const r = await stopDaemon(cwd);
      write(r.stopped ? `omakase: stopped daemon (pid ${r.pid})` : 'omakase: no running daemon');
      return 0;
    }
    // default: status
    const s = await daemonStatus(cwd);
    if (!s.running) {
      write('omakase daemon: not running');
      return 0;
    }
    const age = s.heartbeatAt != null ? `${Math.round((Date.now() - s.heartbeatAt) / 1000)}s ago` : 'unknown';
    write(`omakase daemon: running (pid ${s.pid}, v${s.version ?? '?'}) — last heartbeat ${age}`);
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
          case 'wiki':
            return await wikiCommand(positionals, options);
          case 'run':
            return await runCommand(positionals.slice(1).join(' '), options);
          case 'workflow':
            return await workflowCommand(positionals, options);
          case 'serve':
            return await serveCommand(positionals.slice(1), options);
          case 'daemon':
            return await daemonCommand(positionals[1], options);
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
