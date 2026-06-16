/**
 * A process-agnostic client for a detached, file-backed run (driven by an
 * `omakase serve` daemon). The TUI/desktop app never owns an Orchestrator — it
 * submits work by dropping a queue file, correlates it back to the daemon-
 * allocated run id via the persisted `sourceQueueFile` metadata, tails live
 * progress by re-folding the run's persisted event log (replay == tail), and
 * steers the run by atomically writing per-run control files the daemon reads.
 *
 * Everything is over the {@link RunStore} + filesystem, so it works across
 * processes and is unit-testable headlessly (no Ink, no real models).
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FileControlSource,
  writeControl,
  type ControlCommand,
  type ControlCommandKind,
  type RunStatus,
  type RunStore,
} from '@omakase/core';
import { applyPlanSnapshot, buildRunView, reduceTranscript, type RunView, type TranscriptItem } from './view-model.js';

/**
 * Fold a session's rolling summary and any referenced files into the run prompt,
 * so each new run in a conversation inherits prior context. Pure.
 */
export function composeSessionPrompt(intent: { prompt: string; files: string[] }, rollingSummary: string): string {
  const parts: string[] = [];
  if (rollingSummary.trim()) parts.push(`Session context so far:\n${rollingSummary.trim()}\n`);
  parts.push(intent.prompt);
  if (intent.files.length > 0) parts.push(`\nContext files:\n${intent.files.map((f) => `- ${f}`).join('\n')}`);
  return parts.join('\n');
}

export interface RunSummary {
  id: string;
  title: string;
  status: RunStatus;
  done: number;
  total: number;
  updatedAt: number;
}

export interface RunControllerClientOptions {
  store: RunStore;
  /** Directory the daemon reads control files from (the runs dir). */
  controlDir: string;
  /** Directory the daemon watches for queue files. */
  queueDir: string;
  /** Token generator (override for deterministic tests). */
  nextToken?: () => string;
  /** Poll interval for {@link tail} (ms). */
  pollMs?: number;
}

export class RunControllerClient {
  private readonly store: RunStore;
  private readonly controlDir: string;
  private readonly queueDir: string;
  private readonly control: FileControlSource;
  private readonly nextToken: () => string;
  private readonly pollMs: number;
  private seq = 0;

  constructor(options: RunControllerClientOptions) {
    this.store = options.store;
    this.controlDir = options.controlDir;
    this.queueDir = options.queueDir;
    this.control = new FileControlSource(options.controlDir);
    this.pollMs = options.pollMs ?? 400;
    this.nextToken =
      options.nextToken ??
      (() => `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.prompt`);
  }

