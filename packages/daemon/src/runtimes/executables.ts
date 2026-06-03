/**
 * Executable discovery: resolve a runtime def's binary to an absolute path,
 * honouring (1) an env-var override pointing at an absolute path, then
 * (2) `bin` and `fallbackBins` walked across the PATH directories.
 *
 * Resolution is filesystem-based and pure with respect to its inputs: callers
 * pass the env, the ordered PATH directories, and the platform, so detection
 * can be scoped to a temp directory in tests with no global state.
 */
import { accessSync, constants, statSync } from 'node:fs';
import path, { delimiter } from 'node:path';

export interface ExecutableResolveContext {
  env: Record<string, string | undefined>;
  /** Ordered directories to search, already including PATH + extras. */
  pathDirs: string[];
  home: string;
  platform?: NodeJS.Platform;
}

export type ExecutableResolutionSource = 'env-override' | 'path' | null;

export interface ExecutableResolution {
  selectedPath: string | null;
  source: ExecutableResolutionSource;
  binEnvVar: string | undefined;
  /** Binary names that were searched, for diagnostics. */
  probedBins: string[];
  /**
   * Set when `binEnvVar` was provided but pointed at something that didn't
   * resolve to an executable. The agent is reported unavailable (rather than
   * silently substituting a PATH binary) so a clear "override set but not
   * executable" state is surfaceable.
   */
  overrideUnresolved?: string;
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function windowsExecutableExts(env: Record<string, string | undefined>): string[] {
  return (env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
}

function looksExecutableOnWindows(
  filePath: string,
  env: Record<string, string | undefined>,
): boolean {
  const ext = path.extname(filePath).toUpperCase();
  if (!ext) return false;
  return windowsExecutableExts(env)
    .map((e) => e.toUpperCase())
    .includes(ext);
}

/** True if `filePath` is a regular file that the OS would treat as runnable. */
export function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (platform === 'win32') return looksExecutableOnWindows(filePath, env);
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveAbsoluteOverride(
  raw: string | undefined,
  ctx: ExecutableResolveContext,
): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const platform = ctx.platform ?? process.platform;
  const expanded = expandHome(raw.trim(), ctx.home);
  if (!path.isAbsolute(expanded)) return null;
  return isExecutableFile(expanded, platform, ctx.env) ? expanded : null;
}

export function resolveOnPath(
  bin: string,
  ctx: ExecutableResolveContext,
): string | null {
  const platform = ctx.platform ?? process.platform;
  const exts = platform === 'win32' ? windowsExecutableExts(ctx.env) : [''];
  for (const dir of ctx.pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (isExecutableFile(candidate, platform, ctx.env)) return candidate;
    }
  }
  return null;
}

export function resolveExecutable(
  def: { bin: string; fallbackBins?: string[]; binEnvVar?: string },
  ctx: ExecutableResolveContext,
): ExecutableResolution {
  const binEnvVar = def.binEnvVar;
  const overrideRaw = binEnvVar ? ctx.env[binEnvVar] : undefined;
  const override = overrideRaw ? resolveAbsoluteOverride(overrideRaw, ctx) : null;
  const probedBins = [def.bin, ...(def.fallbackBins ?? [])];
  if (override) {
    return { selectedPath: override, source: 'env-override', binEnvVar, probedBins };
  }
  // An operator who pinned a binary via binEnvVar but whose value doesn't
  // resolve must NOT silently fall through to a PATH binary (that would run a
  // different agent than pinned). Fail closed and surface the bad override.
  if (typeof overrideRaw === 'string' && overrideRaw.trim() !== '') {
    return {
      selectedPath: null,
      source: null,
      binEnvVar,
      probedBins,
      overrideUnresolved: overrideRaw,
    };
  }
  for (const bin of probedBins) {
    const resolved = resolveOnPath(bin, ctx);
    if (resolved) {
      return { selectedPath: resolved, source: 'path', binEnvVar, probedBins };
    }
  }
  return { selectedPath: null, source: null, binEnvVar, probedBins };
}

/**
 * Well-known directories where user-level CLIs install, beyond the inherited
 * PATH. GUI-launched apps often start with a minimal PATH; including these
 * keeps detection aligned with what a shell would find.
 */
export function wellKnownToolchainDirs(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    return [
      path.join(home, 'AppData', 'Local', 'Programs'),
      path.join(home, '.local', 'bin'),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.deno', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
}

export function computePathDirs(options: {
  env: Record<string, string | undefined>;
  extraPathDirs?: string[];
  includeWellKnown?: boolean;
  home: string;
  platform?: NodeJS.Platform;
}): string[] {
  const platform = options.platform ?? process.platform;
  const fromPath = (options.env.PATH ?? options.env.Path ?? '').split(delimiter);
  const dirs = [
    ...fromPath,
    ...(options.extraPathDirs ?? []),
    ...(options.includeWellKnown
      ? wellKnownToolchainDirs(options.home, platform)
      : []),
  ];
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}
