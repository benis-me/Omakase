import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { createModelPolicy, type OrchestratorOptions, type Router } from '@omakase/core';
import type { CockpitEvent } from '@shared/types';
import { WorkspaceHost } from './workspace-host.js';
import {
  RunHost,
  type RunHostEvents,
  nextAutomationAction,
  AUTOMATION_MAX_RETRIES,
  AUTOMATION_RETRY_BACKOFF_MS,
} from './run-host.js';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const simpleRouter: Router = {
  route: () => ({ kind: 'simple', reason: 'simple', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

/** Hermetic overrides: a scripted agent, a forced policy, and no real-agent detection. */
function hermeticOverrides(): Partial<OrchestratorOptions> {
  const exec = createScriptedAgent(() => [{ type: 'text_delta', delta: 'done' }]);
  return {
    runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
    router: simpleRouter,
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
    detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    clock: () => 0,
  };
}

describe('RunHost end-to-end flow', () => {
  let host: WorkspaceHost;

  beforeEach(() => {
    host = new WorkspaceHost(join(tmp('omk-runhost-'), 'registry.db'));
    host.add(tmp('omk-proj-'));
  });

  afterEach(() => {
    host.shutdown();
  });

  it('starts a prompt run, streams a cockpit feed, finishes, and persists it', async () => {
    const feed: CockpitEvent[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const events: RunHostEvents = {
      cockpitEvent: (_id, event) => feed.push(event),
      runStatus: () => {},
      liveChanged: (count) => {
        if (count === 0) resolveDone();
      },
    };

    const runHost = new RunHost(host, events, hermeticOverrides());
    const id = runHost.startRun({ prompt: 'do a small thing', mode: 'normal', autonomy: 'high' });
    expect(id).toBeTruthy();

    // While live, the run reports itself as live in the list.
    expect(runHost.listRuns().some((r) => r.id === id && r.live)).toBe(true);

    await done;

    // The feed streamed structural events and a terminal 'finished'.
    expect(feed.some((e) => e.kind === 'status' && e.title === 'Run started')).toBe(true);
    expect(feed.some((e) => e.kind === 'task')).toBe(true);
    expect(feed.some((e) => e.kind === 'finished')).toBe(true);

    // The run is persisted and no longer live.
    const summary = runHost.listRuns().find((r) => r.id === id);
    expect(summary).toBeDefined();
    expect(summary?.live).toBe(false);

    // getRun rehydrates the persisted feed from disk.
    const detail = await runHost.getRun(id);
    expect(detail?.events.length).toBeGreaterThan(0);
    expect(detail?.events.some((e) => e.kind === 'finished')).toBe(true);
  }, 20_000);

  it('flags instruction-memory drift when a run rewrites AGENTS.md (self-poisoning guardrail)', async () => {
    // A scripted agent that does the thing it's briefed NOT to do: rewrite AGENTS.md mid-run.
    const exec = createScriptedAgent((input) => {
      if (input.cwd) {
        writeFileSync(join(input.cwd, '.omks', 'memory', 'AGENTS.md'), '# Poisoned briefing\n', 'utf8');
      }
      return [{ type: 'text_delta', delta: 'done' }];
    });
    const overrides: Partial<OrchestratorOptions> = {
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: simpleRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
      clock: () => 0,
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const drifts: string[] = [];
    const events: RunHostEvents = {
      cockpitEvent: () => {},
      runStatus: () => {},
      liveChanged: (count) => {
        if (count === 0) resolveDone();
      },
      instructionDrift: (_id, summary) => drifts.push(summary),
    };

    const runHost = new RunHost(host, events, overrides);
    runHost.startRun({ prompt: 'tweak something', mode: 'normal', autonomy: 'high' });
    await done;

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain('AGENTS.md');
  }, 20_000);

  it('does not flag drift when a run leaves instruction memory untouched', async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const drifts: string[] = [];
    const events: RunHostEvents = {
      cockpitEvent: () => {},
      runStatus: () => {},
      liveChanged: (count) => {
        if (count === 0) resolveDone();
      },
      instructionDrift: (_id, summary) => drifts.push(summary),
    };

    const runHost = new RunHost(host, events, hermeticOverrides());
    runHost.startRun({ prompt: 'do a small thing', mode: 'normal', autonomy: 'high' });
    await done;

    expect(drifts).toEqual([]);
  }, 20_000);

  it('persists the selected CLI so resume keeps the same agent override', async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const events: RunHostEvents = {
      cockpitEvent: () => {},
      runStatus: () => {},
      liveChanged: (count) => {
        if (count === 0) resolveDone();
      },
    };

    const runHost = new RunHost(host, events, hermeticOverrides());
    const id = runHost.startRun({ prompt: 'do a small thing', mode: 'normal', autonomy: 'high', agentId: 'scripted' });
    await done;

    const record = await host.activeWorkspace?.runStore.load(id);
    expect(record?.request.metadata?.agentOverride).toBe('scripted');
    expect(runHost.listRuns().find((r) => r.id === id)?.agentId).toBe('scripted');
  }, 20_000);

  it('does not manually resume a rate-limited run before its reset time', async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const liveCounts: number[] = [];
    const limited: Array<{ id: string; resetAt: number }> = [];
    const events: RunHostEvents = {
      cockpitEvent: () => {},
      runStatus: () => {},
      liveChanged: (count) => {
        liveCounts.push(count);
        if (count === 0) resolveDone();
      },
      rateLimited: (id, resetAt) => limited.push({ id, resetAt }),
    };

    const runHost = new RunHost(host, events, hermeticOverrides());
    const id = runHost.startRun({ prompt: 'do a small thing', mode: 'normal', autonomy: 'high', agentId: 'scripted' });
    await done;

    const record = await host.activeWorkspace?.runStore.load(id);
    expect(record).toBeTruthy();
    const resetAt = Date.now() + 60_000;
    await host.activeWorkspace?.runStore.save({
      ...record!,
      status: 'incomplete',
      rateLimitedUntil: resetAt,
      updatedAt: Date.now(),
      heartbeatAt: Date.now(),
    });
    liveCounts.length = 0;

    await expect(runHost.resumeRun(id, 'high')).resolves.toBe(true);

    expect(runHost.isLive(id)).toBe(false);
    expect(liveCounts).toEqual([]);
    expect(limited).toEqual([{ id, resetAt }]);
  }, 20_000);

  it('does not offer resume for an incomplete run whose tasks all succeeded but acceptance is pending', async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const liveCounts: number[] = [];
    const events: RunHostEvents = {
      cockpitEvent: () => {},
      runStatus: () => {},
      liveChanged: (count) => {
        liveCounts.push(count);
        if (count === 0) resolveDone();
      },
    };

    const runHost = new RunHost(host, events, hermeticOverrides());
    const id = runHost.startRun({ prompt: 'do a small thing', mode: 'normal', autonomy: 'high', agentId: 'scripted' });
    await done;

    const record = await host.activeWorkspace?.runStore.load(id);
    expect(record).toBeTruthy();
    await host.activeWorkspace?.runStore.save({
      ...record!,
      status: 'incomplete',
      summary: 'incomplete: 1/1 tasks succeeded; acceptance 0/1 criteria passed',
      acceptance: {
        criteria: [
          {
            id: 'criterion-1',
            title: 'User acceptance is verified',
            description: 'User acceptance is verified',
            status: 'pending',
            evidence: [],
            source: 'user',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        progress: { passed: 0, total: 1, complete: false },
      },
      updatedAt: Date.now(),
      heartbeatAt: Date.now(),
    });
    liveCounts.length = 0;

    expect(runHost.listRuns().find((run) => run.id === id)?.resumable).toBe(false);
    await expect(runHost.resumeRun(id, 'high')).resolves.toBe(false);
    expect(runHost.isLive(id)).toBe(false);
    expect(liveCounts).toEqual([]);
  }, 20_000);

  it('reports no runs for a fresh workspace', () => {
    const runHost = new RunHost(host, {
      cockpitEvent: () => {},
      runStatus: () => {},
      liveChanged: () => {},
    });
    expect(runHost.listRuns()).toEqual([]);
  });
});

describe('nextAutomationAction (unattended self-healing)', () => {
  it('retries a failed run with escalating backoff up to the cap', () => {
    expect(nextAutomationAction('failed', 0)).toEqual({ kind: 'retry', delayMs: AUTOMATION_RETRY_BACKOFF_MS[0] });
    expect(nextAutomationAction('failed', 1)).toEqual({ kind: 'retry', delayMs: AUTOMATION_RETRY_BACKOFF_MS[1] });
    expect(nextAutomationAction('failed', 2)).toEqual({ kind: 'retry', delayMs: AUTOMATION_RETRY_BACKOFF_MS[2] });
  });

  it('escalates once retries are exhausted', () => {
    expect(nextAutomationAction('failed', AUTOMATION_MAX_RETRIES)).toEqual({ kind: 'attention' });
  });

  it('escalates an incomplete run rather than blindly looping on it', () => {
    expect(nextAutomationAction('incomplete', 0)).toEqual({ kind: 'attention' });
  });

  it('does nothing for a clean finish', () => {
    expect(nextAutomationAction('succeeded', 0)).toEqual({ kind: 'none' });
    expect(nextAutomationAction('cancelled', 1)).toEqual({ kind: 'none' });
    expect(nextAutomationAction(undefined, 0)).toEqual({ kind: 'none' });
  });
});
