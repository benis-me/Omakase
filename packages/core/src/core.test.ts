import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { Workspace } from './workspace.ts';
import { Budget } from './budget.ts';
import { runId, sessionId } from './ids.ts';
import { bulletLines, slugify, truncate, extractJson } from './util.ts';
import type { RunRecord } from './types.ts';

function newRun(): RunRecord {
  const now = Date.now();
  return {
    id: runId(),
    sessionId: null,
    mode: 'goal',
    workflow: 'goal',
    status: 'pending',
    goal: { text: 'ship it' },
    title: 'ship it',
    summary: null,
    spentAgents: 0,
    budgetAgents: 10,
    spentTokens: 0,
    spentCostUsd: 0,
    lastSeq: 0,
    checkpointSeq: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    rateLimitedUntil: null,
  };
}

test('store: run lifecycle + event log ordering', () => {
  const store = new Store(':memory:');
  const run = store.createRun(newRun());

  const e1 = store.appendEvent(run.id, 'run:started', { goal: run.goal, workflow: 'goal' });
  const e2 = store.appendEvent(run.id, 'log', { level: 'info', message: 'hello' });
  const e3 = store.appendEvent(run.id, 'phase:started', { name: 'Plan', index: 0 });
  expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);

  const all = store.getEvents(run.id);
  expect(all.map((e) => e.type)).toEqual(['run:started', 'log', 'phase:started']);

  const after = store.getEvents(run.id, 1);
  expect(after.map((e) => e.seq)).toEqual([2, 3]);

  // A type filter fetches only the asked-for rows (resume replays 3 of ~13 types).
  const filtered = store.getEvents(run.id, 0, ['log', 'phase:started']);
  expect(filtered.map((e) => e.type)).toEqual(['log', 'phase:started']);
  expect(store.getEvents(run.id, 0, [])).toEqual([]);

  const reread = store.getRun(run.id)!;
  expect(reread.lastSeq).toBe(3);

  store.updateRun(run.id, { status: 'succeeded', summary: 'done' });
  expect(store.getRun(run.id)!.status).toBe('succeeded');

  store.addSpend(run.id, { agents: 2, tokens: 100, costUsd: 0.5 });
  const spent = store.getRun(run.id)!;
  expect(spent.spentAgents).toBe(2);
  expect(spent.spentTokens).toBe(100);
  expect(spent.spentCostUsd).toBeCloseTo(0.5);

  store.close();
});

test('store: tasks, reports, sessions, wiki, kv', () => {
  const store = new Store(':memory:');
  const run = store.createRun(newRun());
  const now = Date.now();

  store.upsertTask({
    runId: run.id,
    id: 't1',
    title: 'build',
    role: 'worker',
    status: 'pending',
    attempts: 0,
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
  });
  store.updateTaskStatus(run.id, 't1', 'done', 1);
  const tasks = store.listTasks(run.id);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.status).toBe('done');
  expect(tasks[0]!.attempts).toBe(1);

  store.addReport({
    runId: run.id,
    id: 'r1',
    kind: 'final',
    title: 'done',
    summary: 'built and validated',
    taskId: 't1',
    authorAgentId: null,
    createdAt: now,
  });
  expect(store.listReports(run.id)).toHaveLength(1);

  const ses = store.createSession({
    id: sessionId(),
    title: 'my session',
    runIds: [run.id],
    rollingSummary: '',
    cwd: '/tmp',
    createdAt: now,
    updatedAt: now,
  });
  store.updateSession(ses.id, { rollingSummary: 'progressing' });
  expect(store.getSession(ses.id)!.rollingSummary).toBe('progressing');
  expect(store.listSessions()).toHaveLength(1);

  store.upsertWiki({ slug: 'arch', title: 'Architecture', body: 'notes', updatedAt: now });
  store.upsertWiki({ slug: 'arch', title: 'Architecture', body: 'updated', updatedAt: now + 1 });
  expect(store.getWiki('arch')!.body).toBe('updated');
  expect(store.listWiki()).toHaveLength(1);

  store.kvSet('foo', { a: 1 });
  expect(store.kvGet<{ a: number }>('foo')!.a).toBe(1);

  store.close();
});

test('store: markInterruptedRuns flips running -> failed', () => {
  const store = new Store(':memory:');
  const r = store.createRun({ ...newRun(), status: 'running' });
  const ids = store.markInterruptedRuns('crash');
  expect(ids).toContain(r.id);
  expect(store.getRun(r.id)!.status).toBe('failed');
  store.close();
});

test('workspace: init + find walks up', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'omks-'));
  try {
    const ws = Workspace.init(tmp, 'proj');
    expect(ws.id).toBeTruthy();
    const nested = join(tmp, 'a', 'b');
    Bun.spawnSync(['mkdir', '-p', nested]);
    const found = Workspace.find(nested);
    expect(found?.root).toBe(ws.root);
    expect(ws.readMemory()).toContain('AGENTS.md');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('budget: charge + remaining', () => {
  const b = new Budget(3);
  expect(b.chargeAgent()).toBe(true);
  expect(b.chargeAgent()).toBe(true);
  expect(b.chargeAgent()).toBe(true);
  expect(b.chargeAgent()).toBe(false);
  expect(b.remainingAgents()).toBe(0);
  expect(b.stopReason()).toBe('max agents reached');
  const unbounded = new Budget(null);
  expect(unbounded.remainingAgents()).toBe(Infinity);
});

test('budget: only a refused call counts as denied, not a spent-out cap', () => {
  const b = new Budget(2);
  b.chargeAgent();
  b.chargeAgent();
  // Exactly on the cap: no headroom left, but every slot did real work.
  expect(b.canSpend()).toBe(false);
  expect(b.deniedReason()).toBe(null);
  expect(b.chargeAgent()).toBe(false);
  expect(b.deniedReason()).toBe('max agents reached');
});

test('budget: cost limit stops charging', () => {
  const b = new Budget(null, { maxUsd: 0.01 });
  expect(b.chargeAgent()).toBe(true);
  b.addUsage(100, 0.02); // over the cost cap
  expect(b.chargeAgent()).toBe(false);
  expect(b.stopReason()).toContain('cost limit');
});

test('budget: wall-clock limit stops charging', () => {
  const b = new Budget(null, { maxWallClockMs: 50, startedAt: Date.now() - 1000 });
  expect(b.canSpend()).toBe(false);
  expect(b.stopReason()).toBe('time limit reached');
});

test('util: bulletLines / slugify / truncate', () => {
  expect(bulletLines('- a\n * b\n 1. c\n\n')).toEqual(['a', 'b', 'c']);
  expect(slugify('Hello, World!')).toBe('hello-world');
  expect(truncate('abcdef', 4)).toBe('abc…');
});

test('util: extractJson pulls balanced JSON out of prose/fences', () => {
  expect(extractJson<{ a: number }>('noise before {"a": 1} and after')).toEqual({ a: 1 });
  expect(extractJson<{ steps: { id: string }[] }>('```json\n{"steps":[{"id":"s1"}]}\n```')).toEqual({
    steps: [{ id: 's1' }],
  });
  // Braces inside strings must not end the object early.
  expect(extractJson<{ s: string }>('{"s": "a } b"}')).toEqual({ s: 'a } b' });
  expect(extractJson<Record<string, unknown>>('no json here')).toBe(null);
});
