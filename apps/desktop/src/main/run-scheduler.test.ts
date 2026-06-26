import { describe, expect, it } from 'vitest';
import { shouldFire, TRIGGER_COOLDOWN_MS } from './run-scheduler.js';

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
