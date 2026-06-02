/**
 * Helpers that turn a "driver" (an async function that pushes events) into a
 * well-behaved {@link AgentEvent} stream that always terminates with exactly
 * one `done` event — `completed`/`cancelled` from the driver's return value,
 * or `error` synthesized from a thrown error.
 */
import { AgentCancelledError, errorMessage } from './errors.js';
import type { AgentEndReason, AgentEvent } from '../protocol/events.js';
import { createPushStream } from './push-stream.js';
import type { ExecutorContext } from './executor.js';

export type StreamDriver = (
  push: (event: AgentEvent) => void,
  ctx: ExecutorContext,
) => Promise<AgentEndReason>;

export function streamFromDriver(
  ctx: ExecutorContext,
  driver: StreamDriver,
): AsyncIterable<AgentEvent> {
  const out = createPushStream<AgentEvent>();
  void driver((event) => out.push(event), ctx).then(
    (reason) => {
      out.push({ type: 'done', reason });
      out.end();
    },
    (err: unknown) => {
      const reason: AgentEndReason =
        err instanceof AgentCancelledError ? 'cancelled' : 'error';
      out.push({ type: 'error', message: errorMessage(err), raw: err });
      out.push({ type: 'done', reason });
      out.end();
    },
  );
  return out.iterable;
}

/** A stream that immediately reports an error and terminates. */
export async function* errorStream(err: unknown): AsyncIterable<AgentEvent> {
  yield { type: 'error', message: errorMessage(err), raw: err };
  yield { type: 'done', reason: err instanceof AgentCancelledError ? 'cancelled' : 'error' };
}

/**
 * Build a stream whose source is resolved asynchronously. Used when the agent
 * binary must be detected before the real executor can run; a failure during
 * resolution surfaces as an error event rather than a thrown promise.
 */
export async function* deferStream(
  factory: () => Promise<AsyncIterable<AgentEvent>>,
): AsyncIterable<AgentEvent> {
  let iterable: AsyncIterable<AgentEvent>;
  try {
    iterable = await factory();
  } catch (err) {
    yield* errorStream(err);
    return;
  }
  yield* iterable;
}

export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value != null &&
    typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
  );
}

export async function* arrayToAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
