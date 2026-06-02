/**
 * Agent detection: turn each {@link RuntimeAgentDef} into a
 * {@link DetectedAgent} by resolving its binary, probing `--version`/`--help`,
 * listing models, and inferring auth status.
 *
 * Two invariants matter:
 *   1. Fault isolation — one adapter that throws never collapses the whole
 *      result set (each probe is wrapped in {@link safeProbe}).
 *   2. Probe the path that will actually be spawned, not just the PATH-visible
 *      name, so the UI never advertises a ghost binary.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errnoCode } from '../runtime/errors.js';
import { execCollect } from '../runtime/exec.js';
import { createNodeTransport, type Transport } from '../runtime/transport.js';
import {
  computePathDirs,
  resolveExecutable,
  type ExecutableResolveContext,
} from './executables.js';
import type { RuntimeRegistry } from './registry.js';
import type {
  AuthStatus,
  DetectedAgent,
  ModelProbeRunner,
  RuntimeAgentDef,
  RuntimeCapabilityMap,
  RuntimeModelSource,
} from './types.js';

export interface DetectionOptions {
  transport?: Transport;
  env?: Record<string, string | undefined>;
  extraPathDirs?: string[];
  /** Augment PATH with well-known user toolchain dirs (default true). */
  includeWellKnownPathDirs?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
  /** Working directory passed to probe spawns. */
  cwd?: string;
}

interface ResolvedDetectionContext {
  transport: Transport;
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  cwd: string | undefined;
  resolveCtx: ExecutableResolveContext;
}

function resolveContext(options: DetectionOptions): ResolvedDetectionContext {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const pathDirs = computePathDirs({
    env,
    extraPathDirs: options.extraPathDirs,
    includeWellKnown: options.includeWellKnownPathDirs ?? true,
    home,
    platform,
  });
  return {
    transport: options.transport ?? createNodeTransport(),
    env,
    home,
    platform,
    cwd: options.cwd,
    resolveCtx: { env, pathDirs, home, platform },
  };
}

function probeEnv(def: RuntimeAgentDef, base: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...base, ...(def.env ?? {}) } as NodeJS.ProcessEnv;
}

function baseDetected(
  def: RuntimeAgentDef,
): Omit<
  DetectedAgent,
  | 'available'
  | 'path'
  | 'version'
  | 'models'
  | 'modelsSource'
  | 'capabilities'
  | 'authStatus'
  | 'authMessage'
> {
  return {
    id: def.id,
    name: def.name,
    bin: def.bin,
    streamFormat: def.streamFormat,
    promptViaStdin: Boolean(def.promptViaStdin),
    supportsImagePaths: Boolean(def.supportsImagePaths),
    supportsCustomModel: def.supportsCustomModel ?? true,
    reasoningOptions: def.reasoningOptions ?? [],
    externalMcpInjection: def.externalMcpInjection,
    installUrl: def.installUrl,
    docsUrl: def.docsUrl,
  };
}

function unavailable(def: RuntimeAgentDef): DetectedAgent {
  return {
    ...baseDetected(def),
    available: false,
    path: undefined,
    version: null,
    models: def.fallbackModels,
    modelsSource: 'fallback',
    capabilities: { ...(def.capabilities ?? {}) },
    authStatus: 'unknown',
    authMessage: undefined,
  };
}

interface VersionOutcome {
  invocable: boolean;
  version: string | null;
}

function extractErrno(err: unknown): string | undefined {
  const direct = errnoCode(err);
  if (direct) return direct;
  if (err && typeof err === 'object') {
    const detail = (err as { detail?: { errno?: unknown } }).detail;
    if (detail && typeof detail.errno === 'string') return detail.errno;
    const cause = (err as { cause?: unknown }).cause;
    if (cause) return errnoCode(cause);
  }
  return undefined;
}

async function probeVersion(
  def: RuntimeAgentDef,
  bin: string,
  env: NodeJS.ProcessEnv,
  ctx: ResolvedDetectionContext,
): Promise<VersionOutcome> {
  try {
    const result = await execCollect(
      ctx.transport,
      { command: bin, args: def.versionArgs, env, cwd: ctx.cwd },
      { timeoutMs: def.versionProbeTimeoutMs ?? 3000 },
    );
    // A shim that ran but whose delegate is missing exits 126/127.
    if (result.exit.code === 126 || result.exit.code === 127) {
      return { invocable: false, version: null };
    }
    const version = result.stdout.trim().split('\n')[0]?.trim() || null;
    return { invocable: true, version };
  } catch (err) {
    const errno = extractErrno(err);
    if (errno === 'ENOENT' || errno === 'EACCES' || errno === 'ENOTDIR') {
      return { invocable: false, version: null };
    }
    // Spawned but the probe was unhappy (timeout, generic non-zero): the CLI
    // is invocable, we just could not read a version string.
    return { invocable: true, version: null };
  }
}

async function probeCapabilities(
  def: RuntimeAgentDef,
  bin: string,
  env: NodeJS.ProcessEnv,
  ctx: ResolvedDetectionContext,
): Promise<RuntimeCapabilityMap> {
  const caps: RuntimeCapabilityMap = { ...(def.capabilities ?? {}) };
  if (!def.helpArgs || !def.capabilityFlags) return caps;
  try {
    const result = await execCollect(
      ctx.transport,
      { command: bin, args: def.helpArgs, env, cwd: ctx.cwd },
      { timeoutMs: 5000 },
    );
    const text = `${result.stdout}\n${result.stderr}`;
    for (const [flag, key] of Object.entries(def.capabilityFlags)) {
      caps[key] = text.includes(flag);
    }
  } catch {
    // Leave caps at the static baseline if --help fails.
  }
  return caps;
}

