/**
 * Runs orchestrations in-process for the active workspace, streaming a mapped
 * cockpit feed to the renderer. Control (pause/stop/steer/answer-gate) flows
 * through a file-backed ControlSource under `.omks/control` — the same channel a
 * detached daemon would use (Phase 5), so the model is uniform. The autonomy
 * dial governs how far a run proceeds before a risk gate pauses for the user.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentRuntime, type AgentRuntime } from '@omakase/daemon';
import {
  FileControlSource,
  Orchestrator,
  writeControl,
  type RunHandle,
  type RunRecord,
} from '@omakase/core';
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
    return ws.runStore.summaries().map(toSummaryDto);
  }

  async getRun(id: string): Promise<RunDetailDto | null> {
    const ws = this.host.activeWorkspace;
    if (!ws) return null;
    const record = await ws.runStore.load(id);
    if (!record) return null;
    const summary = ws.runStore.summaries().find((s) => s.id === id);
    return {
      summary: summary ? toSummaryDto(summary) : recordSummary(record),
      events: toCockpitFeed(record.events),
    };
  }

  startRun(input: RunStartInput): string {
    const ws = this.host.activeWorkspace;
    if (!ws) throw new Error('No active workspace.');
    const spec = input.specId ? readSpec(ws.root, input.specId) : null;
    const prompt = (spec?.body ?? input.prompt ?? '').trim();
    if (!prompt) throw new Error('A spec or prompt is required.');
    const acceptanceCriteria = spec ? extractCriteria(spec.body) : [];

    const controlDir = join(ws.root, '.omks', 'control');
    mkdirSync(controlDir, { recursive: true });
    this.runtime ??= createAgentRuntime({ fallbackToBuiltin: true, detectionCacheTtlMs: 10_000 });

    const orchestrator = new Orchestrator({
      runtime: this.runtime,
      store: ws.runStore,
      knowledgeStore: ws.knowledgeStore,
      defaultMode: input.mode,
      control: new FileControlSource(controlDir),
      controlPoll: (tick) => {
        const timer = setInterval(tick, 250);
        timer.unref?.();
        return () => clearInterval(timer);
      },
    });

    const handle = orchestrator.start({
      prompt,
      cwd: ws.root,
      mode: input.mode,
      ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
    });
    const run: LiveRun = { handle, autonomy: input.autonomy, controlDir, controlSeq: 0, seq: 0 };
    this.live.set(handle.id, run);
    void this.pump(handle.id, run);
    return handle.id;
  }

  async control(runId: string, command: RunControl): Promise<void> {
    const run = this.live.get(runId);
    const controlDir = run?.controlDir ?? join(this.host.activeWorkspace?.root ?? '.', '.omks', 'control');
    const seq = run ? (run.controlSeq += 1) : Date.now();
    await writeControl(controlDir, runId, { seq, ...command });
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
    for (const run of this.live.values()) {
      try {
        run.handle.cancel();
      } catch {
        /* ignore */
      }
    }
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
}

function toSummaryDto(s: RunSummary): RunSummaryDto {
  return {
    id: s.id,
    mode: s.mode,
    status: s.status,
    summary: s.summary,
    spentTokens: s.spentTokens,
    spentCostUsd: s.spentCostUsd,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function recordSummary(r: RunRecord): RunSummaryDto {
  return {
    id: r.id,
    mode: r.mode,
    status: r.status,
    summary: r.summary,
    spentTokens: r.spentTokens ?? null,
    spentCostUsd: r.spentCostUsd ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
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
