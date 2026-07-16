// Provider detection: which agent CLIs are installed, their versions & models.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProviderInfo } from './types.ts';
import { AGENT_PROVIDERS } from './registry.ts';
import { augmentedPath } from './env.ts';

const PROBE_TIMEOUT_MS = 3000;

interface VersionProbe {
  available: boolean;
  version: string | null;
  path: string | null;
}

/** Resolve a command to an absolute path using the augmented PATH. */
export function resolveBin(command: string): string | null {
  return Bun.which(command, { PATH: augmentedPath() });
}

/** Run `<command> --version` with a timeout; success => available. */
export async function probeVersion(command: string): Promise<VersionProbe> {
  const path = resolveBin(command);
  if (!path) return { available: false, version: null, path: null };
  try {
    const proc = Bun.spawn([path, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: augmentedPath() } as Record<string, string>,
    });
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return { available: true, version: null, path }; // present but odd
    const version = out.trim().split('\n')[0]?.trim() || null;
    return { available: true, version, path };
  } catch {
    return { available: true, version: null, path };
  }
}

export interface DetectOptions {
  /** Fetch live model lists (slower). Defaults true. */
  discoverModels?: boolean;
}

/** Detect all known providers in parallel. */
export async function detectProviders(opts: DetectOptions = {}): Promise<ProviderInfo[]> {
  const discover = opts.discoverModels ?? true;
  const results = await Promise.all(
    AGENT_PROVIDERS.map(async (p): Promise<ProviderInfo> => {
      const probe = await probeVersion(p.command);
      let models = p.seedModels.slice();
      if (probe.available && discover && p.discoverModels && probe.path) {
        try {
          const live = await p.discoverModels(probe.path);
          if (live.length) models = live;
        } catch {
          /* keep seeds */
        }
      }
      return {
        id: p.id,
        command: p.command,
        label: p.label,
        available: probe.available,
        version: probe.version,
        path: probe.path,
        models,
        ...(p.fastModel ? { fastModel: p.fastModel } : {}),
      };
    }),
  );
  return results;
}

/** Only the installed providers. */
export async function detectAvailable(opts?: DetectOptions): Promise<ProviderInfo[]> {
  return (await detectProviders(opts)).filter((p) => p.available);
}

// --- caching (.omks/agents.json) ------------------------------------------

interface AgentsCache {
  scannedAt: number;
  providers: ProviderInfo[];
}

export function loadAgentsCache(path: string): ProviderInfo[] | null {
  if (!existsSync(path)) return null;
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8')) as AgentsCache;
    return cache.providers ?? null;
  } catch {
    return null;
  }
}

/** Persist a scan — but never overwrite a good cache with an empty one. */
export function saveAgentsCache(path: string, providers: ProviderInfo[]): void {
  const available = providers.filter((p) => p.available);
  if (available.length === 0) return;
  const cache: AgentsCache = { scannedAt: Date.now(), providers };
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n');
}

/** Cached-first detection: return cache if present, else scan and persist. */
export async function detectCached(cachePath: string, opts?: DetectOptions): Promise<ProviderInfo[]> {
  const cached = loadAgentsCache(cachePath);
  if (cached && cached.some((p) => p.available)) return cached;
  const fresh = await detectProviders(opts);
  saveAgentsCache(cachePath, fresh);
  return fresh;
}