async function fetchModels(
  def: RuntimeAgentDef,
  bin: string,
  env: NodeJS.ProcessEnv,
  ctx: ResolvedDetectionContext,
): Promise<{ models: DetectedAgent['models']; source: RuntimeModelSource }> {
  const fallback = { models: def.fallbackModels, source: 'fallback' as const };
  const run: ModelProbeRunner = async (args, opts) => {
    const r = await execCollect(
      ctx.transport,
      { command: bin, args, env, cwd: ctx.cwd },
      { timeoutMs: opts?.timeoutMs ?? 5000 },
    );
    return { stdout: r.stdout, stderr: r.stderr, code: r.exit.code };
  };

  if (def.fetchModels) {
    try {
      const parsed = await def.fetchModels(bin, env, run);
      if (parsed && parsed.length > 0) return { models: parsed, source: 'live' };
    } catch {
      /* fall through to fallback */
    }
    return fallback;
  }

  if (def.listModels) {
    try {
      const r = await run(def.listModels.args, {
        timeoutMs: def.listModels.timeoutMs ?? 5000,
      });
      const parsed = def.listModels.parse(r.stdout);
      if (parsed && parsed.length > 0) return { models: parsed, source: 'live' };
    } catch {
      /* fall through */
    }
    return fallback;
  }

  return fallback;
}

function probeAuth(
  def: RuntimeAgentDef,
  ctx: ResolvedDetectionContext,
): { status: AuthStatus; message: string | undefined } {
  const hints = def.auth;
  if (!hints) return { status: 'unknown', message: undefined };
  for (const envVar of hints.envVars ?? []) {
    if (ctx.env[envVar]) return { status: 'ok', message: undefined };
  }
  for (const file of hints.homeFiles ?? []) {
    if (existsSync(path.join(ctx.home, file))) {
      return { status: 'ok', message: undefined };
    }
  }
  const declared =
    (hints.envVars?.length ?? 0) > 0 || (hints.homeFiles?.length ?? 0) > 0;
  if (declared) {
    const envList = (hints.envVars ?? []).join(' / ');
    return {
      status: 'missing',
      message: envList
        ? `No credentials found — set ${envList} or sign in to ${def.name}`
        : `No credentials found — sign in to ${def.name}`,
    };
  }
  return { status: 'unknown', message: undefined };
}

async function probe(
  def: RuntimeAgentDef,
  ctx: ResolvedDetectionContext,
): Promise<DetectedAgent> {
  const resolution = resolveExecutable(def, ctx.resolveCtx);
  if (!resolution.selectedPath) return unavailable(def);

  const env = probeEnv(def, ctx.env);
  const version = await probeVersion(def, resolution.selectedPath, env, ctx);
  if (!version.invocable) return unavailable(def);

  const [capabilities, models, auth] = await Promise.all([
    probeCapabilities(def, resolution.selectedPath, env, ctx),
    fetchModels(def, resolution.selectedPath, env, ctx),
    Promise.resolve(probeAuth(def, ctx)),
  ]);

  return {
    ...baseDetected(def),
    available: true,
    path: resolution.selectedPath,
    version: version.version,
    models: models.models,
    modelsSource: models.source,
    capabilities,
    authStatus: auth.status,
    authMessage: auth.message,
  };
}

async function safeProbe(
  def: RuntimeAgentDef,
  ctx: ResolvedDetectionContext,
): Promise<DetectedAgent> {
  try {
    return await probe(def, ctx);
  } catch {
    // Fault isolation: a single adapter blowing up must not collapse the
    // entire agent listing.
    return unavailable(def);
  }
}

export interface ResolvedRuntime {
  bin: string;
  capabilities: RuntimeCapabilityMap;
}

/**
 * Lighter than {@link detectAgent}: resolve the binary and probe capabilities
 * only (no model/auth probes), for use right before a run. Returns null if the
 * agent is not installed or not invocable.
 */
export async function resolveRuntime(
  def: RuntimeAgentDef,
  options: DetectionOptions = {},
): Promise<ResolvedRuntime | null> {
  const ctx = resolveContext(options);
  const resolution = resolveExecutable(def, ctx.resolveCtx);
  if (!resolution.selectedPath) return null;
  const env = probeEnv(def, ctx.env);
  const version = await probeVersion(def, resolution.selectedPath, env, ctx);
  if (!version.invocable) return null;
  const capabilities = await probeCapabilities(def, resolution.selectedPath, env, ctx);
  return { bin: resolution.selectedPath, capabilities };
}

/** Detect a single agent definition. */
export async function detectAgent(
  def: RuntimeAgentDef,
  options: DetectionOptions = {},
): Promise<DetectedAgent> {
  return safeProbe(def, resolveContext(options));
}

/** Detect every agent in the registry, concurrently and fault-isolated. */
export async function detectAgents(
  registry: RuntimeRegistry,
  options: DetectionOptions = {},
): Promise<DetectedAgent[]> {
  const ctx = resolveContext(options);
  return Promise.all(registry.list().map((def) => safeProbe(def, ctx)));
}
