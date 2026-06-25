/**
 * Runs orchestrations in-process for the active workspace, streaming a mapped
 * cockpit feed to the renderer. Control (pause/stop/steer/answer-gate) flows
 * through a file-backed ControlSource under `.omks/control` — the same channel a
 * detached daemon would use (Phase 5), so the model is uniform. The autonomy
 * dial governs how far a run proceeds before a risk gate pauses for the user.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentRuntime, type AgentRuntime } from '@omakase/daemon';
import {
  FileControlSource,
  Orchestrator,
  RESUMABLE_STATUSES,
  writeControl,
  type ControlPoll,
  type ControlSource,
  type RunHandle,
  type RunRecord,
  type RunStatus,
} from '@omakase/core';
import type { OpenWorkspace } from '@omakase/storage';
import { readSpec, type RunSummary } from '@omakase/storage';
import type {
  AutonomyLevel,
  CockpitEvent,
  RunControl,
  RunDetailDto,
  RunStartInput,
  RunSummaryDto,
} from '@shared/types';
import type { WorkspaceHost } from './workspace-host.js';
import { toCockpitEvent, toCockpitFeed } from './cockpit-map.js';

interface LiveRun {
  handle: RunHandle;
  autonomy: AutonomyLevel;
  controlDir: string;
  controlSeq: number;
  seq: number;
}

export interface RunHostEvents {
  cockpitEvent(runId: string, event: CockpitEvent): void;
  /** A run's lifecycle changed — the renderer should refresh the list. */
  runStatus(runId: string): void;
  /** The number of in-process live runs changed (drives the tray). */
  liveChanged(count: number): void;
}

const AUTONOMY_RANK: Record<AutonomyLevel, number> = { off: 0, low: 1, medium: 2, high: 3 };
// Minimum autonomy that auto-proceeds past a gate of the given reason.
const GATE_MIN_AUTONOMY: Record<string, number> = {
  'review-uncertain': 1,
  'user-confirmation': 2,
  'high-risk-change': 3,
};

export class RunHost {
  private runtime: AgentRuntime | null = null;
  private readonly live = new Map<string, LiveRun>();

  constructor(
    private readonly host: WorkspaceHost,
    private readonly events: RunHostEvents,
  ) {}

  listRuns(): RunSummaryDto[] {
    const ws = this.host.activeWorkspace;
    if (!ws) return [];
    return ws.runStore.summaries().map((s) => toSummaryDto(s, this.live.has(s.id)));
  }

  async getRun(id: string): Promise<RunDetailDto | null> {
    const ws = this.host.activeWorkspace;
    if (!ws) return null;
    const record = await ws.runStore.load(id);
    if (!record) return null;
    const live = this.live.has(id);
    const summary = ws.runStore.summaries().find((s) => s.id === id);
    return {
      summary: summary ? toSummaryDto(summary, live) : recordSummary(record, live),
      events: toCockpitFeed(record.events),
    };
  }

  startRun(input: RunStartInput): string {
    const ws = this.requireWorkspace();
    const spec = input.specId ? readSpec(ws.root, input.specId) : null;
    const prompt = (spec?.body ?? input.prompt ?? '').trim();
    if (!prompt) throw new Error('A spec or prompt is required.');
    const acceptanceCriteria = spec ? extractCriteria(spec.body) : [];

    const controlDir = this.controlDir(ws);
    const handle = this.buildOrchestrator(ws, controlDir, input.mode).start({
      prompt,
      cwd: ws.root,
      mode: input.mode,
      ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
    });
    this.track(handle, input.autonomy, controlDir, 0);
    return handle.id;
  }

  /** Resume an interrupted run (e.g. after an app restart). */
  async resumeRun(id: string, autonomy: AutonomyLevel): Promise<boolean> {
    if (this.live.has(id)) return true;
    const ws = this.host.activeWorkspace;
    if (!ws) return false;
    const record = await ws.runStore.load(id);
    if (!record || !RESUMABLE_STATUSES.includes(record.status)) return false;
    const controlDir = this.controlDir(ws);
    // Drop any leftover control command from the previous session so the resumed
    // run doesn't immediately act on a stale pause/stop/answer.
    rmSync(join(controlDir, `${id}.control.json`), { force: true });
    const handle = await this.buildOrchestrator(ws, controlDir, record.mode).resume(id);
    if (!handle) return false;
    // Continue the cockpit feed's seq numbering after the already-persisted feed.
    this.track(handle, autonomy, controlDir, toCockpitFeed(record.events).length);
    return true;
  }

