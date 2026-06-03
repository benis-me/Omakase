/**
 * `omakase serve` composition: a file-backed {@link Supervisor} for long-running
 * / "24-7" operation. It persists runs (FileRunStore) and knowledge
 * (.omakase/), resumes anything a previous process left unfinished, and drains a
 * queue made of (a) tasks passed on the command line and (b) task files dropped
 * into a queue directory. The watch loop is thin glue over {@link Server.cycle},
 * which is fully testable on its own.
 */
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentRuntime,
  type AgentRuntime,
  type DetectionOptions,
} from '@omakase/daemon';
import {
  FileRunStore,
  Orchestrator,
  Supervisor,
  createModelPolicy,
  projectKnowledgeStore,
  type RunBudget,
  type RunStatus,
  type SupervisorHealth,
  type WorkMode,
} from '@omakase/core';

export interface ServeConfig {
  cwd: string;
  runsDir: string;
  queueDir: string;
  concurrency: number;
  mode: WorkMode;
  agentOverride?: string;
  budget?: RunBudget;
  detectionOptions?: DetectionOptions;
}

export interface ServeDeps {
  write?: (line: string) => void;
  createRuntime?: () => AgentRuntime;
  now?: () => number;
}

export interface Server {
  readonly supervisor: Supervisor;
  readonly store: FileRunStore;
  readonly config: ServeConfig;
  /** Enqueue new task files from the queue dir; returns their filenames. */
  scanQueue(): Promise<string[]>;
  /** One serve cycle: resume interrupted runs, ingest the queue, drain. */
  cycle(): Promise<SupervisorHealth>;
}

const QUEUE_FILE = /\.(txt|md|prompt)$/i;

export function createServer(config: ServeConfig, deps: ServeDeps = {}): Server {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runtime =
    deps.createRuntime?.() ??
    createAgentRuntime({
      fallbackToBuiltin: true,
      detectionCacheTtlMs: 10_000,
      ...(config.detectionOptions ? { detection: config.detectionOptions } : {}),
    });
  const store = new FileRunStore(config.runsDir);
  const orchestrator = new Orchestrator({
    runtime,
    store,
    knowledgeStore: projectKnowledgeStore(config.cwd),
    defaultMode: config.agentOverride ? 'custom' : config.mode,
    ...(config.agentOverride
      ? { policy: createModelPolicy('custom', { custom: { default: { agentId: config.agentOverride } } }) }
      : {}),
    ...(config.budget ? { budget: config.budget } : {}),
    ...(config.detectionOptions ? { detectionOptions: config.detectionOptions } : {}),
    ...(deps.now ? { clock: deps.now } : {}),
  });
  const supervisor = new Supervisor({
    orchestrator,
    store,
    concurrency: config.concurrency,
    ...(deps.now ? { clock: deps.now } : {}),
    onRunFinished: (id, status: RunStatus) => write(`  ${status === 'succeeded' ? '✓' : '•'} run ${id}: ${status}`),
  });

  const scanQueue = async (): Promise<string[]> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(config.queueDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const processedDir = path.join(config.queueDir, 'processed');
    const enqueued: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !QUEUE_FILE.test(entry.name)) continue;
      const full = path.join(config.queueDir, entry.name);
      let content: string;
      try {
        content = (await readFile(full, 'utf8')).trim();
      } catch {
        continue;
      }
      if (!content) continue;
      supervisor.enqueue({ prompt: content, cwd: config.cwd });
      await mkdir(processedDir, { recursive: true });
      await rename(full, path.join(processedDir, entry.name)).catch(() => undefined);
      enqueued.push(entry.name);
    }
    return enqueued;
  };

  return {
    supervisor,
    store,
    config,
    scanQueue,
    async cycle(): Promise<SupervisorHealth> {
      await supervisor.resumeInterrupted();
      await scanQueue();
      return supervisor.drain();
    },
  };
}
