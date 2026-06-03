/**
 * `@omakase/daemon/testing` — fakes and fixtures for exercising the runtime
 * without real agent binaries or processes.
 *
 * The centrepiece is {@link createFakeTransport}: a {@link Transport} whose
 * spawned "processes" are driven entirely by a handler you supply, so a test
 * can script stdout, react to stdin (for interactive protocols like pi RPC),
 * simulate spawn failures (ENOENT) and signals, all synchronously and
 * deterministically.
 */
import { AgentSpawnError } from '../runtime/errors.js';
import { createPushStream } from '../runtime/push-stream.js';
import type {
  ProcessExit,
  SpawnRequest,
  Transport,
  TransportProcess,
} from '../runtime/transport.js';
import type { AgentEvent } from '../protocol/events.js';

export interface FakeProcessController {
  readonly request: SpawnRequest;
  emitStdout(text: string): void;
  emitStderr(text: string): void;
  /** Emit a single object as a JSONL line on stdout. */
  emitStdoutJson(value: unknown): void;
  /** Settle the process exit. Pass `code: null` with a signal to simulate a signal-kill. */
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
  /** Reject the spawn (e.g. simulate ENOENT for a missing binary). */
  failSpawn(error: unknown): void;
  onStdin(listener: (data: string) => void): void;
  onStdinEnd(listener: () => void): void;
  onKill(listener: (signal?: NodeJS.Signals) => void): void;
  readonly killed: boolean;
}

export type FakeSpawnHandler = (
  controller: FakeProcessController,
) => void | Promise<void>;

export interface FakeTransport extends Transport {
  /** Every spawn request, in order, for assertions. */
  readonly calls: SpawnRequest[];
}

export function createFakeTransport(handler: FakeSpawnHandler): FakeTransport {
  const calls: SpawnRequest[] = [];
  return {
    calls,
    spawn(request: SpawnRequest): TransportProcess {
      calls.push(request);
      const stdout = createPushStream<string>();
      const stderr = createPushStream<string>();
      let settled = false;
      let killed = false;
      let resolveExit!: (exit: ProcessExit) => void;
      let rejectExit!: (error: unknown) => void;
      const exitPromise = new Promise<ProcessExit>((resolve, reject) => {
        resolveExit = resolve;
        rejectExit = reject;
      });

      const stdinChunks: string[] = [];
      let stdinEnded = false;
      const stdinListeners: Array<(data: string) => void> = [];
      const stdinEndListeners: Array<() => void> = [];
      const killListeners: Array<(signal?: NodeJS.Signals) => void> = [];

      const settleExit = (exit: ProcessExit): void => {
        if (settled) return;
        settled = true;
        stdout.end();
        stderr.end();
        resolveExit(exit);
      };

      const controller: FakeProcessController = {
        request,
        emitStdout: (text) => stdout.push(text),
        emitStderr: (text) => stderr.push(text),
        emitStdoutJson: (value) => stdout.push(`${JSON.stringify(value)}\n`),
        exit: (code: number | null = 0, signal: NodeJS.Signals | null = null) =>
          settleExit({ code, signal }),
        failSpawn: (error) => {
          if (settled) return;
          settled = true;
          const wrapped =
            error instanceof Error
              ? error
              : new AgentSpawnError(String(error));
          stdout.fail(wrapped);
          stderr.fail(wrapped);
          rejectExit(wrapped);
        },
        onStdin: (listener) => {
          stdinListeners.push(listener);
          // Replay anything written before this listener attached so the
          // test's listener-registration order never races stdin writes.
          for (const chunk of stdinChunks) listener(chunk);
        },
        onStdinEnd: (listener) => {
          stdinEndListeners.push(listener);
          if (stdinEnded) listener();
        },
        onKill: (listener) => killListeners.push(listener),
        get killed() {
          return killed;
        },
      };

      if (request.signal) {
        const onAbort = (): void => {
          killed = true;
          for (const listener of killListeners) listener('SIGTERM');
        };
        if (request.signal.aborted) queueMicrotask(onAbort);
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Invoke the handler synchronously so its listener registrations are in
      // place before the caller can write to stdin. Async handler bodies still
      // resume on later ticks; a rejection becomes a spawn failure.
      try {
        const maybe = handler(controller) as unknown;
        if (maybe && typeof (maybe as PromiseLike<void>).then === 'function') {
          void (maybe as PromiseLike<void>).then(undefined, (err: unknown) =>
            controller.failSpawn(err),
          );
        }
      } catch (err) {
        controller.failSpawn(err);
      }

      return {
        pid: 1,
        stdout: stdout.iterable,
        stderr: stderr.iterable,
        writeStdin: (data) => {
          stdinChunks.push(data);
          for (const listener of stdinListeners) listener(data);
        },
        endStdin: () => {
          stdinEnded = true;
          for (const listener of stdinEndListeners) listener();
        },
        wait: () => exitPromise,
        kill: (signal) => {
          killed = true;
          for (const listener of killListeners) listener(signal);
        },
      };
    },
  };
}

export interface ScriptedSpawn {
  /** Lines emitted on stdout (each gets a trailing newline). */
  stdout?: string[];
  /** Lines emitted on stderr. */
  stderr?: string[];
  exitCode?: number;
}

/**
 * A non-interactive transport: each spawn emits scripted stdout/stderr lines
 * then exits. Pass a single script reused for every spawn, or an array
 * consumed one entry per spawn. Useful for line-oriented parsers (Claude
 * stream-json, Codex JSON, plain text) where the agent does not read stdin.
 */
export function scriptedTransport(
  script: ScriptedSpawn | ScriptedSpawn[],
): FakeTransport {
  const scripts = Array.isArray(script) ? script : null;
  let index = 0;
  return createFakeTransport((ctrl) => {
    const current: ScriptedSpawn = scripts
      ? (scripts[Math.min(index, scripts.length - 1)] ?? {})
      : (script as ScriptedSpawn);
    index += 1;
    ctrl.onKill(() => ctrl.exit(143, 'SIGTERM'));
    for (const line of current.stdout ?? []) ctrl.emitStdout(`${line}\n`);
    for (const line of current.stderr ?? []) ctrl.emitStderr(`${line}\n`);
    ctrl.exit(current.exitCode ?? 0);
  });
}

/** Collect an async event stream into an array (test convenience). */
export async function drainEvents(
  events: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Collect any async iterable into an array. */
export async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}