  async control(runId: string, command: RunControl): Promise<void> {
    // Only a live run honours control. Writing for a finished run would leave a
    // stale, high-seq command file that a later resume would wrongly apply.
    const run = this.live.get(runId);
    if (!run) return;
    run.controlSeq += 1;
    await writeControl(run.controlDir, runId, { seq: run.controlSeq, ...command });
  }

  async deleteRun(id: string): Promise<void> {
    try {
      this.live.get(id)?.handle.cancel();
    } catch {
      /* already done */
    }
    await this.host.activeWorkspace?.runStore.delete(id);
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  shutdown(): void {
    // Do NOT cancel live runs on quit — cancelling marks them terminal, which
    // would defeat resume. The process is exiting; their last checkpoint stays
    // non-terminal in omks.db, so they show up as resumable on the next launch.
    this.live.clear();
  }

  private async pump(runId: string, run: LiveRun): Promise<void> {
    try {
      for await (const event of run.handle.events) {
        const item = toCockpitEvent(event, run.seq);
        if (item) {
          run.seq += 1;
          this.events.cockpitEvent(runId, item);
        }
        if (event.type === 'risk-gate-opened') {
          this.maybeAutoAnswer(run, event.gate.id, event.gate.reason);
        }
      }
    } catch {
      /* the stream may end via error; result still settles below */
    }
    await run.handle.result.catch(() => null);
    this.live.delete(runId);
    this.events.liveChanged(this.live.size);
    this.events.runStatus(runId);
  }

  private maybeAutoAnswer(run: LiveRun, gateId: string, reason: string): void {
    const need = GATE_MIN_AUTONOMY[reason] ?? 3;
    if (AUTONOMY_RANK[run.autonomy] >= need) {
      const seq = (run.controlSeq += 1);
      void writeControl(run.controlDir, run.handle.id, {
        seq,
        command: 'answer-gate',
        gateId,
        answer: 'Proceed.',
      });
    }
  }

  private requireWorkspace(): OpenWorkspace {
    const ws = this.host.activeWorkspace;
    if (!ws) throw new Error('No active workspace.');
    return ws;
  }

  private controlDir(ws: OpenWorkspace): string {
    const dir = join(ws.root, '.omks', 'control');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private buildOrchestrator(ws: OpenWorkspace, controlDir: string, defaultMode: RunStartInput['mode']): Orchestrator {
    this.runtime ??= createAgentRuntime({ fallbackToBuiltin: true, detectionCacheTtlMs: 10_000 });
    const controlPoll: ControlPoll = (tick) => {
      const timer = setInterval(tick, 250);
      timer.unref?.();
      return () => clearInterval(timer);
    };
    const control: ControlSource = new FileControlSource(controlDir);
    return new Orchestrator({
      runtime: this.runtime,
      store: ws.runStore,
      knowledgeStore: ws.knowledgeStore,
      defaultMode,
      control,
      controlPoll,
    });
  }

  private track(handle: RunHandle, autonomy: AutonomyLevel, controlDir: string, seqBase: number): void {
    const run: LiveRun = { handle, autonomy, controlDir, controlSeq: 0, seq: seqBase };
    this.live.set(handle.id, run);
    this.events.liveChanged(this.live.size);
    void this.pump(handle.id, run);
  }
}

const isResumable = (status: string, live: boolean): boolean =>
  !live && RESUMABLE_STATUSES.includes(status as RunStatus);

function toSummaryDto(s: RunSummary, live: boolean): RunSummaryDto {
  return {
    id: s.id,
    mode: s.mode,
    status: s.status,
    summary: s.summary,
    spentTokens: s.spentTokens,
    spentCostUsd: s.spentCostUsd,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    live,
    resumable: isResumable(s.status, live),
  };
}

function recordSummary(r: RunRecord, live: boolean): RunSummaryDto {
  return {
    id: r.id,
    mode: r.mode,
    status: r.status,
    summary: r.summary,
    spentTokens: r.spentTokens ?? null,
    spentCostUsd: r.spentCostUsd ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    live,
    resumable: isResumable(r.status, live),
  };
}

/** Pull acceptance-criteria lines from a spec body (under an "acceptance" heading). */
function extractCriteria(body: string): string[] {
  const out: string[] = [];
  let inAcceptance = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) inAcceptance = /acceptance/i.test(line);
    if (!inAcceptance) continue;
    const m = line.match(/^\s*[-*]\s*(?:\[[ xX]?\]\s*)?(.+)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}
