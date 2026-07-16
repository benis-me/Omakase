import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdRun } from './commands/run.ts';

/**
 * A ceiling flag is a promise about how far a run may go. Silently falling back
 * to the default (64 agents) when the user asked for something else is the one
 * outcome that must never happen — the flags exist to stop a runaway loop.
 */
for (const bad of [
  ['--max-agents', '0'],
  ['--max-agents', 'abc'],
  ['--max-usd', '-1'],
  ['--concurrency', '0'], // would deadlock the semaphore
  ['--max-rounds', '0'], // would leave no round to run
]) {
  test(`run: rejects ${bad.join(' ')} instead of ignoring it`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omks-limits-'));
    try {
      expect(await cmdRun(['a goal', '--cwd', dir, ...bad])).toBe(1);
      // Bail before touching the disk: a rejected run never started.
      expect(existsSync(join(dir, '.omks'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
