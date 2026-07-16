// Foundation retry: durable retry of a flaky provider/step call with
// exponential backoff + jitter. Never retries once aborted.

import { sleep, isAbortError } from '@omakase/core';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown; rateLimited: boolean }) => void;
  /** Decide whether an error is worth retrying. Default: yes (unless abort). */
  isRetriable?: (error: unknown) => boolean;
  /** Detect rate-limit / overload errors → back off much harder. */
  isRateLimited?: (error: unknown) => boolean;
  /** Base delay for rate-limited retries (much larger than baseDelayMs). */
  rateLimitBaseMs?: number;
}

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 400;
  const max = opts.maxDelayMs ?? 15_000;
  const rlBase = opts.rateLimitBaseMs ?? 5_000;
  const rlMax = 120_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (isAbortError(err) || err instanceof FatalError) throw err;
      if (opts.isRetriable && !opts.isRetriable(err)) throw err;
      if (attempt >= maxAttempts) break;
      const rateLimited = opts.isRateLimited?.(err) ?? false;
      // Rate limits back off much harder than transient errors.
      const ceiling = rateLimited
        ? Math.min(rlMax, rlBase * 2 ** (attempt - 1))
        : Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.floor(ceiling * (0.5 + Math.random() * 0.5));
      opts.onRetry?.({ attempt, delayMs: delay, error: err, rateLimited });
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}
