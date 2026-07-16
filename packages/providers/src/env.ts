// Environment construction for spawned agent CLIs.

import { dirname } from 'node:path';
import { commonBinDirs } from '@omakase/core';

/**
 * Build a PATH that includes the dirs where agent CLIs commonly live, so a
 * process launched from a minimal environment (Finder, launchd, a TUI) can
 * still find `codex`, `gemini`, etc.
 */
export function augmentedPath(base = process.env.PATH ?? ''): string {
  const extra = [dirname(process.execPath), ...commonBinDirs()];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of [...extra, ...base.split(':')]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  }
  return parts.join(':');
}

/** Environment for a spawned agent: augmented PATH + pass-through, minus hooks. */
export function agentSpawnEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.PATH = augmentedPath(env.PATH);
  // Keep nested agent invocations lean and non-interactive.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.CI = env.CI ?? '1';
  if (extra) Object.assign(env, extra);
  return env;
}
