/**
 * Runs orchestrations in-process for the active workspace, streaming a mapped
 * cockpit feed to the renderer. Control (pause/stop/steer/answer-gate) flows
 * through a file-backed ControlSource under `.omks/control` — the same channel a
 * detached daemon would use (Phase 5), so the model is uniform. The autonomy
 * dial governs how far a run proceeds before a risk gate pauses for the user.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createAgentRuntime, wellKnownToolchainDirs, type AgentRuntime } from '@omakase/daemon';
import {
  BunWorkflowScriptRunner,
  createModelPolicy,
  DynamicWorkflowRun,
  FileControlSource,
  Orchestrator,
  RESUMABLE_STATUSES,
  writeControl,
  type ControlPoll,
  type ControlSource,
  type OrchestratorEvent,
  type OrchestratorOptions,
  type RunRecord,
  type RunStatus,
  type RunVerifier,
} from '@omakase/core';
import type { OpenWorkspace } from '@omakase/storage';
import { readSpec, readWorkflow, type RunSummary } from '@omakase/storage';
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

/** The slice of a run handle the host needs — satisfied by both the Orchestrator
 * RunHandle and a DynamicWorkflowHandle. */
interface LiveHandle {
  readonly id: string;
  readonly events: AsyncIterable<OrchestratorEvent>;
  readonly result: Promise<unknown>;
  cancel(): void;
}

interface LiveRun {
  handle: LiveHandle;
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
  /** A run reached a terminal state. Used to notify the user when an unattended
   * (triggered) run can't finish cleanly. */
  runFinished?(runId: string, status: string, triggeredBy?: string): void;
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
  /** runId → the automation name that started it (this session, for the "auto" badge). */
  private readonly triggeredBy = new Map<string, string>();

  constructor(
    private readonly host: WorkspaceHost,
    private readonly events: RunHostEvents,
    /** Test-only seam: merged into every Orchestrator (inject a scripted runtime,
     * a forced policy, hermetic detection, etc.). Undefined in production. */
    private readonly overrides?: Partial<OrchestratorOptions>,
  ) {}

