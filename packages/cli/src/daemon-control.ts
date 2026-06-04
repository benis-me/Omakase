/**
 * Per-project detached-daemon lifecycle. The TUI/desktop app calls
 * {@link ensureDaemon} to guarantee an `omakase serve --watch` process is
 * running for a project, then talks to it purely through the filesystem
 * (RunStore + control files). The daemon survives the client quitting — that is
 * what makes a submitted run persistent.
 *
 * Discovery is via `<cwd>/.omakase/daemon.json` + a liveness check; spawning is
 * guarded by an exclusive lock so two clients can't race two daemons onto the
 * same runs dir (which would double-drive runs). `spawn`/`isAlive`/`now` are
 * injectable so the discover/reuse/respawn logic is unit-testable without real
 * processes.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

const DAEMON_VERSION = '0.1.0';
/** Reuse a daemon whose pid is alive AND whose heartbeat/startup is within this. */
const REUSE_WINDOW_MS = 30_000;

export interface DaemonInfo {
  pid: number;
  startedAt: number;
  version: string;
  cwd: string;
}

export interface SpawnedDaemon {
  pid: number | undefined;
  unref(): void;
}

export type DaemonSpawn = (
  command: string,
  args: string[],
  logPath: string,
  cwd?: string,
) => SpawnedDaemon;

export interface EnsureDaemonDeps {
  spawn?: DaemonSpawn;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  execPath?: string;
  scriptPath?: string;
}

export interface EnsureDaemonOptions {
  /** Extra args appended after `serve --watch --cwd <cwd>` (dirs, mode, agent…). */
  serveArgs?: string[];
}

/** True if a process with this pid exists (EPERM = exists but not ours). */
export function isDaemonAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

function paths(cwd: string) {
  const dir = path.join(cwd, '.omakase');
  return {
    dir,
    info: path.join(dir, 'daemon.json'),
    lock: path.join(dir, 'daemon.lock'),
    log: path.join(dir, 'daemon.log'),
    heartbeat: path.join(dir, 'daemon-heartbeat'),
  };
}

async function readDaemonInfo(infoPath: string): Promise<DaemonInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(infoPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as DaemonInfo).pid === 'number') {
      return parsed as DaemonInfo;
    }
  } catch {
    /* missing / torn */
  }
  return null;
}

