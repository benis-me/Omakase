import { test, expect } from 'bun:test';
import { withRetry, FatalError } from './retry.ts';

test('withRetry: succeeds after a transient failure', async () => {
  let n = 0;
  const r = await withRetry(
    async () => {
      n++;
      if (n < 2) throw new Error('transient');
      return 'ok';
    },
    { baseDelayMs: 1 },
  );
  expect(r).toBe('ok');
  expect(n).toBe(2);
});

test('withRetry: never retries a FatalError', async () => {
  let n = 0;
  await expect(
    withRetry(async () => {
      n++;
      throw new FatalError('nope');
    }, { baseDelayMs: 1 }),
  ).rejects.toThrow('nope');
  expect(n).toBe(1);
});

test('withRetry: rate-limited errors back off much harder', async () => {
  const seen: { delay: number; rl: boolean }[] = [];
  await withRetry(
    async (attempt) => {
      if (attempt === 1) throw new Error('429 too many requests');
      return 'ok';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 5,
      rateLimitBaseMs: 200,
      isRateLimited: (e) => /429/.test((e as Error).message),
      onRetry: (i) => seen.push({ delay: i.delayMs, rl: i.rateLimited }),
    },
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]!.rl).toBe(true);
  expect(seen[0]!.delay).toBeGreaterThanOrEqual(100); // >= 0.5 * rateLimitBaseMs
});

test('withRetry: ordinary errors use the small base delay', async () => {
  const seen: number[] = [];
  await withRetry(
    async (attempt) => {
      if (attempt === 1) throw new Error('boom');
      return 'ok';
    },
    {
      baseDelayMs: 4,
      rateLimitBaseMs: 5000,
      isRateLimited: () => false,
      onRetry: (i) => seen.push(i.delayMs),
    },
  );
  expect(seen[0]!).toBeLessThan(20);
});