  listRuns(): RunSummaryDto[] {
    const ws = this.host.activeWorkspace;
    if (!ws) return [];
    return ws.runStore.summaries().map((s) => {
      const dto = toSummaryDto(s, this.live.has(s.id));
      const tb = this.triggeredBy.get(s.id);
      return tb ? { ...dto, triggeredBy: tb } : dto;
    });
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
    // Prefer the spec's structured acceptance criteria (the guided phase machine);
    // fall back to extracting them from the body.
    const acceptanceCriteria = spec
      ? spec.acceptanceCriteria.length
        ? spec.acceptanceCriteria
        : extractCriteria(spec.body)
      : [];

    const controlDir = this.controlDir(ws);
    // Spec-driven runs get an independent validator at the finish line.
    const handle = this.buildOrchestrator(
      ws,
      controlDir,
      input.mode,
      Boolean(input.specId),
      input.agentId,
      input.maxTokens,
    ).start({
      prompt,
      cwd: ws.root,
      mode: input.mode,
      ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
      ...(input.triggeredBy ? { metadata: { triggeredBy: input.triggeredBy } } : {}),
    });
    if (input.triggeredBy) this.triggeredBy.set(handle.id, input.triggeredBy);
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

  /** Run a dynamic workflow script as a run (requires Bun on PATH). */
  startWorkflow(workflowId: string, autonomy: AutonomyLevel): string {
    const ws = this.requireWorkspace();
    const doc = readWorkflow(ws.root, workflowId);
    if (!doc) throw new Error('Workflow not found.');
    const controlDir = this.controlDir(ws);
    this.runtime ??= createAgentRuntime({ fallbackToBuiltin: true, detectionCacheTtlMs: 10_000 });
    const run = new DynamicWorkflowRun({
      runtime: this.runtime,
      store: ws.runStore,
      knowledgeStore: ws.knowledgeStore,
      policy: createModelPolicy('normal'),
      scriptRunner: new BunWorkflowScriptRunner({ cwd: ws.root }),
      script: { id: doc.id, path: doc.path, source: doc.source, runtime: 'bun', createdAt: Date.now() },
      request: { prompt: `Run workflow: ${doc.name}`, cwd: ws.root, mode: 'normal' },
      maxConcurrency: 16,
      maxAgents: 1000,
    });
    const handle = run.start();
    this.track(handle, autonomy, controlDir, 0);
    return handle.id;
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
    this.triggeredBy.delete(id);
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
    const result = (await run.handle.result.catch(() => null)) as { status?: string } | null;
    this.live.delete(runId);
    this.events.liveChanged(this.live.size);
    this.events.runStatus(runId);
    if (result?.status) this.events.runFinished?.(runId, result.status, this.triggeredBy.get(runId));
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

  private buildOrchestrator(
    ws: OpenWorkspace,
    controlDir: string,
    defaultMode: RunStartInput['mode'],
    validate = false,
    agentId?: string,
    maxTokens?: number,
  ): Orchestrator {
    this.runtime ??=
      this.overrides?.runtime ?? createAgentRuntime({ fallbackToBuiltin: true, detectionCacheTtlMs: 10_000 });
    const controlPoll: ControlPoll = (tick) => {
      const timer = setInterval(tick, 250);
      timer.unref?.();
      return () => clearInterval(timer);
    };
    const control: ControlSource = new FileControlSource(controlDir);
    // Spec runs that have a test command get a closed-loop verifier as a hard gate.
    const verifier = validate ? this.buildVerifier(ws) : undefined;
    return new Orchestrator({
      runtime: this.runtime,
      store: ws.runStore,
      knowledgeStore: ws.knowledgeStore,
      defaultMode,
      control,
      controlPoll,
      validate,
      // A run-level CLI choice pins every role to that agent.
      ...(agentId ? { policy: createModelPolicy('custom', { custom: { default: { agentId } } }) } : {}),
      ...(verifier ? { verifier } : {}),
      ...(maxTokens && maxTokens > 0 ? { budget: { maxTokens } } : {}),
      ...this.overrides,
    });
  }

  /**
   * A closed-loop verifier that runs the workspace's `test` script — an objective
   * finish-line gate (failing tests inject a fix-task and re-run the loop).
   * Returns undefined when there's no test script to run.
   */
  private buildVerifier(ws: OpenWorkspace): RunVerifier | undefined {
    let hasTest = false;
    try {
      const pkg = JSON.parse(readFileSync(join(ws.root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      hasTest = Boolean(pkg.scripts?.test);
    } catch {
      return undefined;
    }
    if (!hasTest) return undefined;
    const pm = existsSync(join(ws.root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(ws.root, 'yarn.lock'))
        ? 'yarn'
        : existsSync(join(ws.root, 'bun.lockb'))
          ? 'bun'
          : 'npm';
    // GUI-launched apps inherit a minimal PATH; add the common toolchain dirs so
    // the package manager resolves (mirrors agent-CLI detection).
    const env = {
      ...process.env,
      PATH: [process.env.PATH ?? '', ...wellKnownToolchainDirs(homedir())].filter(Boolean).join(delimiter),
    };
    return () =>
      new Promise((resolve) => {
        execFile(
          pm,
          ['test'],
          { cwd: ws.root, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env },
          (err, stdout, stderr) => {
            // Don't fail the gate just because the runner isn't on PATH.
            if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
              resolve({ passed: true, summary: `${pm} not found — verification skipped` });
              return;
            }
            const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-40).join('\n').slice(0, 4000);
            resolve({ passed: !err, summary: tail || (err ? 'test command failed' : 'tests passed') });
          },
        );
      });
  }

  private track(handle: LiveHandle, autonomy: AutonomyLevel, controlDir: string, seqBase: number): void {
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