export async function writeDaemonInfo(cwd: string, info: DaemonInfo): Promise<void> {
  const p = paths(cwd);
  await mkdir(p.dir, { recursive: true });
  const tmp = `${p.info}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), 'utf8');
  await rename(tmp, p.info);
}

/** Record a fresh liveness timestamp; the client uses it to judge run staleness. */
export async function touchHeartbeat(cwd: string, at: number): Promise<void> {
  const p = paths(cwd);
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.heartbeat, String(at), 'utf8');
}

const defaultSpawn: DaemonSpawn = (command, args, logPath, cwd) => {
  const fd = openSync(logPath, 'a');
  try {
    const child = nodeSpawn(command, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      ...(cwd ? { cwd } : {}),
    });
    child.unref();
    return { pid: child.pid, unref: () => undefined };
  } finally {
    closeSync(fd); // the child dup'd the fd; close the parent's copy (no leak)
  }
};

interface SpawnPlan {
  command: string;
  args: string[];
  cwd?: string;
}

/** Walk up from a script to the dir whose node_modules has tsx (dev launcher). */
function findTsxRoot(scriptPath: string): string | undefined {
  let dir = path.dirname(scriptPath);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'node_modules', '.bin', 'tsx'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Build the spawn command for the daemon. A built entry (`.mjs`/`.js`) runs
 * directly under node; a TypeScript entry (the tsx live launcher) is run via
 * node's tsx loader from the repo whose node_modules has tsx, so it actually
 * starts regardless of which project the daemon operates on.
 */
function buildServeArgs(execPath: string, scriptPath: string, cwd: string, extra: string[]): SpawnPlan {
  const serve = ['serve', '--watch', '--cwd', cwd, ...extra];
  if (scriptPath.endsWith('.ts') || scriptPath.endsWith('.tsx')) {
    const root = findTsxRoot(scriptPath);
    return {
      command: execPath,
      args: ['--import', 'tsx', scriptPath, ...serve],
      ...(root ? { cwd: root } : {}),
    };
  }
  return { command: execPath, args: [scriptPath, ...serve] };
}

async function readHeartbeat(heartbeatPath: string): Promise<number | null> {
  try {
    const v = Number(await readFile(heartbeatPath, 'utf8'));
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function waitForDaemon(
  infoPath: string,
  isAlive: (pid: number) => boolean,
  timeoutMs: number,
): Promise<DaemonInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await readDaemonInfo(infoPath);
    if (info && isAlive(info.pid)) return info;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Ensure a daemon is running for `cwd`, returning its {@link DaemonInfo}. Reuses
 * a live one; otherwise spawns `serve --watch` detached, guarded by an exclusive
 * lock so concurrent clients converge on a single daemon.
 */
export async function ensureDaemon(
  cwd: string,
  deps: EnsureDaemonDeps = {},
  opts: EnsureDaemonOptions = {},
): Promise<DaemonInfo> {
  const p = paths(cwd);
  const isAlive = deps.isAlive ?? isDaemonAlive;
  const now = deps.now ?? (() => Date.now());
  const spawnFn = deps.spawn ?? defaultSpawn;
  const execPath = deps.execPath ?? process.execPath;
  const scriptPath = deps.scriptPath ?? process.argv[1] ?? '';

  // Reuse only a daemon whose pid is alive AND that is fresh — a recent
  // heartbeat, or (during startup) a recent startedAt. This guards against a
  // reused OS pid or a wedged daemon masquerading as live.
  const existing = await readDaemonInfo(p.info);
  if (existing && isAlive(existing.pid)) {
    const hb = await readHeartbeat(p.heartbeat);
    const fresh =
      hb != null ? now() - hb < REUSE_WINDOW_MS : now() - existing.startedAt < REUSE_WINDOW_MS;
    if (fresh) return existing;
  }

  await mkdir(p.dir, { recursive: true });

  // Claim the spawn so two clients don't start two daemons on one runs dir.
  // `owned` tracks whether WE hold the lock, so the finally never deletes a
  // peer's lock (which would open a double-spawn window).
  let owned = false;
  try {
    await writeFile(p.lock, String(now()), { flag: 'wx' });
    owned = true;
  } catch {
    // Another client is spawning — wait for its daemon.json; else take over a
    // stale lock left by a spawner that died mid-start.
    const info = await waitForDaemon(p.info, isAlive, 3000);
    if (info) return info;
    await rm(p.lock, { force: true });
    owned = await writeFile(p.lock, String(now()), { flag: 'wx' })
      .then(() => true)
      .catch(() => false);
    if (!owned) {
      const info2 = await waitForDaemon(p.info, isAlive, 3000);
      if (info2) return info2;
    }
  }

  try {
    const plan = buildServeArgs(execPath, scriptPath, cwd, opts.serveArgs ?? []);
    const child = spawnFn(plan.command, plan.args, p.log, plan.cwd);
    const info: DaemonInfo = {
      pid: child.pid ?? -1,
      startedAt: now(),
      version: DAEMON_VERSION,
      cwd,
    };
    await writeDaemonInfo(cwd, info);
    return info;
  } finally {
    if (owned) await rm(p.lock, { force: true });
  }
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  version: string | null;
  heartbeatAt: number | null;
  cwd: string;
}

/** Inspect the project's daemon: is it recorded + alive, and how fresh? */
export async function daemonStatus(
  cwd: string,
  deps: { isAlive?: (pid: number) => boolean } = {},
): Promise<DaemonStatus> {
  const p = paths(cwd);
  const isAlive = deps.isAlive ?? isDaemonAlive;
  const info = await readDaemonInfo(p.info);
  const heartbeatAt = await readHeartbeat(p.heartbeat);
  return {
    running: Boolean(info && isAlive(info.pid)),
    pid: info?.pid ?? null,
    startedAt: info?.startedAt ?? null,
    version: info?.version ?? null,
    heartbeatAt,
    cwd,
  };
}

/** Stop the project's daemon (SIGTERM) and clear its registration files. */
export async function stopDaemon(
  cwd: string,
  deps: { isAlive?: (pid: number) => boolean; kill?: (pid: number, signal: NodeJS.Signals) => void } = {},
): Promise<{ stopped: boolean; pid: number | null }> {
  const p = paths(cwd);
  const isAlive = deps.isAlive ?? isDaemonAlive;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const info = await readDaemonInfo(p.info);
  const alive = Boolean(info && isAlive(info.pid));
  if (info && alive) {
    try {
      kill(info.pid, 'SIGTERM');
    } catch {
      /* exited between the check and the signal */
    }
  }
  // Clear stale registration either way so `status` reflects reality.
  await rm(p.info, { force: true }).catch(() => undefined);
  await rm(p.heartbeat, { force: true }).catch(() => undefined);
  return { stopped: alive, pid: info?.pid ?? null };
}
