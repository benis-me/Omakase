// Process spawning: run an agent CLI, stream its stdout line-by-line, enforce
// timeouts and output ceilings, and cancel reliably by killing the whole
// process group (the CLI and any children it spawns).

import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  onStdoutLine: (line: string) => void;
  onStderrChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
}

export interface SpawnResult {
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  outputOverflow: boolean;
}

export interface ProcessSpawner {
  run(req: SpawnRequest): Promise<SpawnResult>;
}

const IS_WIN = process.platform === 'win32';
const KILL_GRACE_MS = 2000;
const STDERR_TAIL_BYTES = 1 << 20; // 1 MiB

function terminateGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    if (!IS_WIN) {
      // Negative pid => the whole process group (child was detached).
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Real spawner backed by node:child_process (fully supported on Bun). */
export class BunSpawner implements ProcessSpawner {
  run(req: SpawnRequest): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
      const child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: req.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !IS_WIN,
      });

      let settled = false;
      let timedOut = false;
      let aborted = false;
      let outputOverflow = false;
      let stdoutBytes = 0;

      const outDecoder = new StringDecoder('utf8');
      // Stateful too: a chunk boundary can fall inside a multi-byte character,
      // and stderrTail is surfaced to the user verbatim on a failing run.
      const errDecoder = new StringDecoder('utf8');
      let lineBuf = '';
      const stderrChunks: string[] = [];
      let stderrLen = 0;

      const pushStderr = (s: string) => {
        if (!s) return;
        stderrLen += s.length;
        stderrChunks.push(s);
        // Keep only a bounded tail.
        while (stderrLen > STDERR_TAIL_BYTES && stderrChunks.length > 1) {
          stderrLen -= stderrChunks.shift()!.length;
        }
      };

      const done = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        // Flush any trailing partial line.
        const rest = outDecoder.end();
        if (rest) lineBuf += rest;
        if (lineBuf.length) {
          for (const line of lineBuf.split('\n')) if (line.length) safeLine(line);
        }
        pushStderr(errDecoder.end());
        resolve({
          exitCode,
          stderrTail: stderrChunks.join('').slice(-STDERR_TAIL_BYTES),
          timedOut,
          aborted,
          outputOverflow,
        });
      };

      const safeLine = (line: string) => {
        try {
          req.onStdoutLine(line);
        } catch {
          /* parser errors must not kill the run */
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminateGroup(child, 'SIGTERM');
        setTimeout(() => terminateGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      }, req.timeoutMs);

      const onAbort = () => {
        aborted = true;
        terminateGroup(child, 'SIGTERM');
        setTimeout(() => terminateGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      };
      if (req.signal) {
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (buf: Buffer) => {
        stdoutBytes += buf.length;
        if (stdoutBytes > req.maxStdoutBytes) {
          outputOverflow = true;
          terminateGroup(child, 'SIGKILL');
          return;
        }
        lineBuf += outDecoder.write(buf);
        let nl = lineBuf.indexOf('\n');
        while (nl !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          if (line.length) safeLine(line);
          nl = lineBuf.indexOf('\n');
        }
      });

      child.stderr?.on('data', (buf: Buffer) => {
        const s = errDecoder.write(buf);
        if (!s) return; // chunk ended mid-character; wait for the rest
        pushStderr(s);
        req.onStderrChunk?.(s);
      });

      child.on('error', (err) => {
        pushStderr(`\n[spawn error] ${(err as Error).message}\n`);
        done(127);
      });

      child.on('close', (code) => done(code ?? (aborted || timedOut ? 130 : 1)));

      if (req.stdin != null) {
        child.stdin?.write(req.stdin);
      }
      child.stdin?.end();
    });
  }
}
