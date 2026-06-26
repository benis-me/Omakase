import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { createModelPolicy, type OrchestratorOptions, type Router } from '@omakase/core';
import type { CockpitEvent } from '@shared/types';
import { WorkspaceHost } from './workspace-host.js';
import { RunHost, type RunHostEvents } from './run-host.js';

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

  it('reports no runs for a fresh workspace', () => {
    const runHost = new RunHost(host, {
      cockpitEvent: () => {},
      runStatus: () => {},
      liveChanged: () => {},
    });
    expect(runHost.listRuns()).toEqual([]);
  });
});
