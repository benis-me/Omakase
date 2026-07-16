import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store, runId as newRunId, type RunId } from '@omakase/core';
import { RunBus, type Harness, type HarnessRequest, type HarnessResult } from '@omakase/engine';
import type { ProviderInfo } from '@omakase/providers';
import { startWebServer } from './commands/web.ts';

class FakeHarness implements Harness {
  readonly id = 'fake';
  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    return { text: 'ok', status: 'ok', sessionId: 's', tokens: 1, costUsd: 0, activities: [], durationMs: 1, provider: req.provider };
  }
  async listProviders(): Promise<ProviderInfo[]> {
    return [{ id: 'claude', command: 'claude', label: 'Claude', available: true, version: '1', path: '/c', models: [] }];
  }
}

function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'omks-web-'));
  const workspace = Workspace.init(dir);
  const store = new Store(':memory:');
  const bus = new RunBus();
  const server = startWebServer({ workspace, store, port: 0, bus, harness: new FakeHarness() });
  return {
    store,
    bus,
    base: `http://localhost:${server.port}`,
    cleanup: () => {
      server.stop(true);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A run already persisted as finished — its `run:ended` lands in SSE replay. */
function finishedRun(store: Store): RunId {
  const id = newRunId();
  const now = Date.now();
  const goal = { text: 'already done' };
  store.createRun({
    id,
    sessionId: null,
    mode: 'goal',
    workflow: 'goal',
    status: 'succeeded',
    goal,
    title: 'already done',
    summary: 'done',
    spentAgents: 0,
    budgetAgents: null,
    spentTokens: 0,
    spentCostUsd: 0,
    lastSeq: 0,
    checkpointSeq: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    rateLimitedUntil: null,
  });
  store.appendEvent(id, 'run:started', { goal, workflow: 'goal' });
  store.appendEvent(id, 'run:ended', { status: 'succeeded', summary: 'done' });
  return id;
}

/** RunBus keeps per-run listeners private; the leak is only visible from inside. */
function listenerCount(bus: RunBus, id: RunId): number {
  const byRun = (bus as unknown as { byRun: Map<RunId, Set<unknown>> }).byRun;
  return byRun.get(id)?.size ?? 0;
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
}

test('web: POST /api/run answers with an error when the run fails to start', async () => {
  const t = ctx();
  try {
    // runGoal rejects in prepare(), before any event carries the run id.
    const res = await fetch(`${t.base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', workflow: 'no-such-workflow' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('No such workflow');
  } finally {
    t.cleanup();
  }
});

test('web: POST /api/run still starts a run that can start', async () => {
  const t = ctx();
  try {
    const res = await fetch(`${t.base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', workflow: 'solo' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runId: string }).runId).toBeTruthy();
  } finally {
    t.cleanup();
  }
});

test('web: repeated SSE connections to a finished run do not leak bus listeners', async () => {
  const t = ctx();
  try {
    const id = finishedRun(t.store);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${t.base}/api/runs/${id}/stream`, { signal: AbortSignal.timeout(5000) });
      // The server closes the stream itself on run:ended, so this resolves.
      const body = await res.text();
      expect(body).toContain('run:ended');
      expect(listenerCount(t.bus, id)).toBe(0);
    }
  } finally {
    t.cleanup();
  }
});

test('web: an SSE connection to a live run unsubscribes once the run ends', async () => {
  const t = ctx();
  try {
    const id = newRunId();
    const now = Date.now();
    t.store.createRun({
      id,
      sessionId: null,
      mode: 'goal',
      workflow: 'goal',
      status: 'running',
      goal: { text: 'live' },
      title: 'live',
      summary: null,
      spentAgents: 0,
      budgetAgents: null,
      spentTokens: 0,
      spentCostUsd: 0,
      lastSeq: 0,
      checkpointSeq: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      rateLimitedUntil: null,
    });
    // A live run has nothing to replay, so the response stays byte-less (and the
    // fetch unresolved) until an event arrives — subscribe, then emit.
    const resP = fetch(`${t.base}/api/runs/${id}/stream`, { signal: AbortSignal.timeout(8000) });
    await waitFor(() => listenerCount(t.bus, id) === 1);
    t.bus.emit(t.store.appendEvent(id, 'run:ended', { status: 'succeeded', summary: 'done' }));
    expect(await (await resP).text()).toContain('run:ended');
    expect(listenerCount(t.bus, id)).toBe(0);
  } finally {
    t.cleanup();
  }
});
