/**
 * One-shot command execution over a {@link Transport}: spawn, collect stdout
 * and stderr to completion, and resolve with the exit status. Used by
 * detection (version/help/model probes) and anywhere a non-streaming agent
 * invocation is needed. Routing through the transport keeps these calls fully
 * fakeable in tests.
 */
import { AgentTimeoutError } from './errors.js';
import type { ProcessExit, SpawnRequest, Transport } from './transport.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit: ProcessExit;
}

export interface ExecOptions {
  timeoutMs?: number;
}

async function drainToString(iterable: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of iterable) out += chunk;
  return out;
}

export async function execCollect(
  transport: Transport,
  request: SpawnRequest,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const proc = transport.spawn(request);
  // Attach catch handlers eagerly so a spawn failure (which fails the streams)
  // never surfaces as an unhandled rejection; the authoritative error comes
  // from `wait()` below.
  const stdoutPromise = drainToString(proc.stdout).catch(() => '');
  const stderrPromise = drainToString(proc.stderr).catch(() => '');

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, options.timeoutMs);
  }

  try {
    const exit = await proc.wait();
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (timedOut) {
      throw new AgentTimeoutError(options.timeoutMs!, undefined, {
        detail: { stdout, stderr },
      });
    }
    return { stdout, stderr, exit };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
