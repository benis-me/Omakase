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
  FileControlSource,
  FileRunStore,
  Orchestrator,
  Supervisor,
  createModelPolicy,
  projectKnowledgeStore,
  type ControlPoll,
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

/**
 * A queue file is the prompt text, optionally led by an `@agent <id>` line that
 * pins the run to a chosen agent (written by the TUI's agent selector).
 */
function parseQueueContent(raw: string): { prompt: string; agentOverride?: string } {
  const m = /^@agent[ \t]+(\S+)[ \t]*\r?\n([\s\S]*)$/.exec(raw);
  if (m) return { prompt: (m[2] ?? '').trim(), agentOverride: m[1] };
  return { prompt: raw.trim() };
}

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
  // Cross-process control: the TUI/desktop app writes <runsDir>/<id>.control.json;
  // each run polls it (unref'd, so it never keeps the daemon alive on its own).
  const controlPoll: ControlPoll = (tick) => {
    const timer = setInterval(tick, 250);
    timer.unref?.();
    return () => clearInterval(timer);
  };
  const orchestrator = new Orchestrator({
    runtime,
    store,
    knowledgeStore: projectKnowledgeStore(config.cwd),
    control: new FileControlSource(config.runsDir),
    controlPoll,
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
      let raw: string;
      try {
        raw = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const { prompt: content, agentOverride } = parseQueueContent(raw);
      if (!content) continue;
      // Claim the file (move it) BEFORE enqueuing, so a rename failure can't
      // leave the file in place to be re-ingested (double-submitted) next cycle.
      // Tag the request with the (unique) source filename so recoverClaimed can
      // correlate a claimed file with its eventual run record.
      await mkdir(processedDir, { recursive: true });
      try {
        await rename(full, path.join(processedDir, entry.name));
      } catch {
        write(`serve: could not claim queue file ${entry.name}; leaving it for next cycle`);
        continue;
      }
      supervisor.enqueue({
        prompt: content,
        cwd: config.cwd,
        metadata: { sourceQueueFile: entry.name, ...(agentOverride ? { agentOverride } : {}) },
      });
      enqueued.push(entry.name);
    }
    return enqueued;
  };

  // Re-ingest queue files that were claimed (moved to processed/) but whose run
  // never persisted a record — i.e. a crash struck between the claim-rename and
  // the run's first checkpoint. Without this, claim-before-enqueue would lose
  // such a task forever (the file is no longer in the queue dir, and no
  // resumable record exists). Correlate by the sourceQueueFile metadata key.
  const recoverClaimed = async (): Promise<string[]> => {
    const processedDir = path.join(config.queueDir, 'processed');
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(processedDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const started = new Set<string>();
    for (const id of await store.list()) {
      const src = (await store.load(id))?.request.metadata?.sourceQueueFile;
      if (typeof src === 'string') started.add(src);
    }
    const reingested: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !QUEUE_FILE.test(entry.name)) continue;
      if (started.has(entry.name)) continue; // a run record exists → already underway
      let raw: string;
      try {
        raw = await readFile(path.join(processedDir, entry.name), 'utf8');
      } catch {
        continue;
      }
      const { prompt: content, agentOverride } = parseQueueContent(raw);
      if (!content) continue;
      supervisor.enqueue({
        prompt: content,
        cwd: config.cwd,
        metadata: { sourceQueueFile: entry.name, ...(agentOverride ? { agentOverride } : {}) },
      });
      reingested.push(entry.name);
      write(`serve: re-ingesting ${entry.name} (claimed previously but no run record was persisted)`);
    }
    return reingested;
  };

  return {
    supervisor,
    store,
    config,
    scanQueue,
    async cycle(): Promise<SupervisorHealth> {
      await supervisor.resumeInterrupted();
      await recoverClaimed();
      await scanQueue();
      return supervisor.drain();
    },
  };
}
