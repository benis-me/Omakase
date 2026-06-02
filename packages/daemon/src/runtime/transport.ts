/**
 * The process transport seam.
 *
 * Everything that runs an external agent CLI goes through a {@link Transport}.
 * The production transport ({@link createNodeTransport}) wraps
 * `child_process.spawn`; tests swap in a fake transport (see
 * `@omakase/daemon/testing`) that scripts stdout/stderr and reacts to stdin,
 * so the entire execution and protocol stack can be exercised with no real
 * binaries, no network, and deterministic timing.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { AgentSpawnError, errnoCode, errorMessage } from './errors.js';
import { createPushStream } from './push-stream.js';

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Aborting this signal terminates the spawned process with SIGTERM. */
  signal?: AbortSignal;
}

export interface TransportProcess {
  /** Process id, or undefined if the spawn never produced one. */
  readonly pid: number | undefined;
  /** stdout decoded as UTF-8 text chunks. */
  readonly stdout: AsyncIterable<string>;
  /** stderr decoded as UTF-8 text chunks. */
  readonly stderr: AsyncIterable<string>;
  writeStdin(data: string): void;
  endStdin(): void;
  /** Resolves on process exit; rejects with {@link AgentSpawnError} on failure. */
  wait(): Promise<ProcessExit>;
  kill(signal?: NodeJS.Signals): void;
}

export interface Transport {
  spawn(request: SpawnRequest): TransportProcess;
}

export function createNodeTransport(): Transport {
  return {
    spawn(request: SpawnRequest): TransportProcess {
      const stdout = createPushStream<string>();
      const stderr = createPushStream<string>();

      let settled = false;
      let resolveExit!: (exit: ProcessExit) => void;
      let rejectExit!: (error: unknown) => void;
      const exitPromise = new Promise<ProcessExit>((resolve, reject) => {
        resolveExit = resolve;
        rejectExit = reject;
      });

      const child = nodeSpawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
      child.stdout?.on('end', () => stdout.end());
      child.stderr?.on('end', () => stderr.end());

      // Swallow EPIPE: writing to stdin after the child has exited is a
      // benign race, not a fatal transport error.
      child.stdin?.on('error', (err: unknown) => {
        if (errnoCode(err) !== 'EPIPE') {
          stdout.fail(err);
        }
      });

      child.on('error', (err: unknown) => {
        if (settled) return;
        settled = true;
        const spawnError = new AgentSpawnError(
          `Failed to spawn "${request.command}": ${errorMessage(err)}`,
          { cause: err, detail: { errno: errnoCode(err) } },
        );
        stdout.fail(spawnError);
        stderr.fail(spawnError);
        rejectExit(spawnError);
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        stdout.end();
        stderr.end();
        if (settled) return;
        settled = true;
        resolveExit({ code, signal });
      });

      const onAbort = (): void => {
        if (!child.killed) child.kill('SIGTERM');
      };
      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }

      return {
        get pid(): number | undefined {
          return child.pid;
        },
        stdout: stdout.iterable,
        stderr: stderr.iterable,
        writeStdin(data: string): void {
          if (child.stdin && !child.stdin.destroyed) child.stdin.write(data);
        },
        endStdin(): void {
          if (child.stdin && !child.stdin.destroyed) child.stdin.end();
        },
        wait(): Promise<ProcessExit> {
          return exitPromise;
        },
        kill(signal: NodeJS.Signals = 'SIGTERM'): void {
          if (!child.killed) child.kill(signal);
        },
      };
    },
  };
}