  /**
   * Drop a queue file for the daemon to pick up; returns its correlation token.
   * An optional agentId pins the run to a chosen agent (via an `@agent` header).
   */
  async submit(prompt: string, agentId?: string): Promise<string> {
    const token = this.nextToken();
    await mkdir(this.queueDir, { recursive: true });
    const target = path.join(this.queueDir, token);
    const tmp = `${target}.tmp`;
    const body = agentId ? `@agent ${agentId}\n${prompt}` : prompt;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, target); // atomic: the daemon never sees a partial file
    return token;
  }

  /**
   * Submit a task inside a session: the rolling summary + #file references are
   * folded into the prompt (see {@link composeSessionPrompt}) and an optional
   * agent override is pinned via the `@agent` header. Returns the queue token;
   * the caller resolves the run id and records it on the session.
   */
  async submitToSession(
    session: { rollingSummary: string },
    intent: { prompt: string; agentOverride?: string; files: string[] },
  ): Promise<string> {
    const prompt = composeSessionPrompt({ prompt: intent.prompt, files: intent.files }, session.rollingSummary);
    return this.submit(prompt, intent.agentOverride);
  }

  /** Poll the store for the run the daemon created from a submitted token. */
  async resolveRunId(token: string, timeoutMs = 8000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const id of await this.store.list()) {
        const rec = await this.store.load(id);
        if (rec?.request.metadata?.sourceQueueFile === token) return id;
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** One-shot folded view of a run (replay), or null if it doesn't exist. */
  async snapshot(runId: string): Promise<RunView | null> {
    const rec = await this.store.load(runId);
    if (!rec) return null;
    return { ...applyPlanSnapshot(buildRunView(rec.events, rec.mode), rec.plan), runId };
  }

  /** Summaries of all known runs (most-recently-updated first). */
  async list(): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const id of await this.store.list()) {
      const rec = await this.store.load(id);
      if (!rec) continue;
      const view = buildRunView(rec.events, rec.mode);
      out.push({
        id,
        title: view.title ?? rec.request.prompt,
        status: rec.status,
        done: view.phases.reduce((s, p) => s + p.done, 0),
        total: view.tasks.length,
        updatedAt: rec.heartbeatAt,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Live-tail a run: emit the current folded view, then re-emit whenever the
   * persisted record advances (events grow / status changes). Returns a disposer.
   */
  tail(runId: string, onView: (view: RunView) => void): () => void {
    let stopped = false;
    let lastLen = -1;
    let lastStatus = '';
    let lastSeq = -1;
    const poll = async (): Promise<void> => {
      if (stopped) return;
      const rec = await this.store.load(runId);
      // Re-check AFTER the await: the consumer may have disposed (e.g. switched
      // runs) while the load was in flight — never emit a now-stale view.
      if (stopped || !rec) return;
      // Re-fold on any advance: more events, a new status, OR a new checkpoint
      // (the plan snapshot — e.g. a task's status — can change without new events).
      if (rec.events.length !== lastLen || rec.status !== lastStatus || rec.checkpointSeq !== lastSeq) {
        lastLen = rec.events.length;
        lastStatus = rec.status;
        lastSeq = rec.checkpointSeq;
        onView({ ...applyPlanSnapshot(buildRunView(rec.events, rec.mode), rec.plan), runId });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), this.pollMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /** One-shot transcript (structural chat timeline) for a run. */
  async transcript(runId: string): Promise<TranscriptItem[]> {
    const rec = await this.store.load(runId);
    return rec ? reduceTranscript(rec.events) : [];
  }

  /**
   * Live-tail a run, emitting both the folded sidebar view and the chat
   * transcript on every advance. One poller drives both projections.
   */
  tailRun(runId: string, onUpdate: (u: { view: RunView; transcript: TranscriptItem[] }) => void): () => void {
    let stopped = false;
    let lastLen = -1;
    let lastStatus = '';
    let lastSeq = -1;
    const poll = async (): Promise<void> => {
      if (stopped) return;
      const rec = await this.store.load(runId);
      if (stopped || !rec) return;
      if (rec.events.length !== lastLen || rec.status !== lastStatus || rec.checkpointSeq !== lastSeq) {
        lastLen = rec.events.length;
        lastStatus = rec.status;
        lastSeq = rec.checkpointSeq;
        const view = { ...applyPlanSnapshot(buildRunView(rec.events, rec.mode), rec.plan), runId };
        onUpdate({ view, transcript: reduceTranscript(rec.events) });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), this.pollMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  stop(runId: string): Promise<void> {
    return this.writeNext(runId, 'stop');
  }
  pause(runId: string): Promise<void> {
    return this.writeNext(runId, 'pause');
  }
  resume(runId: string): Promise<void> {
    return this.writeNext(runId, 'resume');
  }
  sendInput(runId: string, text: string): Promise<void> {
    return this.writeNext(runId, 'input', { text });
  }
  answerGate(runId: string, gateId: string, answer: string, criteria?: string[]): Promise<void> {
    return this.writeNext(runId, 'answer-gate', {
      gateId,
      answer,
      ...(criteria ? { criteria } : {}),
    });
  }
  editCriteria(runId: string, criteria: string[]): Promise<void> {
    return this.writeNext(runId, 'edit-criteria', { criteria });
  }

  /** Write a control command with a monotonic seq (one past whatever's on disk). */
  private async writeNext(
    runId: string,
    command: ControlCommandKind,
    payload: Omit<ControlCommand, 'seq' | 'command'> = {},
  ): Promise<void> {
    const current = await this.control.read(runId);
    this.seq = Math.max(this.seq, current?.seq ?? 0) + 1;
    await writeControl(this.controlDir, runId, {
      seq: this.seq,
      command,
      ...payload,
    });
  }
}
