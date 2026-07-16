// Harness abstraction: an agent runtime the engine can call. The default
// harness drives installed CLIs as subprocesses (@omakase/providers). Other
// harnesses (e.g. ACP/JSON-RPC, in-process) can implement the same interface —
// this is the "multi-harness" seam.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentActivity } from '@omakase/core';
import { shortId } from '@omakase/core';
import {
  getProvider,
  runTurn,
  detectAvailable,
  detectCached,
  type ProcessSpawner,
  type TurnContext,
  type ProviderInfo,
} from '@omakase/providers';

export interface HarnessRequest {
  provider: string;
  model?: string;
  role: string;
  title: string;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  autoApprove: boolean;
  resumeSessionId?: string;
  plannedSessionId?: string;
  onActivity?: (a: AgentActivity) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HarnessResult {
  text: string;
  status: 'ok' | 'error';
  sessionId: string | null;
  tokens: number;
  costUsd: number;
  activities: AgentActivity[];
  durationMs: number;
  provider: string;
}

export interface Harness {
  readonly id: string;
  runAgent(req: HarnessRequest): Promise<HarnessResult>;
  listProviders(): Promise<ProviderInfo[]>;
}

export interface SubprocessHarnessOptions {
  /** Path to .omks/agents.json for cached detection. */
  cachePath?: string;
  /** Injectable spawner (for tests). */
  spawner?: ProcessSpawner;
  /** Default per-turn timeout. */
  timeoutMs?: number;
  /** Override the binary path for a provider (custom install location, or a
   *  fake binary in tests). Return undefined to use the default resolution. */
  commandFor?: (providerId: string) => string | undefined;
}

export class SubprocessHarness implements Harness {
  readonly id = 'subprocess';
  constructor(private opts: SubprocessHarnessOptions = {}) {}

  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    const provider = getProvider(req.provider);
    if (!provider) {
      return {
        text: `No such provider: ${req.provider}`,
        status: 'error',
        sessionId: null,
        tokens: 0,
        costUsd: 0,
        activities: [],
        durationMs: 0,
        provider: req.provider,
      };
    }
    const ctx: TurnContext = {
      prompt: req.prompt,
      cwd: req.cwd,
      autoApprove: req.autoApprove,
      scratchFile: join(tmpdir(), `omks-${provider.id}-${shortId(8)}.txt`),
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.resumeSessionId ? { resumeSessionId: req.resumeSessionId } : {}),
      ...(req.plannedSessionId ? { plannedSessionId: req.plannedSessionId } : {}),
    };
    const command = this.opts.commandFor?.(provider.id);
    const res = await runTurn(provider, ctx, {
      ...(this.opts.spawner ? { spawner: this.opts.spawner } : {}),
      ...(command ? { command } : {}),
      ...(req.onActivity ? { onActivity: req.onActivity } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.timeoutMs ?? this.opts.timeoutMs ? { timeoutMs: req.timeoutMs ?? this.opts.timeoutMs } : {}),
    });
    return {
      text: res.text,
      status: res.status,
      sessionId: res.providerSessionId,
      tokens: res.tokens,
      costUsd: res.costUsd,
      activities: res.activities,
      durationMs: res.durationMs,
      provider: provider.id,
    };
  }

  async listProviders(): Promise<ProviderInfo[]> {
    if (this.opts.cachePath) return detectCached(this.opts.cachePath, { discoverModels: false });
    return detectAvailable({ discoverModels: false });
  }
}

/**
 * A deterministic in-memory harness for testing workflows without spawning any
 * agent CLI (no cost, no auth). Returns canned responses shaped so the built-in
 * workflows exercise all their branches.
 */
export class MockHarness implements Harness {
  readonly id = 'mock';
  readonly calls: HarnessRequest[] = [];
  constructor(private responder?: (req: HarnessRequest) => string) {}

  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    this.calls.push(req);
    const text = this.responder?.(req) ?? mockResponse(req);
    if (req.onActivity) req.onActivity({ kind: 'notice', summary: `mock:${req.role}`, at: 0 });
    return { text, status: 'ok', sessionId: 'mock', tokens: 0, costUsd: 0, activities: [], durationMs: 0, provider: req.provider };
  }

  async listProviders(): Promise<ProviderInfo[]> {
    return [{ id: 'mock', command: 'mock', label: 'Mock', available: true, version: '0', path: null, models: [] }];
  }
}

function mockResponse(req: HarnessRequest): string {
  if (req.title === 'Design the plan') {
    return '{"steps":[{"id":"s1","role":"worker","title":"Build","prompt":"build","dependsOn":[]},{"id":"s2","role":"reviewer","title":"Review","prompt":"review","dependsOn":["s1"]}]}';
  }
  if (req.role === 'planner') return 'First behaviour\nSecond behaviour';
  if (req.role === 'validator') return 'DONE';
  if (req.role === 'reviewer') return 'none';
  return `done (mock ${req.role})`;
}
