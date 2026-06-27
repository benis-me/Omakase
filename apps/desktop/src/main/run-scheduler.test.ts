import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWorkspace, saveTrigger } from '@omakase/storage';
import { nextDailyDelayMs, RunScheduler, shouldFire, TRIGGER_COOLDOWN_MS } from './run-scheduler.js';
import type { RunHost } from './run-host.js';
import type { WorkspaceHost } from './workspace-host.js';

const liveSet = (ids: string[]) => (id: string): boolean => ids.includes(id);

describe('shouldFire — trigger runaway prevention', () => {
  it('fires a fresh trigger that has never run', () => {
    expect(shouldFire({}, () => false, 1_000)).toBe(true);
  });

  it('skips while the trigger’s prior run is still live (no pile-ups)', () => {
    expect(shouldFire({ lastRunId: 'r1', lastFiredAt: 0 }, liveSet(['r1']), 1_000_000)).toBe(false);
  });

  it('skips within the cooldown window after the last fire (absorbs the run’s own writes)', () => {
    const t0 = 1_000;
    expect(shouldFire({ lastFiredAt: t0 }, () => false, t0 + 5_000)).toBe(false);
    expect(shouldFire({ lastFiredAt: t0 }, () => false, t0 + TRIGGER_COOLDOWN_MS - 1)).toBe(false);
  });

  it('fires again once the prior run ended AND the cooldown elapsed', () => {
    const t0 = 1_000;
    expect(shouldFire({ lastRunId: 'r1', lastFiredAt: t0 }, liveSet([]), t0 + TRIGGER_COOLDOWN_MS + 1)).toBe(true);
  });

  it('cooldown is independent of liveness — a fast run still cools down before re-firing', () => {
    // Run already ended (not live), but only 2s since it fired → still blocked.
    expect(shouldFire({ lastRunId: 'r1', lastFiredAt: 1_000 }, liveSet([]), 3_000)).toBe(false);
  });
});

describe('nextDailyDelayMs', () => {
  it('lands on the requested local time, within the next 24h', () => {
    const now = Date.UTC(2026, 0, 1, 10, 0, 0);
    const delay = nextDailyDelayMs(now, '14:30');
    const fireAt = new Date(now + delay);
    expect(fireAt.getHours()).toBe(14);
    expect(fireAt.getMinutes()).toBe(30);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('rolls to tomorrow when the time already passed today', () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    d.setHours(9, 0, 0, 0); // 09:00 local today
    const now = d.getTime();
    const delay = nextDailyDelayMs(now, '08:00'); // already passed
    expect(new Date(now + delay).getHours()).toBe(8);
    expect(delay).toBeGreaterThan(22 * 3_600_000); // ~tomorrow
  });
});

describe('RunScheduler integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('arms an enabled interval trigger and starts a run on fire', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-sched-'));
    ensureWorkspace(root, { now: 1 });
    saveTrigger(root, {
      name: 'Patrol',
      kind: 'interval',
      prompt: 'check things',
      enabled: true,
      intervalMinutes: 1,
    });

    const startRun = vi.fn((_input: unknown) => 'run-1');
    const host = { activeWorkspace: { root } } as unknown as WorkspaceHost;
    const runs = { startRun, listRuns: () => [] } as unknown as RunHost;
    const scheduler = new RunScheduler(host, runs);

    scheduler.reconfigure();
    expect(startRun).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({ prompt: 'check things', triggeredBy: 'Patrol' });

    scheduler.shutdown();
  });

  it('does not arm a disabled trigger', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-sched-'));
    ensureWorkspace(root, { now: 1 });
    saveTrigger(root, { name: 'Off', kind: 'interval', prompt: 'x', enabled: false, intervalMinutes: 1 });

    const startRun = vi.fn(() => 'r');
    const scheduler = new RunScheduler(
      { activeWorkspace: { root } } as unknown as WorkspaceHost,
      { startRun, listRuns: () => [] } as unknown as RunHost,
    );
    scheduler.reconfigure();
    vi.advanceTimersByTime(120_000);
    expect(startRun).not.toHaveBeenCalled();
    scheduler.shutdown();
  });
});
