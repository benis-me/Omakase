// The unified turn runner: given a provider + context, spawn the CLI, stream
// its output through the provider's parser, and return a normalized result.

import { readFileSync, existsSync, rmSync } from 'node:fs';
import type { AgentActivity } from '@omakase/core';
import type { AgentProvider, TurnContext, AgentTurnResult } from './types.ts';
import { BunSpawner, type ProcessSpawner } from './spawn.ts';
import { agentSpawnEnv } from './env.ts';
import { resolveBin } from './detect.ts';
import { isNoise } from './parsers.ts';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const DEFAULT_MAX_STDOUT = 64 << 20; // 64 MiB

export interface RunTurnOptions {
  spawner?: ProcessSpawner;
  onActivity?: (a: AgentActivity) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  /** Override the binary path (else resolved from PATH). */
  command?: string;
  /** Extra environment (e.g. API keys). */
  env?: Record<string, string>;
}

export async function runTurn(
  provider: AgentProvider,
  ctx: TurnContext,
  opts: RunTurnOptions = {},
): Promise<AgentTurnResult> {
  const spawner = opts.spawner ?? new BunSpawner();
  const plan = provider.plan(ctx);
  const parser = provider.createParser();
  const activities: AgentActivity[] = [];
  const started = Date.now();

  const command = opts.command ?? resolveBin(provider.command) ?? provider.command;
  const env = agentSpawnEnv(opts.env);

  const result = await spawner.run({
    command,
    args: plan.args,
    cwd: ctx.cwd,
    env,
    ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxStdoutBytes: opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT,
    ...(opts.signal ? { signal: opts.signal } : {}),
    onStdoutLine: (line) => {
      const acts = parser.onLine(line);
      for (const a of acts) {
        activities.push(a);
        opts.onActivity?.(a);
      }
    },
  });

  // Some providers write their final message to a file.
  let lastMessageFileContent: string | undefined;
  if (plan.lastMessageFile && existsSync(plan.lastMessageFile)) {
    try {
      lastMessageFileContent = readFileSync(plan.lastMessageFile, 'utf8');
    } catch {
      /* ignore */
    } finally {
      try {
        rmSync(plan.lastMessageFile, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const core = parser.finalize({
    exitCode: result.exitCode,
    stderrTail: result.stderrTail,
    ...(lastMessageFileContent !== undefined ? { lastMessageFileContent } : {}),
  });

  // Surface spawn-level failures as errors with a helpful message.
  let text = core.text;
  let status = core.status;
  if (result.timedOut) {
    status = 'error';
    text = text || `Timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`;
  } else if (result.aborted) {
    status = 'error';
    text = text || 'Cancelled';
  } else if (result.outputOverflow) {
    status = 'error';
    text = text || 'Output exceeded limit';
  } else if (result.exitCode !== 0 && !text) {
    status = 'error';
    // Prefer the real error over warning banners (e.g. gemini's "YOLO mode").
    const stderrLines = result.stderrTail
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !isNoise(l));
    text = stderrLines.slice(-6).join('\n') || `Exited with code ${result.exitCode}`;
  }

  return {
    ...core,
    text,
    status,
    activities,
    durationMs: Date.now() - started,
  };
}
